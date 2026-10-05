'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const localSource = fs.readFileSync(path.join(root, 'local-db', 'lending.js'), 'utf8');
const gasSource = fs.readFileSync(path.join(root, 'gas', 'Code.gs'), 'utf8');
const remoteSettingsSource = fs.readFileSync(path.join(root, 'local-db', 'remote_settings.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'js', 'ui.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'js', 'admin.js'), 'utf8');
const remoteConsoleHtml = fs.readFileSync(path.join(root, 'usb', 'remote-settings.html'), 'utf8');

function extractFunction(source, name) {
  const match = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(source);
  assert.ok(match, `${name} が見つかりません`);
  const end = source.indexOf('\n}', match.index);
  assert.notEqual(end, -1, `${name} の終端が見つかりません`);
  return source.slice(match.index, end + 2);
}

function createLocalContext(settings) {
  const context = {
    Date,
    DEFAULT_SETTINGS: {},
    getSettings: () => ({ settings }),
  };
  const functions = ['_localDateString', '_isValidDateOnly', '_isLendingSuspensionActive', '_modeBlockMessage']
    .map(name => extractFunction(localSource, name))
    .join('\n');
  vm.runInNewContext(`${functions}\nglobalThis.checkActive = _isLendingSuspensionActive;\nglobalThis.blockMessage = _modeBlockMessage;`, context);
  return context;
}

function createGasContext(settings, today) {
  const context = {
    Date,
    DEFAULT_SETTINGS: {},
    getRemoteSettings: () => ({ settings }),
    Session: { getScriptTimeZone: () => 'Etc/GMT' },
    Utilities: { formatDate: () => today },
  };
  const functions = ['_rsValidDateOnly', '_rsSuspensionActive', '_modeBlockMessage']
    .map(name => extractFunction(gasSource, name))
    .join('\n');
  vm.runInNewContext(`${functions}\nglobalThis.checkActive = _rsSuspensionActive;\nglobalThis.blockMessage = _modeBlockMessage;`, context);
  return context;
}

test('指定日を含めて貸出休止し、翌日から自動解除する', () => {
  const settings = { lendingSuspended: true, lendingSuspendedUntil: '2026-10-10' };
  const local = createLocalContext(settings);
  assert.equal(local.checkActive(settings, new Date(2026, 9, 10, 12)), true);
  assert.equal(local.checkActive(settings, new Date(2026, 9, 11, 0)), false);

  const gas = createGasContext(settings, '2026-10-10');
  assert.equal(gas.checkActive(settings), true);
  const nextDayGas = createGasContext(settings, '2026-10-11');
  assert.equal(nextDayGas.checkActive(settings), false);

  const studentContext = {};
  const studentFunctions = ['_studentDateString', '_isLendingSuspensionActive', '_formatSuspensionEndDate']
    .map(name => extractFunction(appSource, name))
    .join('\n');
  vm.runInNewContext(studentFunctions + '\nglobalThis.active = _isLendingSuspensionActive;\nglobalThis.formatDate = _formatSuspensionEndDate;', studentContext);
  assert.equal(studentContext.active(settings, new Date(2026, 9, 10, 12)), true);
  assert.equal(studentContext.active(settings, new Date(2026, 9, 11, 0)), false);
  assert.equal(studentContext.formatDate('2026-10-10'), '2026年10月10日');
  const unlimitedSettings = { lendingSuspended: true, lendingSuspendedUntil: '' };
  assert.equal(studentContext.active(unlimitedSettings, new Date(2026, 9, 11, 0)), true);
  assert.equal(studentContext.formatDate(''), '');
});

test('GASと教室PCのリモート設定スキーマが一致し、休止終了日を date として扱う', () => {
  const gasMatch = /^const RS_SCHEMA = \{[\s\S]*?^\};/m.exec(gasSource);
  const nodeMatch = /^const REMOTE_SCHEMA = \{[\s\S]*?^\};/m.exec(remoteSettingsSource);
  assert.ok(gasMatch, 'GAS側のRS_SCHEMAが見つかりません');
  assert.ok(nodeMatch, 'Node側のREMOTE_SCHEMAが見つかりません');
  const context = {};
  vm.runInNewContext(`${gasMatch[0]}\n${nodeMatch[0]}\nglobalThis.schemas = [RS_SCHEMA, REMOTE_SCHEMA];`, context);
  const [gasSchema, nodeSchema] = JSON.parse(JSON.stringify(context.schemas));
  assert.deepEqual(gasSchema, nodeSchema);
  assert.equal(nodeSchema.lendingSuspendedUntil.type, 'date');

  const gasNormalizer = extractFunction(gasSource, '_rsNormalize');
  const nodeDateValidator = extractFunction(remoteSettingsSource, '_isValidRemoteDateOnly');
  const nodeNormalizer = extractFunction(remoteSettingsSource, 'normalizeValue');
  const normalizerContext = {};
  vm.runInNewContext(
    `${gasNormalizer}\n${nodeDateValidator}\n${nodeNormalizer}\nglobalThis.normalizers = [raw => _rsNormalize({ type: 'date' }, raw), raw => normalizeValue({ type: 'date' }, raw)];`,
    normalizerContext
  );
  for (const value of ['2026-12-31', '2026-02-30', '2026/12/31', '', 'unlimited']) {
    const [gasResult, nodeResult] = normalizerContext.normalizers.map(normalize => normalize(value));
    assert.equal(gasResult.ok, nodeResult.ok, value);
    if (gasResult.ok) assert.equal(gasResult.value, nodeResult.value);
  }

  const gasDisplay = extractFunction(gasSource, '_rsDisplay');
  const nodeWireToSetting = extractFunction(remoteSettingsSource, 'toSettingValue');
  const nodeSettingToWire = extractFunction(remoteSettingsSource, 'fromSettingValue');
  const conversionContext = {};
  vm.runInNewContext(
    `${gasDisplay}\n${nodeWireToSetting}\n${nodeSettingToWire}\nglobalThis.gasDisplay = _rsDisplay({ type: 'date' }, 'unlimited');\nglobalThis.toSetting = toSettingValue({ type: 'date' }, 'unlimited');\nglobalThis.fromSetting = fromSettingValue({ type: 'date' }, '');`,
    conversionContext
  );
  assert.equal(conversionContext.gasDisplay, '無期限');
  assert.equal(conversionContext.toSetting, '');
  assert.equal(conversionContext.fromSetting, 'unlimited');
});

test('一時休止中は貸出だけを拒否し、返却は許可する', () => {
  const settings = { lendingSuspended: true, lendingSuspendedUntil: '2026-10-10' };
  const local = createLocalContext(settings);
  const checkoutMessage = local.blockMessage('checkout');
  assert.match(checkoutMessage, /貸出を休止/);
  assert.match(checkoutMessage, /2026年10月10日まで/);
  assert.equal(local.blockMessage('return'), null);

  const gas = createGasContext(settings, '2026-10-10');
  assert.match(gas.blockMessage('checkout'), /貸出を休止/);
  assert.equal(gas.blockMessage('return'), null);

  const unlimited = createLocalContext({ lendingSuspended: true, lendingSuspendedUntil: '' });
  assert.equal(unlimited.blockMessage('checkout').includes('まで'), false);
  assert.equal(unlimited.blockMessage('return'), null);
});

test('メンテナンスは貸出・返却の両方を止め、日付入力の不備は休止を解除しない', () => {
  const maintenance = createLocalContext({ maintenanceMode: true, lendingSuspended: true });
  assert.match(maintenance.blockMessage('checkout'), /メンテナンス/);
  assert.match(maintenance.blockMessage('return'), /メンテナンス/);

  const invalidDate = createLocalContext({ lendingSuspended: true, lendingSuspendedUntil: '2026-02-30' });
  assert.equal(invalidDate.checkActive(
    { lendingSuspended: true, lendingSuspendedUntil: '2026-02-30' },
    new Date(2026, 9, 10, 12)
  ), true);
});

test('管理者・USBコンソールに期限入力があり、貸出休止中も返却カードは操作できる', () => {
  assert.match(adminHtml, /id="set-lending-suspended-until"/);
  assert.match(adminHtml, /空欄は無期限です/);
  assert.match(adminJs, /lendingSuspendedUntil: document\.getElementById\('set-lending-suspended-until'\)\.value/);
  assert.match(remoteConsoleHtml, /id: 'quick-lending-suspended-until'/);
  assert.match(remoteConsoleHtml, /ch\.lendingSuspendedUntil = until/);
  assert.match(remoteConsoleHtml, /type: 'date'/);
  assert.match(uiSource, /const returnDisabled = !canOperate \|\| maint;/);
});
