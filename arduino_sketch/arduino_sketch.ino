// Wiring: 1: GND  2: VCC (5V)  3: SDA (A4)  4: SCL (A5)
//
// MCP23017: 0x20 → 扉1-8 (GPA0-7 = ロック1-8), 0x24 → 扉9-12 (GPA0-3 = ロック9-12)
// GPA(出): ロック制御  GPB(入): 磁気センサー(端子逆のため各チップ内で逆順対応)
// 0x20: ロック1↔GPB7 ... ロック8↔GPB0  0x24: ロック9↔GPB7 ... ロック12↔GPB4
// ※ 0x24側(扉9〜12)は実配線未確認。設置時に'r'コマンドで全扉を実測すること。
// 磁気センサー(内部プルアップ): 未接触(開)=HIGH(1), 接触(閉)=LOW(0)
//
// server.js コマンドプロトコル:
//   'o'   → 全解錠 /  'oN'  → N番解錠(1-12)   応答: "ok:C\n"
//   's'   → 開閉状態取得                       応答: "open:C\n" or "closed:C\n"
//   'd'   → 全扉JSON取得                       応答: JSON:C\n
//   'u'   → 扉別解錠通電時間(ms)設定           応答: "ok:C\n" or "err:C\n"
//   チェックサム:C = 改行除く各文字のASCII合計 % 16 を16進数1桁
//   応答は必ず1行(\n終端)。余分な行を出力しないこと。
//
// デバッグコマンド(9600 baud): '1'-'12'=手動解錠, 'o1'-'o12'=同上, 's'=状態, 'a'=全詳細, 'r'=GPIOB生表示

#include <Wire.h>

const int NUM_MCP = 2;
const byte MCP_ADDR[NUM_MCP] = {0x20, 0x24}; // [0]=扉1-8用, [1]=扉9-12用

const byte IODIRA = 0x00; // GPA 入出力方向
const byte OLATA = 0x14;  // GPA 出力状態
const byte IODIRB = 0x01; // GPB 入出力方向
const byte GPPUB = 0x0D;  // GPB 内部プルアップ設定
const byte GPIOB = 0x13;  // GPB 入力読み取り

const int NUM_DOORS = 12;

// 1〜8 → MCP_ADDR[0] (0x20), 9〜12 → MCP_ADDR[1] (0x24)
const byte DOOR_MCP_INDEX[NUM_DOORS] = {
    0, 0, 0, 0, 0, 0, 0, 0, // 扉1〜8
    1, 1, 1, 1              // 扉9〜12
};

const byte DOOR_GPA_BIT[NUM_DOORS] = {
    0, 1, 2, 3, 4, 5, 6, 7, // 扉1〜8 → 0x20 の GPA0〜7
    0, 1, 2, 3              // 扉9〜12 → 0x24 の GPA0〜3
};

// 端子が逆のため、各チップ内で逆順対応
// ※ 0x24側(扉9〜12)は実配線未確認のため暫定値。設置前に実測すること。
const byte DOOR_GPB_BIT[NUM_DOORS] = {
    7, 6, 5, 4, 3, 2, 1, 0, // 扉1〜8  → 0x20 の GPB7〜0
    7, 6, 5, 4              // 扉9〜12 → 0x24 の GPB7〜4（暫定）
};

// 扉ごとの解錠通電時間(ms)。既定は全扉1000ms。
// server.js はシリアル接続時と設定変更時に 'u' コマンドでこの配列を上書きする。
// 配線が長い・電磁ロックが古い等で確実に解錠できない扉は、個別に長めに設定できる。
unsigned int doorUnlockMs[NUM_DOORS] = {
    1000, 1000, 1000, 1000, 1000, 1000,
    1000, 1000, 1000, 1000, 1000, 1000};

// MCPごとの通電OFFタイマー。別々のチップに属する扉が連続で解錠されても、
// 互いのタイマーを上書きしない（片方だけが途中で切れる事故を防ぐ）。
unsigned long solenoidOffTime[NUM_MCP] = {0, 0};
bool isSolenoidActive[NUM_MCP] = {false, false};

// ALL_DEVICES の順序と一致させること
const char *DEVICE_IDS[NUM_DOORS] = {
    "CB-01", "CB-02", "CB-03", "CB-04",
    "CB-05", "CB-06", "CB-07", "CB-08",
    "CB-09", "CB-10", "CB-11", "CB-12"};

byte prevSensorState[NUM_MCP] = {0xFF, 0xFF};

bool writeReg(byte addr, byte reg, byte value)
{
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(value);
  return (Wire.endTransmission() == 0);
}

int readReg(byte addr, byte reg)
{
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission() != 0)
    return -1;
  Wire.requestFrom((uint8_t)addr, (uint8_t)1);
  if (Wire.available())
    return Wire.read();
  return -1;
}

bool readAllSensors(int outStates[NUM_MCP])
{
  bool allOk = true;
  for (int i = 0; i < NUM_MCP; i++)
  {
    int raw = readReg(MCP_ADDR[i], GPIOB);
    outStates[i] = raw;
    if (raw < 0)
      allOk = false;
  }
  return allOk;
}

// 読み取り失敗時は安全側でtrue(開)扱い
bool isDoorOpen(int doorNum, int sensorStates[NUM_MCP])
{
  int mcpIdx = DOOR_MCP_INDEX[doorNum - 1];
  int raw = sensorStates[mcpIdx];
  if (raw < 0)
    return true;
  int bit = DOOR_GPB_BIT[doorNum - 1];
  return ((byte)raw >> bit) & 0x01;
}

void printAllSensorStatus()
{
  int sensorStates[NUM_MCP];
  readAllSensors(sensorStates);

  Serial.println(F("--- センサー状態 ---"));
  for (int doorNum = 1; doorNum <= NUM_DOORS; doorNum++)
  {
    int mcpIdx = DOOR_MCP_INDEX[doorNum - 1];
    int bit = DOOR_GPB_BIT[doorNum - 1];
    Serial.print(F("  ロック"));
    Serial.print(doorNum);
    Serial.print(F(" (0x"));
    Serial.print(MCP_ADDR[mcpIdx], HEX);
    Serial.print(F(" GPB"));
    Serial.print(bit);
    Serial.print(F("): "));
    if (sensorStates[mcpIdx] < 0)
    {
      Serial.println(F("状態不明 (GPIO読み取り失敗)"));
    }
    else
    {
      const bool isOpen = isDoorOpen(doorNum, sensorStates);
      Serial.println(isOpen ? F("open  (扉 開)") : F("closed (扉 閉)"));
    }
  }
  Serial.println(F("--------------------"));
}

bool startUnlockSolenoid(int doorNum)
{
  if (doorNum < 1 || doorNum > NUM_DOORS)
    return false;
  int mcpIdx = DOOR_MCP_INDEX[doorNum - 1];
  if (isSolenoidActive[mcpIdx])
    return false;
  int gpaBit = DOOR_GPA_BIT[doorNum - 1];
  byte data = (byte)(1 << gpaBit);
  solenoidOffTime[mcpIdx] = millis() + doorUnlockMs[doorNum - 1];
  isSolenoidActive[mcpIdx] = true;
  if (writeReg(MCP_ADDR[mcpIdx], OLATA, data))
    return true;

  // 書き込み結果が不確かな場合も、次のloopで出力を安全側に戻す。
  solenoidOffTime[mcpIdx] = millis();
  return false;
}

void updateSolenoid()
{
  unsigned long now = millis();
  for (int i = 0; i < NUM_MCP; i++)
  {
    if (isSolenoidActive[i] && (long)(now - solenoidOffTime[i]) >= 0)
    {
      if (writeReg(MCP_ADDR[i], OLATA, 0x00))
      {
        isSolenoidActive[i] = false;
      }
    }
  }
}

String getDoorStatus()
{
  int sensorStates[NUM_MCP];
  bool allOk = readAllSensors(sensorStates);
  if (!allOk)
  {
    // 読み取り失敗 → エラーを "open" として安全側に倒す
    return "open";
  }
  for (int doorNum = 1; doorNum <= NUM_DOORS; doorNum++)
  {
    if (isDoorOpen(doorNum, sensorStates))
      return "open";
  }
  return "closed";
}

// 例: {"doors":{"CB-01":"closed",...,"CB-12":"open"}}
String buildAllDoorStatusJSON()
{
  int sensorStates[NUM_MCP];
  bool allOk = readAllSensors(sensorStates);

  String jsonMsg = F("{\"doors\":{");
  for (int doorNum = 1; doorNum <= NUM_DOORS; doorNum++)
  {
    bool isOpen = allOk ? isDoorOpen(doorNum, sensorStates) : true; // 失敗時は開扱い
    jsonMsg += F("\"");
    jsonMsg += DEVICE_IDS[doorNum - 1];
    jsonMsg += F("\":\"");
    jsonMsg += (isOpen ? "open" : "closed");
    jsonMsg += F("\"");
    if (doorNum < NUM_DOORS)
      jsonMsg += F(",");
  }
  jsonMsg += F("}}");
  return jsonMsg;
}

// 配線確認のため、DOOR_GPB_BIT[] の仮定に依存せず生の値を見る
void printRawGPIOB()
{
  Serial.println(F("--- GPIOB 生データ（配線確認用） ---"));
  for (int i = 0; i < NUM_MCP; i++)
  {
    int raw = readReg(MCP_ADDR[i], GPIOB);
    Serial.print(F("  0x"));
    Serial.print(MCP_ADDR[i], HEX);
    Serial.print(F(" GPIOB = "));
    if (raw < 0)
    {
      Serial.println(F("[読み取り失敗]"));
      continue;
    }
    for (int b = 7; b >= 0; b--)
    {
      Serial.print((raw >> b) & 0x01);
      if (b == 4)
        Serial.print(' ');
    }
    Serial.print(F("  (bit7..bit0, 1=開/HIGH 0=閉/LOW)"));
    Serial.println();
  }
  Serial.println(F("--------------------------------------"));
  Serial.println(F("使い方: 1つの扉だけを開閉して、どのビットが変化するか確認してください。"));
}

bool isAllDigits(String s)
{
  if (s.length() == 0)
    return false;
  for (unsigned int i = 0; i < s.length(); i++)
  {
    if (!isDigit(s[i]))
      return false;
  }
  return true;
}

void sendWithChecksum(String msg)
{
  uint32_t sum = 0;
  for (int i = 0; i < msg.length(); i++)
  {
    sum += (byte)msg[i];
  }
  char checksum = "0123456789ABCDEF"[sum % 16];
  Serial.print(msg);
  Serial.print(':');
  Serial.println(checksum);
}

// 'u' コマンド: 扉ごとの解錠通電時間(ms)を設定する
// 形式: u<ms1>,<ms2>,...,<ms12>  例: u1000,1000,1500,...
// 有効範囲は100〜15000ms。server.js側でもクランプ済みだがArduino側でも防御する。
bool applyUnlockDurations(String body)
{
  unsigned long values[NUM_DOORS];
  int idx = 0;
  int pos = 0;
  while (idx < NUM_DOORS)
  {
    int comma = body.indexOf(',', pos);
    String part = (comma == -1) ? body.substring(pos) : body.substring(pos, comma);
    part.trim();
    if (part.length() == 0 || !isAllDigits(part))
      return false;
    unsigned long v = strtoul(part.c_str(), NULL, 10);
    if (v < 100 || v > 15000)
      return false;
    values[idx++] = v;
    if (comma == -1)
      break;
    pos = comma + 1;
  }
  if (idx != NUM_DOORS)
    return false;
  for (int i = 0; i < NUM_DOORS; i++)
    doorUnlockMs[i] = (unsigned int)values[i];
  return true;
}

void setup()
{
  Serial.begin(9600);
  // シリアル接続を最大 5 秒待つ（Leonardo/Micro 向け）
  unsigned long t0 = millis();
  while (!Serial && (millis() - t0 < 5000))
    ;

  Wire.begin();

  // MCP23017 初期化。接続順などで失敗しても停止せず、3秒ごとに再試行する。
  bool initOk = false;
  while (!initOk)
  {
    initOk = true;
    for (int i = 0; i < NUM_MCP; i++)
    {
      bool chipOk = writeReg(MCP_ADDR[i], OLATA, 0x00);
      if (chipOk)
        chipOk = writeReg(MCP_ADDR[i], IODIRA, 0x00);
      if (chipOk)
        chipOk = writeReg(MCP_ADDR[i], IODIRB, 0xFF);
      if (chipOk)
        chipOk = writeReg(MCP_ADDR[i], GPPUB, 0xFF);
      if (!chipOk)
      {
        Serial.print(F("[ERROR] MCP23017 (0x"));
        Serial.print(MCP_ADDR[i], HEX);
        Serial.println(F(") が応答しません。配線を確認して再試行します。"));
        initOk = false;
      }
    }
    if (!initOk)
    {
      delay(3000);
    }
  }

  int initStates[NUM_MCP];
  bool initReadOk = readAllSensors(initStates);
  if (initReadOk)
  {
    for (int i = 0; i < NUM_MCP; i++)
      prevSensorState[i] = (byte)initStates[i];
  }
  else
  {
    Serial.println(F("[WARN] センサー初回読み取りに失敗しました。"));
  }

  Serial.println(F("========================================"));
  Serial.println(F("  MCP23017 電磁ロック制御 v3 (2チップ/12扉)"));
  Serial.println(F("  server.js プロトコル対応版"));
  Serial.println(F("========================================"));
  if (initReadOk)
  {
    printAllSensorStatus();
  }
  Serial.println(F("[READY] コマンド待機中..."));
  Serial.println(F("  'o'      → 電磁ロック解錠 (server.js)"));
  Serial.println(F("  'oN'     → N番ロック解錠 1〜12 (server.js)"));
  Serial.println(F("  's'      → 扉状態取得    (server.js)"));
  Serial.println(F("  'd'      → 全扉JSON取得  (server.js)"));
  Serial.println(F("  'u'      → 扉別解錠時間設定(server.js)"));
  Serial.println(F("  '1'〜'12'→ 手動解錠      (デバッグ)"));
  Serial.println(F("  'a'      → 全センサー詳細 (デバッグ)"));
  Serial.println(F("  'r'      → GPIOB生データ表示(配線確認用)"));
  Serial.println();
}

void loop()
{
  // シリアルコマンド処理
  if (Serial.available() > 0)
  {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() == 0)
      return;

    // チェックサム検証
    String cmd = line;
    if (line.indexOf(':') != -1)
    {
      int sepIdx = line.lastIndexOf(':');
      cmd = line.substring(0, sepIdx);
      String checksumStr = line.substring(sepIdx + 1);

      uint32_t sum = 0;
      for (int i = 0; i < cmd.length(); i++)
        sum += (byte)cmd[i];
      char expected = "0123456789ABCDEF"[sum % 16];

      char received = toupper(checksumStr[0]);
      if (checksumStr.length() == 0 || received != expected)
      {
        return;
      }
    }

    char c = cmd[0];

    // 'o': 電磁ロック解錠（server.js から呼ばれる）
    // 特定のロック（o1〜o12）または「閉まっている最初の扉」（o）を解錠する。
    if (c == 'o' || c == 'O')
    {
      int targetLock = -1;
      const bool hasExplicitTarget = cmd.length() > 1;
      if (cmd.length() > 1)
      {
        String numPart = cmd.substring(1);
        bool isNumeric = true;
        for (int i = 0; i < numPart.length(); i++)
        {
          if (!isDigit(numPart[i]))
          {
            isNumeric = false;
            break;
          }
        }
        if (isNumeric && numPart.length() > 0)
        {
          int n = numPart.toInt();
          if (n >= 1 && n <= NUM_DOORS)
            targetLock = n;
        }
      }

      // 番号指定がなかった場合（旧方式互換）、閉まっている扉を探す
      if (!hasExplicitTarget)
      {
        int sensorStates[NUM_MCP];
        bool allOk = readAllSensors(sensorStates);
        if (allOk)
        {
          for (int doorNum = 1; doorNum <= NUM_DOORS; doorNum++)
          {
            if (!isDoorOpen(doorNum, sensorStates))
            { // 閉まっている
              targetLock = doorNum;
              break;
            }
          }
        }
      }

      const bool unlocked = targetLock >= 1 && targetLock <= NUM_DOORS && startUnlockSolenoid(targetLock);
      sendWithChecksum(unlocked ? F("ok") : F("err"));
    }

    // 's': 扉の開閉状態取得（server.js から呼ばれる）
    // "open" または "closed" の 1 行のみを返す（余分な出力禁止）
    else if (c == 's' || c == 'S')
    {
      sendWithChecksum(getDoorStatus());
    }

    // 'd': 全扉の個別状態取得（server.js から呼ばれる）
    // JSON 1行を返す。余分な出力禁止。
    else if (c == 'd' || c == 'D')
    {
      sendWithChecksum(buildAllDoorStatusJSON());
    }

    // 'u': 扉ごとの解錠通電時間(ms)を設定（server.js が接続時と設定変更時に送信）
    else if (c == 'u' || c == 'U')
    {
      sendWithChecksum(applyUnlockDurations(cmd.substring(1)) ? F("ok") : F("err"));
    }

    // '1'-'12': 手動解錠（デバッグ用）
    else if (isAllDigits(cmd) && cmd.length() > 0)
    {
      int lockNum = cmd.toInt();
      if (lockNum >= 1 && lockNum <= NUM_DOORS)
      {
        Serial.print(F("[DEBUG] 手動解錠: ロック"));
        Serial.println(lockNum);
        startUnlockSolenoid(lockNum);
      }
      else
      {
        Serial.print(F("[DEBUG] 無効なロック番号: "));
        Serial.println(cmd);
      }
    }

    // 'a': 全センサー詳細表示（デバッグ用）
    else if (c == 'a' || c == 'A')
    {
      printAllSensorStatus();
    }

    // 'r': GPIOB生データ表示（配線確認用デバッグ）
    else if (c == 'r' || c == 'R')
    {
      printRawGPIOB();
    }
  }

  updateSolenoid();

  // センサー変化の自動検知（リアルタイム通知用）
  // server.js はポーリングに加え、この自発的なログも監視して即座にキャッシュを更新するようにする。
  static unsigned long lastSensorCheck = 0;
  if (millis() - lastSensorCheck >= 10)
  { // 10ms周期でチェック（高速化）
    lastSensorCheck = millis();
    for (int mcpIdx = 0; mcpIdx < NUM_MCP; mcpIdx++)
    {
      int rawState = readReg(MCP_ADDR[mcpIdx], GPIOB);
      if (rawState < 0)
        continue;
      byte currentState = (byte)rawState;
      if (currentState != prevSensorState[mcpIdx])
      {
        byte changed = currentState ^ prevSensorState[mcpIdx];
        for (int doorNum = 1; doorNum <= NUM_DOORS; doorNum++)
        {
          if (DOOR_MCP_INDEX[doorNum - 1] != mcpIdx)
            continue;
          int bit = DOOR_GPB_BIT[doorNum - 1];
          if ((changed >> bit) & 0x01)
          {
            bool isOpen = (currentState >> bit) & 0x01;
            Serial.print(F("[SENSOR] ロック"));
            Serial.print(doorNum);
            Serial.print(F(": "));
            Serial.println(isOpen ? F("open") : F("closed"));
          }
        }
        prevSensorState[mcpIdx] = currentState;
      }
    }
  }
}
