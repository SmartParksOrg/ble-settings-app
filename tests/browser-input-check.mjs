// Browser check for the settings inputs and the one-tap apply flow.
//
// Drives the real pages in headless Chromium over the DevTools protocol with real key, mouse
// and touch events, on a desktop viewport or an emulated phone. It needs no npm packages:
// only Node 22+ (built-in WebSocket) and a Chromium binary. The composer runs as-is; the main
// page is loaded with the v8.0.1 schema and seeded device values, and the apply scenarios talk
// to a fake UART that answers reads through the app's own notification handler.
//
//   python3 -m http.server 8765 --bind 127.0.0.1 &
//   CHROME=/path/to/chrome node tests/browser-input-check.mjs http://127.0.0.1:8765
//   CHROME=/path/to/chrome node tests/browser-input-check.mjs http://127.0.0.1:8765 mobile
//
// CHROME defaults to the Playwright Chromium under ~/.cache/ms-playwright. ONLY=index or
// ONLY=composer limits the run to one page; VERBOSE=1 prints where a failed tap landed.
// Screenshots of the outcome dialog are written to the current directory. Exit code 1 = a
// check failed.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2];
const mobile = process.argv[3] === 'mobile';
const chrome = process.env.CHROME || join(process.env.HOME, '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const port = 9333 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu',
  `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const die = (code) => { try { proc.kill('SIGKILL'); } catch {} process.exit(code); };
setTimeout(() => { console.error('TIMEOUT'); die(2); }, 420000).unref();

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function browserWs() {
  for (let i = 0; i < 100; i += 1) {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(100); }
  }
  throw new Error('chrome did not start');
}
const ws = new WebSocket(await browserWs());
await new Promise(r => { ws.onopen = r; });
let nextId = 1;
const pending = new Map();
const events = [];
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId);
  }
};
function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cmd = (method, params) => send(method, params, sessionId);
await cmd('Page.enable');
await cmd('Runtime.enable');
if (mobile) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cmd('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36' });
} else {
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}
async function evaluate(expression) {
  const { result, exceptionDetails } = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}
async function navigate(path) {
  events.length = 0;
  await cmd('Page.navigate', { url: base + path });
  for (let i = 0; i < 200 && !events.some(e => e.method === 'Page.loadEventFired'); i += 1) await sleep(50);
}
async function waitFor(expression, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await evaluate(`Boolean(${expression})`)) return; await sleep(50); }
  throw new Error(`timed out waiting for ${expression}`);
}
async function key(keyName, code, vk) {
  const common = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}
const keys = {
  backspace: () => key('Backspace', 'Backspace', 8),
  end: () => key('End', 'End', 35),
  type: async text => { for (const ch of text) { await cmd('Input.insertText', { text: ch }); await sleep(10); } },
};
const J = v => JSON.stringify(v);
const panelInput = k => `.panel-field[data-keys~=${J(k)}] input.panel-input`;
const panelToggle = k => `.panel-field[data-keys~=${J(k)}] .panel-toggle input`;
const q = sel => `document.querySelector(${J(sel)})`;

async function shot(name) {
  const { data } = await cmd('Page.captureScreenshot', { format: 'png' });
  const file = join(process.cwd(), `shot-${name}-${mobile ? 'mobile' : 'desktop'}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('screenshot', file);
}
// Focus the way a person does: a tap on mobile, a click on desktop. Returns activeElement === el.
async function focus(sel) {
  await evaluate(`(() => { const el = ${q(sel)}; if (!el) throw new Error('no element ' + ${J(sel)});
    let d = el.closest('details'); while (d) { d.open = true; d = d.parentElement && d.parentElement.closest('details'); }
    for (let a = el.parentElement; a; a = a.parentElement) { if (!a.classList) continue; Array.from(a.classList).filter(c => /collapsed/.test(c)).forEach(c => a.classList.remove(c)); if (a.tagName === 'DETAILS') a.open = true; }
    el.scrollIntoView({ block: 'center' }); })()`);
  const visible = await evaluate(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; })()`);
  if (!visible) console.log('  (not in view before tap:', sel, await evaluate(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return JSON.stringify({ top: r.top, bottom: r.bottom, h: r.height, w: r.width, innerHeight }); })()`), ')');
  await sleep(50);
  const rect = await evaluate(`(() => { const r = ${q(sel)}.getBoundingClientRect(); return { x: r.left + Math.min(r.width - 6, 30), y: r.top + r.height / 2 }; })()`);
  if (mobile) {
    await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y }] });
    await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  }
  await sleep(30);
  const hit = await evaluate(`(() => { const el = document.elementFromPoint(${rect.x}, ${rect.y}); return el ? (el.id || el.className || el.tagName) : null; })()`);
  const ok = await evaluate(`document.activeElement === ${q(sel)}`);
  if (!ok && process.env.VERBOSE) console.log('  (tap on', sel, 'hit', JSON.stringify(hit), 'active:', await evaluate(`document.activeElement.id || document.activeElement.tagName`), ')');
  return ok;
}
const state = (sel, key) => evaluate(`(() => { const el = ${q(sel)}; const row = el.closest('.panel-field');
  const setting = settingsData.settings[${J(key)}]; const hidden = document.getElementById('new-value-' + setting.id);
  const sw = document.querySelector('.panel-field-switch[data-keys~="ublox_send_interval"] input');
  const toggle = row && row.querySelector('.panel-toggle input');
  const unit = row && row.querySelector('select.panel-select');
  return { value: el.value, unit: unit ? unit.value : undefined, disabled: el.disabled, focused: document.activeElement === el, hiddenParent: Boolean(el.closest('.hidden')),
    committed: hidden ? hidden.value : null, reason: row ? row.querySelector('.panel-field-reason').textContent : '', scheduleSwitch: sw ? sw.checked : null,
    toggle: toggle ? toggle.checked : undefined }; })()`);
const blur = sel => evaluate(`${q(sel)}.blur()`).then(() => sleep(80));
const clickIfNot = (sel, wanted = true) => evaluate(`(() => { const el = ${q(sel)}; if (!el) throw new Error('no element ' + ${J(sel)}); if (el.checked !== ${wanted}) el.click(); return el.checked; })()`).then(() => sleep(40));

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail)}`); };

async function loadPage(page) {
  await navigate(page);
  if (page === '/index.html') {
    await waitFor(`typeof loadSettings === 'function' && document.getElementById('panels-list')`);
    const seeded = await evaluate(`loadSettings('settings/settings-v8.0.1.json').then(() => { document.body.classList.add('connected','has-status','has-settings'); displaySettings();
      const errors = []; Object.entries(settingsData.settings).forEach(([k, s]) => { if (s.conversion === 'byte_array') return; try { currentSettingValues.set(String(s.id), normalizeRenderableValue(s.default)); setInputValue(s.id, normalizeRenderableValue(s.default)); } catch (e) { errors.push(k + ': ' + e.message); } });
      document.querySelectorAll('.setting.disabled').forEach(row => row.classList.remove('disabled')); // rows enable once a device value arrived
      mountSettingsPanels(); return errors; })`);
    if (seeded.length) console.log('seeding device values raised errors:', seeded);
  } else {
    await waitFor(`document.getElementById('settings-dropdown') && document.getElementById('settings-dropdown').options.length`);
    await evaluate(`(async () => { const dd = document.getElementById('settings-dropdown');
      const option = Array.from(dd.options).find(o => /v8\\.0\\.1/.test(o.value)); dd.value = option.value; await loadSelectedFile();
      if (!settingsData) throw new Error('schema did not load'); return true; })()`);
  }
  await waitFor(q(panelInput('ublox_send_interval')));
  await clickIfNot('.panel-field-switch[data-keys~="ublox_send_interval"] input'); // Scheduled fixes: On (ensures 300 s)
}
const dayNight = async () => { await evaluate(`(() => { const r = document.querySelector('.panel-field-choice input[value="day-night"]'); if (!r.checked) r.click(); return r.checked; })()`); await sleep(40); };

async function fixInterval(tag) {
  const key = 'ublox_send_interval', sel = panelInput(key);
  const before = await state(sel, key);
  const focused = await focus(sel);
  await keys.end(); await keys.backspace();
  const cleared = await state(sel, key);
  await keys.type('10');
  const typed = await state(sel, key);
  await blur(sel);
  const blurred = await state(sel, key);
  check(`${tag} fix interval starts as 5 minutes and takes focus`, focused && before.value === '5' && before.unit === '60' && before.committed === '300', before);
  check(`${tag} fix interval: backspace keeps it editable, schedule stays on`, cleared.value === '' && !cleared.disabled && cleared.focused && cleared.scheduleSwitch === true && cleared.committed === '300', cleared);
  check(`${tag} fix interval: typing 10 commits 600 s`, typed.value === '10' && typed.committed === '600' && !typed.disabled && typed.scheduleSwitch === true, typed);
  check(`${tag} fix interval: after blur shows 10 minutes`, blurred.value === '10' && blurred.unit === '60' && blurred.committed === '600', blurred);
}
async function nightInterval(tag) {
  const key = 'ublox_send_interval_2', sel = panelInput(key);
  await dayNight();
  await clickIfNot(panelToggle(key));
  const before = await state(sel, key);
  const focused = await focus(sel);
  await keys.end(); await keys.backspace();
  const cleared = await state(sel, key);
  await keys.type('2');
  const typed = await state(sel, key);
  check(`${tag} night interval (0 = off) turns on as 1 hour and takes focus`, focused && before.value === '1' && before.unit === '3600' && before.committed === '3600', before);
  check(`${tag} night interval: backspace does not switch it off`, cleared.value === '' && !cleared.disabled && !cleared.hiddenParent && cleared.focused && cleared.toggle === true && cleared.committed === '3600', cleared);
  check(`${tag} night interval: typing 2 commits 7200 s`, typed.value === '2' && typed.committed === '7200' && typed.toggle === true, typed);
}
async function minSatellites(tag) {
  const key = 'ublox_min_satellites', sel = panelInput(key);
  await clickIfNot(panelToggle(key));
  const before = await state(sel, key);
  const focused = await focus(sel);
  await keys.end(); await keys.backspace();
  const cleared = await state(sel, key);
  await keys.type('4');
  const typed = await state(sel, key);
  check(`${tag} satellite check (number, 0 = off) is on as 3 and takes focus`, (focused || cleared.focused) && before.value === '3' && (before.committed === '3' || before.committed === null), before);
  check(`${tag} satellite check: backspace keeps it on and editable`, cleared.value === '' && !cleared.disabled && !cleared.hiddenParent && cleared.focused && cleared.toggle === true && (cleared.committed === '3' || cleared.committed === null), cleared);
  check(`${tag} satellite check: typing 4 commits 4`, typed.value === '4' && typed.committed === '4', typed);
}
async function coordinate(tag) {
  const key = 'gps_init_lat', sel = panelInput(key);
  const before = await state(sel, key);
  const focused = await focus(sel);
  await evaluate(`${q(sel)}.select()`);
  await keys.backspace();
  const cleared = await state(sel, key);
  await keys.type('-1.5');
  const typed = await state(sel, key);
  await blur(sel);
  const blurred = await state(sel, key);
  check(`${tag} initial latitude: clearing does not commit 0`, focused && cleared.value === '' && cleared.committed === before.committed, { before, cleared });
  check(`${tag} initial latitude: -1.5 commits -15000000 and reformats on blur`, typed.committed === '-15000000' && blurred.value === '-1.5000000', { typed, blurred });
}
async function utcHour(tag) {
  const key = 'ublox_interval1_start', sel = panelInput(key);
  await dayNight();
  const before = await state(sel, key);
  const focused = await focus(sel);
  await evaluate(`${q(sel)}.select()`);
  await keys.backspace();
  const cleared = await state(sel, key);
  await keys.type('25');
  const typed = await state(sel, key);
  await blur(sel);
  const blurred = await state(sel, key);
  check(`${tag} day window start: clearing keeps the hour, 25 clamps to 23 on blur`, focused && !before.disabled && cleared.committed === before.committed && typed.committed === '23' && blurred.value === '23', { before, cleared, typed, blurred });
}
// A fake UART: remembers setting writes and answers single-setting reads with a real port-3
// record through handleNotifications, so apply runs through the app's own decode path.
// Addresses listed in window.__stubborn keep their old value (a mismatch).
const FAKE_DEVICE = `(() => { window.__writes = []; window.__device = new Map(); window.__stubborn = window.__stubborn || new Set();
  rxCharacteristic = { writeValueWithResponse: async buffer => { const bytes = new Uint8Array(buffer); window.__writes.push(Array.from(bytes));
    if (bytes[0] === 0x03) { const addr = (bytes[1] << 8) | bytes[2]; if (!window.__stubborn.has(addr)) { const [, setting] = getById(addr); window.__device.set(addr, bytesToSetting(setting, bytes.slice(4, 4 + bytes[3]))); } }
    if (bytes[0] === 0x20 && bytes[1] === 0xA8) { const addr = (bytes[3] << 8) | bytes[4]; const [key, setting] = getById(addr);
      const value = window.__device.has(addr) ? window.__device.get(addr) : currentSettingValues.get(String(setting.id));
      const record = [0x03, ...encodeProtocolRecord(setting, settingToBytes(key, setting, value))];
      setTimeout(() => handleNotifications({ target: { value: new DataView(new Uint8Array(record).buffer) } }), 20); } } };
  return true; })()`;
const barState = () => evaluate(`({ hidden: document.getElementById('pending-changes-bar').classList.contains('hidden'), text: document.getElementById('pending-changes-text').textContent,
  applying: document.getElementById('pending-changes-bar').classList.contains('applying'), applyDisabled: document.getElementById('pending-changes-apply').disabled,
  reviewLabel: document.getElementById('pending-changes-review').textContent, applyLabel: document.getElementById('pending-changes-apply').textContent,
  draft: settingsDraft.size, dialogHidden: document.getElementById('import-preview-overlay').classList.contains('hidden'), toast: document.getElementById('toast').innerText,
  toastVisible: document.getElementById('toast').style.visibility === 'visible' })`);
async function applyFlow(tag) {
  await evaluate(FAKE_DEVICE);
  const key = 'ublox_send_interval', sel = panelInput(key);
  await focus(sel); await keys.end(); await keys.backspace(); await keys.type('10'); await blur(sel);
  const before = await barState();
  await focus('#pending-changes-apply');
  const seen = new Set(); let after;
  for (let i = 0; i < 300; i += 1) { after = await barState(); seen.add(after.text); if (after.hidden && !after.applying) break; await sleep(10); }
  const device = await evaluate(`({ value: currentSettingValues.get(String(settingsData.settings.ublox_send_interval.id)), writes: window.__writes.map(w => w.slice(0, 2)), listShown: document.getElementById('interval-num-' + settingsData.settings.ublox_send_interval.id).value, panelShown: ${q(sel)}.value })`);
  check(`${tag} apply: one pending change, Apply enabled, Review offered`, !before.hidden && before.draft === 1 && !before.applyDisabled && before.applyLabel === 'Apply' && before.reviewLabel === 'Review' && before.dialogHidden, before);
  check(`${tag} apply: one tap writes, reads back, shows progress in the bar`, [...seen].some(t => /Applying 1 of 1/.test(t)) && device.writes.some(w => w[0] === 3) && device.writes.some(w => w[0] === 0x20 && w[1] === 0xA8), { seen: [...seen], writes: device.writes });
  check(`${tag} apply: success ends with a toast, no dialog, bar gone, device value 600`, after.hidden && after.draft === 0 && after.dialogHidden && after.toastVisible && /1 change confirmed/.test(after.toast) && String(device.value) === '600' && device.listShown === '10' && device.panelShown === '10', { after, device });
}
async function applyMismatch(tag) {
  await evaluate(FAKE_DEVICE);
  await evaluate(`(() => { window.__stubborn.add(parseInt(settingsData.settings.ublox_send_interval_2.id, 16)); return true; })()`);
  await dayNight();
  await clickIfNot(panelToggle('ublox_send_interval_2'));
  const before = await barState();
  await focus('#pending-changes-apply');
  let after;
  for (let i = 0; i < 400; i += 1) { after = await barState(); if (!after.applying && !after.dialogHidden) break; await sleep(10); }
  const dialog = await evaluate(`({ text: document.getElementById('import-preview-progress-text').textContent, tags: Array.from(document.querySelectorAll('#import-preview-rows .import-preview-change-tag')).map(t => t.textContent), closeEnabled: !document.getElementById('import-preview-cancel').disabled, closeLabel: document.getElementById('import-preview-cancel').textContent })`);
  await shot('outcome-dialog');
  await focus('#import-preview-cancel');
  await sleep(50);
  const closed = await barState();
  check(`${tag} apply with a stubborn device: the outcome dialog opens by itself`, before.draft >= 2 && !after.dialogHidden && /not applied/.test(dialog.text) && dialog.tags.includes('device kept old value') && dialog.tags.includes('confirmed') && dialog.closeEnabled, { before, after, dialog });
  check(`${tag} apply with a stubborn device: after Close the kept edit stays pending`, closed.dialogHidden && !closed.hidden && closed.draft === 1 && /1 pending change/.test(closed.text), closed);
}

async function listInterval(tag, page) {
  const id = await evaluate(`settingsData.settings.ublox_send_interval.id`);
  if (page !== '/index.html') await evaluate(`(() => { const s = settingsData.settings.ublox_send_interval; includeSetting(s); setInputValue(s.id, '300'); __onInputChanged(s.id); return true; })()`);
  await evaluate(`(() => { const s = document.getElementById('settings-search'); if (s) { s.value = 'ublox_send_interval'; s.dispatchEvent(new Event('input')); } return true; })()`);
  const sel = `#interval-num-${id}`;
  const read = () => evaluate(`({ shown: ${q(sel)}.value, hidden: document.getElementById('new-value-${id}').value, error: document.getElementById('input-error-${id}').innerText, scheduleSwitch: document.querySelector('.panel-field-switch[data-keys~="ublox_send_interval"] input').checked })`);
  const focused = await focus(sel);
  await keys.end(); await keys.backspace();
  const cleared = await read();
  await keys.type('7');
  const typed = await read();
  check(`${tag} settings list interval: empty field is invalid, not 0`, focused && cleared.hidden === '' && /number/i.test(cleared.error), { focused, ...cleared });
  check(`${tag} settings list interval: typing 7 commits 420 s`, typed.hidden === '420' && typed.scheduleSwitch === true, typed);
}

try {
  for (const page of (process.env.ONLY ? [`/${process.env.ONLY}.html`] : ['/composer.html', '/index.html'])) {
    const tag = `[${page.slice(1, -5)} ${mobile ? 'mobile' : 'desktop'}]`;
    const scenarios = [fixInterval, nightInterval, minSatellites, coordinate, utcHour, listInterval];
    if (page === '/index.html') scenarios.push(applyFlow, applyMismatch);
    for (const scenario of scenarios) {
      await loadPage(page);
      try { await scenario(tag, page); } catch (error) { check(`${tag} ${scenario.name}`, false, { error: error.message }); }
    }
  }
} catch (error) { console.error('ERROR', error.message); die(3); }
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
die(failed ? 1 : 0);
