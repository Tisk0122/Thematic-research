'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'usb', 'make-key.html'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(root, 'usb', 'remote-settings.html'), 'utf8');
const gas = fs.readFileSync(path.join(root, 'gas', 'Code.gs'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const inlineScript = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).pop()[1];
const consoleScript = Array.from(consoleHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)).pop()[1];

function createElement() {
  const classes = new Set();
  const listeners = {};
  const attributes = {};
  const children = [];
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    className: '',
    style: {},
    selected: false,
    handlers: listeners,
    children,
    parentNode: null,
    get firstChild() { return children[0] || null; },
    appendChild(child) { children.push(child); child.parentNode = this; return child; },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index !== -1) children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      }
    },
    addEventListener(name, handler) { listeners[name] = handler; },
    setAttribute(name, value) { attributes[name] = value; },
    getAttribute(name) { return attributes[name] || (name === 'data-tab' ? 'issue' : ''); },
    querySelector() { return { textContent: '' }; },
    select() { this.selected = true; },
    focus() {},
    scrollIntoView() {},
    click() {}
  };
}

function createHarness(fetch) {
  const elements = new Map();
  const rootAttributes = {};
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  rootAttributes['data-theme'] = 'dark';
  const buttons = Array.from({ length: 3 }, createElement);
  const panes = Array.from({ length: 3 }, createElement);
  const context = {
    AbortController,
    Blob,
    URL,
    document: {
      documentElement: {
        setAttribute(name, value) { rootAttributes[name] = value; },
        getAttribute(name) { return rootAttributes[name] || ''; }
      },
      activeElement: createElement(),
      contains() { return true; },
      getElementById,
      querySelectorAll(selector) {
        return selector === '.tab-btn' ? buttons : panes;
      },
      createElement,
      createElementNS() { return createElement(); }
    },
    fetch,
    navigator: {},
    localStorage: { setItem() {} },
    window: { addEventListener() {} },
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(inlineScript, context);
  return { elements, getElementById, rootAttributes };
}

test('Make Key page script parses and contains no emoji characters', () => {
  assert.doesNotThrow(() => new vm.Script(inlineScript));
  assert.doesNotThrow(() => new vm.Script(consoleScript));
  assert.doesNotThrow(() => new vm.Script(gas));
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(consoleHtml, /\p{Extended_Pictographic}/u);
});

test('both standalone pages provide persistent light and dark mode controls', () => {
  const harness = createHarness(async () => ({ text: async () => '' }));
  harness.getElementById('theme-toggle').handlers.click();

  assert.equal(harness.rootAttributes['data-theme'], 'light');
  assert.match(html, /id="theme-toggle"/);
  assert.match(consoleHtml, /id="theme-toggle"/);
  assert.match(html, /localStorage\.getItem\('admin-theme'\)/);
  assert.match(consoleHtml, /localStorage\.getItem\('admin-theme'\)/);
  for (const page of [html, consoleHtml]) {
    assert.match(page, /\.theme-toggle svg \{ display: none;/);
    assert.match(page, /#theme-icon-sun \{ display: block;/);
    assert.match(page, /\[data-theme="dark"\] \.theme-toggle #theme-icon-moon \{ display: block;/);
  }
});

test('remote console documents the request lifecycle and renders custom admin-style selects', () => {
  assert.match(consoleHtml, /処理フローとデータの扱い/);
  assert.match(consoleHtml, /設定ファイルをローカルで読込/);
  assert.match(consoleHtml, /GASでキーを照合/);
  assert.match(consoleHtml, /変更依頼を検証・記録/);
  assert.match(consoleHtml, /教室PCが取得して反映/);
  assert.match(consoleScript, /function enhanceAdminSelect\(select\)/);
  assert.match(consoleScript, /role: 'combobox'/);
  assert.match(consoleScript, /role: 'listbox'/);
  assert.match(consoleScript, /event\.key === 'ArrowDown'/);
});

test('remote console refresh controls use a padded, rounded refresh SVG', () => {
  const refreshButton = consoleHtml.match(/<button id="refresh-btn"[\s\S]*?<\/button>/)[0];
  const resetButton = consoleHtml.match(/<button id="reset-btn"[\s\S]*?<\/button>/)[0];
  for (const button of [refreshButton, resetButton]) {
    assert.match(button, /viewBox="0 0 24 24"/);
    assert.match(button, /stroke-linecap="round"/);
    assert.match(button, /stroke-linejoin="round"/);
    assert.match(button, /M20 11a8\.1 8\.1 0 0 0-15\.5-2M4 4v5h5/);
  }
});

test('remote console shows operation progress and records only safe communication metadata', () => {
  assert.match(consoleHtml, /id="operation-overlay"/);
  assert.match(consoleHtml, /id="comm-log-connect"/);
  assert.match(consoleHtml, /id="comm-log-list"/);
  assert.match(consoleScript, /function recordCommunication\(action, status, message, result\)/);
  assert.match(consoleScript, /function call\(action, extra, options\)/);
  assert.match(consoleScript, /recordCommunication\(action, success \? 'ok' : 'error'/);
  assert.match(consoleScript, /silent: !full/);
  assert.doesNotMatch(consoleScript, /recordCommunication\([^)]*(?:conn\.key|extra|body|token)/);
});

test('remote console supports the remaining settings and explains HTTP 404 deployment errors', () => {
  assert.match(consoleScript, /def\.type === 'emailList'/);
  assert.match(consoleScript, /def\.type === 'intList'/);
  assert.match(consoleScript, /def\.type === 'patternList'/);
  assert.match(consoleScript, /設定済み（値は非表示）/);
  assert.match(consoleScript, /GASがHTTP 404を返しました/);
  assert.match(consoleScript, /「新しいバージョン」をデプロイしてください/);
  assert.match(consoleHtml, /id="frame-warning"/);
  assert.match(consoleScript, /window\.self !== window\.top/);
  assert.match(consoleHtml, /<link rel="icon" href="data:,">/);
});

test('online issuance sends the admin token to GAS and clears it after generating the JSON', async () => {
  let request;
  const key = `rsk_${'a'.repeat(64)}`;
  const harness = createHarness(async (url, options) => {
    request = { url, options };
    return {
      text: async () => JSON.stringify({
        success: true,
        connection: { key, label: 'Test User' }
      })
    };
  });
  harness.getElementById('issue-url').value = 'https://script.google.com/macros/s/deployment/exec';
  harness.getElementById('sync-token').value = 'admin-sync-token-value';
  harness.getElementById('issue-label').value = 'Test User';

  harness.getElementById('issue-btn').handlers.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(request.url, 'https://script.google.com/macros/s/deployment/exec');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(request.options.body), {
    action: 'issueRemoteOperatorKey',
    token: 'admin-sync-token-value',
    label: 'Test User'
  });
  assert.equal(harness.getElementById('sync-token').value, '');
  assert.deepEqual(JSON.parse(harness.getElementById('issued-json-output').value), {
    gasUrl: 'https://script.google.com/macros/s/deployment/exec',
    key,
    label: 'Test User'
  });
  assert.equal(harness.getElementById('issued-output-area').classList.contains('visible'), true);
  const activity = harness.getElementById('activity-list').children
    .flatMap((row) => row.children.map((cell) => cell.textContent)).join(' ');
  assert.match(activity, /ISSUE_KEY/);
  assert.match(activity, /応答を受信/);
  assert.doesNotMatch(activity, /admin-sync-token-value|Test User|rsk_/);
});

test('online issuance explains Google login and HTML deployment responses', async () => {
  const harness = createHarness(async () => ({
    url: 'https://accounts.google.com/ServiceLogin',
    status: 200,
    text: async () => '<html><title>Sign in</title></html>'
  }));
  harness.getElementById('issue-url').value = 'https://script.google.com/macros/s/deployment/exec';
  harness.getElementById('sync-token').value = 'admin-sync-token-value';
  harness.getElementById('issue-label').value = 'Test User';

  harness.getElementById('issue-btn').handlers.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(harness.getElementById('issue-status').textContent, /Googleのログイン画面/);
  assert.match(harness.getElementById('issue-status').textContent, /公開範囲を「全員」/);
});

test('online issuance gives deployment guidance for HTTP 404 responses', async () => {
  const harness = createHarness(async () => ({
    status: 404,
    text: async () => '<html>Not found</html>'
  }));
  harness.getElementById('issue-url').value = 'https://script.google.com/macros/s/deployment/exec';
  harness.getElementById('sync-token').value = 'admin-sync-token-value';
  harness.getElementById('issue-label').value = 'Test User';

  harness.getElementById('issue-btn').handlers.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(harness.getElementById('issue-status').textContent, /HTTP 404/);
  assert.match(harness.getElementById('issue-status').textContent, /新しいバージョン/);
});

test('online issuance guides operators to redeploy when the GAS endpoint has no issuance action', async () => {
  const harness = createHarness(async () => ({
    status: 200,
    text: async () => JSON.stringify({
      success: false,
      message: '不明なアクション: issueRemoteOperatorKey'
    })
  }));
  harness.getElementById('issue-url').value = 'https://script.google.com/macros/s/deployment/exec';
  harness.getElementById('sync-token').value = 'admin-sync-token-value';
  harness.getElementById('issue-label').value = 'Test User';

  harness.getElementById('issue-btn').handlers.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(harness.getElementById('issue-status').textContent, /新しいバージョンに再デプロイ/);
});

test('GAS protects the online key-issuance action with normal sync-token authorization', () => {
  assert.match(gas, /case 'issueRemoteOperatorKey': return issueRemoteOperatorKeyApi\(params\);/);
  assert.match(gas, /result = _authorizeRequest\(action, params\) \|\| dispatch\(action, params\);/);
  assert.match(gas, /if \(action === 'issueRemoteOperatorKey'\) \{\s*return createJsonResponse\(\{ success: false, message: 'キー発行はPOSTでのみ受け付けます。' \}\);/);
  assert.match(gas, /function issueRemoteOperatorKeyApi\(params\) \{[\s\S]*?issueRemoteOperatorKey\(params && params\.label, true\)/);
  assert.doesNotMatch(gas.match(/const RS_OPERATOR_ACTIONS = \[[^\]]+\];/)[0], /issueRemoteOperatorKey/);
});

test('GAS doPost rejects invalid sync tokens before dispatching key issuance', () => {
  const dispatch = gas.match(/function dispatch\(action, params\) \{[\s\S]*?\n\}/)[0];
  const doPost = gas.match(/function doPost\(e\) \{[\s\S]*?\n\}/)[0];
  const calls = [];
  const context = {
    RS_OPERATOR_ACTIONS: [],
    createJsonResponse: (result) => result,
    _authorizeRequest: (action, params) => {
      calls.push(['authorize', action, params.token]);
      return params.token === 'valid-admin-token' ? null : { success: false, message: 'unauthorized' };
    },
    issueRemoteOperatorKeyApi: (params) => {
      calls.push(['issue', params.label]);
      return { success: true };
    }
  };
  new vm.Script(`${dispatch}\n${doPost}`).runInNewContext(context);
  const post = (token) => context.doPost({
    postData: {
      type: 'text/plain;charset=utf-8',
      contents: JSON.stringify({ action: 'issueRemoteOperatorKey', token, label: 'Test User' })
    },
    parameter: {}
  });

  assert.deepEqual(JSON.parse(JSON.stringify(post('invalid-token'))), {
    success: false,
    message: 'unauthorized'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(post('valid-admin-token'))), { success: true });
  assert.deepEqual(calls, [
    ['authorize', 'issueRemoteOperatorKey', 'invalid-token'],
    ['authorize', 'issueRemoteOperatorKey', 'valid-admin-token'],
    ['issue', 'Test User']
  ]);
});

test('site serves only the dedicated nested Make Key page', () => {
  const extensionSet = server.match(/const _SERVABLE_STATIC_EXTS = new Set\([^;]+;/)[0];
  const staticPathCheck = server.match(/function _isServableStaticPath\(p\) \{[\s\S]*?\n\}/)[0];
  const isServable = new vm.Script(`${extensionSet}\n${staticPathCheck}\n_isServableStaticPath`)
    .runInNewContext({ path });

  assert.equal(isServable('/usb/make-key.html'), true);
  assert.equal(isServable('/usb/remote-settings.html'), false);
  assert.equal(isServable('/usb/remote-settings-key.json'), false);
});
