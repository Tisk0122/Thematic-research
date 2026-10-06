'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const installer = read('scripts/install.sh');
const desktopSetup = read('scripts/apply-desktop-lockdown.sh');
const kioskStartup = read('scripts/kiosk-autostart.sh');

test('desktop setup leaves panels and recovery shortcuts intact', () => {
  assert.match(desktopSetup, /\*Cinnamon\*|\*cinnamon\*/);
  assert.doesNotMatch(desktopSetup, /gsettings set org\.cinnamon enabled-applets "\[\]"/);
  assert.doesNotMatch(desktopSetup, /disable-command-line true|DontVTSwitch/);
  assert.match(desktopSetup, /gsettings reset org\.cinnamon enabled-applets/);
  assert.match(desktopSetup, /case "\$\{_VALUE\}" in "\[\]"|"@as \[\]"/);
});

test('installer provides Xfce exit shortcut and never installs VT lockdown', () => {
  assert.match(installer, /XFCE\*.*Xfce\*.*xfce\*/s);
  assert.match(installer, /xfconf-query -c xfce4-keyboard-shortcuts/);
  assert.match(installer, /sudo rm -f \/etc\/X11\/xorg\.conf\.d\/50-kiosk-no-vtswitch\.conf/);
  assert.doesNotMatch(installer, /cp '\$\{TPL_DIR\}\/50-kiosk-no-vtswitch\.conf'/);
});

test('kiosk startup does not repeatedly close desktop applications', () => {
  assert.match(kioskStartup, /復旧手段として常に利用できる状態/);
  assert.doesNotMatch(kioskStartup, /pkill -x nemo/);
});
