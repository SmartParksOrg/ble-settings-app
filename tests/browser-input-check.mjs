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
//   CHROME=/path/to/chrome node tests/browser-input-check.mjs http://127.0.0.1:8765 ios
//
// "ios" emulates an iPhone running Bluefy (user agent, touch, no manufacturerData filter
// support, no file downloads) and adds checks for the iOS-only paths: the device picker is
// opened without manufacturer data, exports open the share/copy dialog instead of a download,
// and the Scan card explains the picker. Desktop and mobile also check that exports still
// download through an anchor there. Every run also replays a status frame through the
// notification handler and checks that connecting sets the device time and location by itself.
//
// CHROME defaults to the Playwright Chromium under ~/.cache/ms-playwright. ONLY=index or
// ONLY=composer limits the run to one page; VERBOSE=1 prints where a failed tap landed.
// Screenshots of the outcome dialog are written to the current directory. Exit code 1 = a
// check failed. The LP0 scenario reloads the main page with the 8.1.0 development schema and
// a status that says firmware 8.1, and checks the panel, the card and the job reply.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2];
const ios = process.argv[3] === 'ios';
const mobile = process.argv[3] === 'mobile' || ios;
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
  await cmd('Emulation.setUserAgentOverride', { userAgent: ios
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Bluefy/3.9.3'
    : 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36' });
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

// Connecting must set the collar's time and location without a button press: the first status
// frame of a connection triggers a geolocation lookup and a 0xAF command, the confirmation
// shows a toast and refreshes the status, and the manual button stays in the Actions card.
async function autoLocationTime(tag) {
  await evaluate(FAKE_DEVICE);
  await evaluate(`(() => { window.__geoCalls = 0;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (ok) => { window.__geoCalls += 1; setTimeout(() => ok({ coords: { latitude: 52.5, longitude: 4.25 } }), 20); } } });
    device = { name: 'SP05TEST', gatt: { connected: true } }; autoLoaded = false; lrUpdateMode = false; firmwareV5Mode = false;
    // port 4 status frame: reset, errors, battery, operation, temp, uptime, acc x/y/z, hw 1.8, fw 8.0, hw type 5 + fw type 5, charge, features
    handleNotifications({ target: { value: new DataView(new Uint8Array([4, 0, 0, 0, 0, 100, 0, 128, 3, 128, 128, 128, 0x18, 0x80, 0x55, 0, 0]).buffer) } }); return true; })()`);
  await waitFor(`window.__writes.some(w => w[0] === 0x20 && w[1] === 0xAF)`);
  const sent = await evaluate(`(() => { const w = window.__writes.find(w => w[0] === 0x20 && w[1] === 0xAF); const view = new DataView(new Uint8Array(w.slice(3)).buffer);
    return { geoCalls: window.__geoCalls, length: w[2], lon: view.getInt32(0, true) / 1e7, lat: view.getInt32(4, true) / 1e7, ageSeconds: Math.abs(Date.now() / 1000 - view.getInt32(8, true)), statusRequests: window.__writes.filter(w => w[0] === 0x20 && w[1] === 0xA4).length }; })()`);
  await evaluate(`(() => { handleNotifications({ target: { value: new DataView(new Uint8Array([31, 0xF3, 2, 0xAF, 0x01]).buffer) } }); return true; })()`);
  await sleep(150);
  const after = await evaluate(`({ toast: document.getElementById('toast').innerText, toastVisible: document.getElementById('toast').style.visibility === 'visible',
    statusRequests: window.__writes.filter(w => w[0] === 0x20 && w[1] === 0xA4).length, button: Array.from(document.querySelectorAll('#main-commands button')).map(b => b.textContent).includes('Set location & time'), geoCalls: window.__geoCalls })`);
  await evaluate(`(() => { handleNotifications({ target: { value: new DataView(new Uint8Array([4, 0, 0, 0, 0, 100, 0, 128, 3, 128, 128, 128, 0x18, 0x80, 0x55, 0, 0]).buffer) } }); return true; })()`);
  await sleep(150);
  const again = await evaluate(`({ geoCalls: window.__geoCalls, sets: window.__writes.filter(w => w[0] === 0x20 && w[1] === 0xAF).length })`);
  check(`${tag} connecting sends the phone position and the current time without a button press`, sent.geoCalls === 1 && sent.length === 12 && sent.lat === 52.5 && sent.lon === 4.25 && sent.ageSeconds < 60 && sent.statusRequests === 0, sent);
  check(`${tag} the device's confirmation shows a toast, refreshes the status, and the button stays`, after.toastVisible && /time and location updated/.test(after.toast) && after.statusRequests === 1 && after.button, after);
  check(`${tag} a later status refresh does not send the time and location again`, again.geoCalls === 1 && again.sets === 1, again);
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

// Records how a file would leave the page: anchor downloads are stubbed so nothing is written,
// the device picker is stubbed so Scan can be exercised without Bluetooth.
const SAVE_PROBE = `(() => { window.__downloads = []; window.__pickers = [];
  HTMLAnchorElement.prototype.click = function () { window.__downloads.push({ name: this.download, href: String(this.href).slice(0, 5) }); };
  navigator.bluetooth = { requestDevice: async options => { window.__pickers.push(JSON.parse(JSON.stringify(options)));
    const error = new Error('User cancelled the requestDevice() chooser.'); error.name = 'NotFoundError'; throw error; } };
  return true; })()`;
const dialogState = () => evaluate(`(() => { const o = document.getElementById('save-file-overlay'); if (!o) return { present: false };
  return { present: true, hidden: o.classList.contains('hidden'), title: o.querySelector('#save-file-title').textContent, text: o.querySelector('#save-file-text').textContent,
    contents: o.querySelector('#save-file-contents').value.slice(0, 40), shareHidden: o.querySelector('#save-file-share').classList.contains('hidden') }; })()`);
async function exportPath(tag, page) {
  await evaluate(SAVE_PROBE);
  if (page === '/index.html') {
    await evaluate(`(() => { discardPendingChanges(); return true; })()`); // export refuses while edits are pending
    await evaluate(`exportToJson()`);
  } else {
    await evaluate(`(() => { const s = settingsData.settings.ublox_send_interval; includeSetting(s); setInputValue(s.id, '300'); __onInputChanged(s.id); exportToJson('probe.json'); return true; })()`);
  }
  await sleep(100);
  const downloads = await evaluate(`window.__downloads`);
  const dialog = await dialogState();
  if (ios) {
    check(`${tag} export on iOS opens the save dialog with the JSON, no download`, downloads.length === 0 && dialog.present && !dialog.hidden && /\.json$/.test(dialog.title) && dialog.contents.startsWith('{') && /copy/i.test(dialog.text), { downloads, dialog });
    await focus('#save-file-close');
    const closed = await dialogState();
    check(`${tag} export on iOS: Close hides the dialog`, closed.hidden, closed);
  } else {
    check(`${tag} export downloads a .json through an anchor`, downloads.length === 1 && /\.json$/.test(downloads[0].name) && downloads[0].href === 'blob:' && !(dialog.present && !dialog.hidden), { downloads, dialog });
  }
}
async function scanPicker(tag) {
  await evaluate(SAVE_PROBE);
  // Headless Chromium on Linux has no navigator.bluetooth at load; recompute the note with the stub in place.
  await evaluate(`(() => { initBrowserSupportNote(); document.body.classList.remove('connected'); document.getElementById('device-name-filter').value = ''; return true; })()`);
  await focus('#connect-button');
  await sleep(150);
  await evaluate(`(() => { document.getElementById('device-name-filter').value = 'SP05, SP06'; return true; })()`);
  await focus('#connect-button');
  await sleep(150);
  const pickers = await evaluate(`window.__pickers`);
  const note = await evaluate(`(() => { const n = document.getElementById('browser-support-note'); return { hidden: n.classList.contains('hidden'), info: n.classList.contains('info'), text: n.textContent }; })()`);
  const hasManufacturer = p => Array.isArray(p.filters) && p.filters.some(f => f.manufacturerData);
  if (ios) {
    check(`${tag} Scan on iOS: no name filter opens the picker for all devices, without manufacturer data`, pickers.length === 2 && pickers[0].acceptAllDevices === true && !pickers[0].filters && Array.isArray(pickers[0].optionalServices), pickers);
    check(`${tag} Scan on iOS: name prefixes become plain namePrefix filters`, pickers.length === 2 && !hasManufacturer(pickers[1]) && JSON.stringify(pickers[1].filters) === JSON.stringify([{ namePrefix: 'SP05' }, { namePrefix: 'SP06' }]), pickers);
    check(`${tag} Scan card on iOS explains the picker`, !note.hidden && note.info && /nearby Bluetooth device/.test(note.text), note);
  } else {
    check(`${tag} Scan keeps the manufacturer-data filter`, pickers.length === 2 && hasManufacturer(pickers[0]) && hasManufacturer(pickers[1]) && pickers[1].filters.length === 2 && pickers[1].filters[0].namePrefix === 'SP05', pickers);
    check(`${tag} Scan card shows no browser note with Web Bluetooth present`, note.hidden, note);
  }
}
// The Features card: motion-triggered GPS has its own row that follows the panel switch, and
// schedule starts are shown in local time rather than UTC.
async function featuresCard(tag) {
  const card = () => evaluate(`(() => { renderFeatures(); return Array.from(document.querySelectorAll('#features-list .feature-item')).map(el => ({
    name: el.querySelector('.feature-name').textContent, status: el.querySelector('.feature-status').textContent, enabled: el.classList.contains('enabled'),
    detail: Array.from(el.querySelectorAll('.feature-detail span')).map(sp => sp.textContent) })); })()`);
  const row = (rows, name) => rows.find(r => r.name === name);
  const before = await card();
  await clickIfNot(panelToggle('enable_motion_trig_gps'));
  await sleep(60);
  const motionOn = await card();
  await dayNight();
  const sel = panelInput('ublox_interval1_start');
  await focus(sel); await evaluate(`${q(sel)}.select()`); await keys.backspace(); await keys.type('6'); await blur(sel);
  const local = await card();
  const expectedLocal = await evaluate(`formatLocalTimeValueFromUtcHour(6)`);
  await evaluate(`(() => { const sw = document.querySelector('.panel-field-switch[data-keys~="ublox_send_interval"] input'); if (sw.checked) sw.click(); return true; })()`);
  await sleep(60);
  const scheduleOff = await card();
  check(`${tag} features: motion-triggered GPS row exists and starts disabled`, row(before, 'Motion-triggered GPS') && !row(before, 'Motion-triggered GPS').enabled && row(before, 'Motion-triggered GPS').status === 'Disabled', before);
  check(`${tag} features: the row follows the panel switch and explains the behaviour`, row(motionOn, 'Motion-triggered GPS').enabled && /still|movement/.test(row(motionOn, 'Motion-triggered GPS').detail.join(' ')), row(motionOn, 'Motion-triggered GPS'));
  check(`${tag} features: schedule starts are shown in local time`, row(local, 'Ublox GPS').detail.some(d => d.startsWith(expectedLocal + '-')) && row(local, 'Ublox GPS').detail.some(d => /local time/.test(d)) && !row(local, 'Ublox GPS').detail.some(d => /UTC/.test(d)), { expectedLocal, detail: row(local, 'Ublox GPS').detail });
  check(`${tag} features: with the schedule off the motion row says it has no effect`, row(scheduleOff, 'Motion-triggered GPS').enabled && row(scheduleOff, 'Motion-triggered GPS').detail.some(d => /No effect while scheduled/.test(d)) && !row(scheduleOff, 'Ublox GPS').enabled, row(scheduleOff, 'Motion-triggered GPS'));
}
// The built-in DFU list: newest first, the latest standard release in a "Recommended" group at
// the top, AirQ builds in their own group at the bottom, and a hint when both are present.
async function dfuList(tag) {
  const read = () => evaluate(`(() => { const sel = document.getElementById('dfu-bundled-select');
    return { placeholder: sel.options[0].textContent, groups: Array.from(sel.querySelectorAll('optgroup')).map(g => ({ label: g.label, options: Array.from(g.querySelectorAll('option')).map(o => o.textContent) })),
      hint: document.getElementById('dfu-bundled-hint').textContent, hintHidden: document.getElementById('dfu-bundled-hint').classList.contains('hidden') }; })()`);
  const initWith = async info => {
    await evaluate(`(() => { ${info ? `sessionStorage.setItem('dfuDeviceInfo', JSON.stringify(${J(info)}))` : `sessionStorage.removeItem('dfuDeviceInfo')`}; return true; })()`);
    await evaluate(`loadDfuScriptsIfNeeded().then(() => { DfuApp.init(); return true; })`);
    await waitFor(`document.querySelector('#dfu-bundled-select optgroup')`);
    await sleep(100);
    return read();
  };
  const versionOf = label => label.match(/v(\d+\.\d+\.\d+)/)[1];
  const descending = labels => labels.every((l, i) => i === 0 || versionOf(labels[i - 1]).localeCompare(versionOf(l), undefined, { numeric: true }) >= 0);

  const all = await initWith(null);
  const first = all.groups[0], last = all.groups[all.groups.length - 1];
  check(`${tag} DFU list without a device: Recommended group first, with the latest standard release tagged`, /^Recommended: latest standard firmware v8\.0\.3/.test(first.label) && first.options.length === 15 && first.options.every(o => /^v8\.0\.3 \(latest\) •/.test(o)) && /most collars need v8\.0\.3/.test(all.placeholder), { first, placeholder: all.placeholder });
  check(`${tag} DFU list without a device: older standard releases follow, newest first, migration tagged`, all.groups[1].label === 'Older standard firmware' && descending(all.groups[1].options) && all.groups[1].options.some(o => /^v5\.0\.1 \(migration\) •/.test(o)) && !all.groups[1].options.some(o => /latest/.test(o)), all.groups[1]);
  check(`${tag} DFU list without a device: AirQ builds in their own last group, newest first, with a hint`, /^Air quality \(AirQ\) builds/.test(last.label) && descending(last.options) && last.options.every(o => /AirQ/.test(o)) && last.options.filter(o => /\(latest AirQ\)/.test(o)).length === 4 && !all.hintHidden && /AirQ builds only run on rangeredge collars/.test(all.hint), { last, hint: all.hint });

  const ranger = await initWith({ deviceName: 'SP051307', fwVersion: '8.0', hwVersion: '1.8', fwType: 0, hwType: 5, updatedAt: Date.now() });
  check(`${tag} DFU list for a rangeredge 1.8 on 8.0: one recommended v8.0.3, older 8.0.1/7.x/6.x, one AirQ per release`, ranger.groups[0].options.length === 1 && /^v8\.0\.3 \(latest\) • rangeredge_nrf52840@1\.8\.0$/.test(ranger.groups[0].options[0]) && ranger.groups[1].options.every(o => /rangeredge_nrf52840@1\.8\.0$/.test(o)) && ranger.groups[2].options.every(o => /\(AirQ\)@1\.8\.0$/.test(o)) && /AirQ/.test(ranger.hint), ranger);

  const collar = await initWith({ deviceName: 'CE0001', fwVersion: '8.0', hwVersion: '1.5', fwType: 0, hwType: 8, updatedAt: Date.now() });
  check(`${tag} DFU list for a collaredge: no AirQ group, hint says most collars need the latest`, collar.groups.length === 2 && !collar.groups.some(g => /AirQ/.test(g.label)) && collar.groups[0].options.length === 1 && /^v8\.0\.3 \(latest\) • collaredge_nrf52840@1\.5\.0$/.test(collar.groups[0].options[0]) && /Most collars need the latest firmware \(v8\.0\.3\)/.test(collar.hint) && !/AirQ/.test(collar.hint), collar);
}
// The MCUboot header of OpenCollar builds says 0.0.0, so the version people see after a DFU
// must come from the file name; a zero header version must never be shown.
async function dfuVersion(tag) {
  await evaluate(`loadDfuScriptsIfNeeded().then(() => true)`);
  const got = await evaluate(`({
    standard: DfuApp.firmwareVersionFromFileName('open-collar-rangeredge_nrf52840-hv1.8.0-v8.0.3.bin'),
    airq: DfuApp.firmwareVersionFromFileName('open-collar-rangeredge_airq_nrf52840-hv1.4.0-v8.0.1.bin'),
    migration: DfuApp.firmwareVersionFromFileName('open-collar-rangeredge_nrf52840-hv1.4.0-v5.0.1.bin'),
    upper: DfuApp.firmwareVersionFromFileName('OPEN-COLLAR-COLLAREDGE_NRF52840-HV1.5.0-V8.0.3.BIN'),
    suffixed: DfuApp.firmwareVersionFromFileName('open-collar-rangeredge_nrf52840-hv1.8.0-v8.0.1-debug.bin'),
    plain: DfuApp.firmwareVersionFromFileName('firmware.bin'),
    empty: DfuApp.firmwareVersionFromFileName(''),
    zero: DfuApp.meaningfulVersion('0.0.0'),
    zeroShort: DfuApp.meaningfulVersion('0.0'),
    real: DfuApp.meaningfulVersion('8.0.3'),
    missing: DfuApp.meaningfulVersion(null),
  })`);
  check(`${tag} DFU version: the file name yields the release version for every bundled naming shape`,
    got.standard === '8.0.3' && got.airq === '8.0.1' && got.migration === '5.0.1' && got.upper === '8.0.3' && got.suffixed === '8.0.1' && got.plain === null && got.empty === null, got);
  check(`${tag} DFU version: a 0.0.0 header version counts as unknown, a real one is kept`,
    got.zero === null && got.zeroShort === null && got.real === '8.0.3' && got.missing === null, got);
}
// LP0 offload (beta): only on 8.1 development firmware. The panel edits single bytes of the
// node parameters through the shared hidden input, Generate fills a random master key, the
// card sends the start command and renders the device's job reply, and nothing of this is
// shown with the 8.0.1 schema or an 8.0 status.
async function lp0Offload(tag) {
  const before = await evaluate(`({ panel: Boolean(document.getElementById('panel-lp0')), card: !document.getElementById('lp0-area').classList.contains('hidden'),
    feature: Array.from(document.querySelectorAll('#features-list .feature-name')).map(n => n.textContent).includes('LP0 offload') })`);
  check(`${tag} LP0: nothing offered on the 8.0.1 schema`, !before.panel && !before.card && !before.feature, before);
  // Reload with the 8.1.0 schema and an 8.1 status, as a connected 8.1 collar would give.
  const seeded = await evaluate(`loadSettings('settings/settings-v8.1.0.json').then(() => { lastStatusInfo = { ver_fw_major: 8, ver_fw_minor: 1, fwVersion: '8.1', hwVersion: '1.8', fwType: 0, hwType: 5 };
    displaySettings(); const errors = [];
    Object.entries(settingsData.settings).forEach(([k, s]) => { try { const v = s.conversion === 'byte_array' ? stripBytes(normalizeRenderableValue(s.default)) : normalizeRenderableValue(s.default); currentSettingValues.set(String(s.id), v); setInputValue(s.id, v); } catch (e) { errors.push(k + ': ' + e.message); } });
    document.querySelectorAll('.setting.disabled').forEach(row => row.classList.remove('disabled'));
    settingsDraft.reset(); mountSettingsPanels(); renderLp0Section(); renderFeatures(); return errors; })`);
  if (seeded.length) console.log('seeding 8.1.0 values raised errors:', seeded);
  const shown = await evaluate(`({ panel: Boolean(document.getElementById('panel-lp0')), beta: Boolean(document.querySelector('#panel-lp0 .panel-beta-tag')), card: !document.getElementById('lp0-area').classList.contains('hidden'),
    summary: document.querySelector('#panel-lp0 .panel-summary').textContent, feature: Array.from(document.querySelectorAll('#features-list .feature-item')).map(n => n.querySelector('.feature-name').textContent + ':' + n.querySelector('.feature-status').textContent).find(t => /LP0/.test(t)),
    ports: Array.from(document.getElementById('lp0-offload-port').options).map(o => o.textContent) })`);
  check(`${tag} LP0: panel with beta tag, card, Features row and port list appear on 8.1`, shown.panel && shown.beta && shown.card && /^Offloading off\. Cluster master key is the all-zero default\.$/.test(shown.summary) && shown.feature === 'LP0 offload:Disabled' && shown.ports[0] === 'all message types' && shown.ports.some(p => /LP0 station statistics \(port 23\)/.test(p)), shown);

  const role = '#panel-lp0 .panel-field[data-keys~="lp0_node_params"][data-byte="0"] select';
  const stationId = '#panel-lp0 .panel-field[data-keys~="lp0_node_params"][data-byte="1"] input';
  const hidden = `document.getElementById('new-value-' + settingsData.settings.lp0_node_params.id).value`;
  const start = await evaluate(`({ role: ${q(role)}.value, hidden: ${hidden}, idDisabled: ${q(stationId)}.disabled, reason: ${q(stationId)}.closest('.panel-field').querySelector('.panel-field-reason').textContent })`);
  check(`${tag} LP0: role reads byte 0, station ID is greyed out with a reason while off`, start.role === '0' && start.hidden === '00000A013C' && start.idDisabled && /offload station/.test(start.reason), start);
  await evaluate(`(() => { const s = ${q(role)}; s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(60);
  const station = await evaluate(`({ hidden: ${hidden}, idDisabled: ${q(stationId)}.disabled, draft: settingsDraft.size, summary: document.querySelector('#panel-lp0 .panel-summary').textContent,
    feature: Array.from(document.querySelectorAll('#features-list .feature-item')).map(n => n.querySelector('.feature-name').textContent + ':' + n.querySelector('.feature-status').textContent + ':' + (n.querySelector('.feature-detail') || {}).textContent).find(t => /LP0/.test(t)) })`);
  check(`${tag} LP0: choosing the station role writes byte 0 only, enables the station ID, updates summary and Features`, station.hidden === '02000A013C' && !station.idDisabled && station.draft === 1 && /^Offload station, ID 0 of 10 slots/.test(station.summary) && station.feature === 'LP0 offload:Enabled:Station, ID 0', station);
  const focused = await focus(stationId);
  await keys.backspace();
  await keys.type('3');
  await sleep(60);
  const typed = await evaluate(`({ hidden: ${hidden}, value: ${q(stationId)}.value })`);
  check(`${tag} LP0: typing a station ID writes byte 1 and keeps the other bytes`, focused && typed.hidden === '02030A013C' && typed.value === '3', typed);
  await blur(stationId);

  const keyInput = '#panel-lp0 .panel-field[data-keys~="lp0_master_key"] input';
  const warned = await evaluate(`${q(keyInput)}.closest('.panel-field').querySelector('.panel-field-warning').textContent`);
  await evaluate(`${q('#panel-lp0 .panel-field[data-keys~="lp0_master_key"] .panel-generate')}.click()`);
  await sleep(60);
  const generated = await evaluate(`({ value: ${q(keyInput)}.value, type: ${q(keyInput)}.type, hidden: document.getElementById('new-value-' + settingsData.settings.lp0_master_key.id).value,
    warning: ${q(keyInput)}.closest('.panel-field').querySelector('.panel-field-warning').textContent, summary: document.querySelector('#panel-lp0 .panel-summary').textContent })`);
  check(`${tag} LP0: Generate fills a random 16-byte master key, shows it and clears the all-zero warning`, /all-zero|All zeros/.test(warned) && /^[0-9A-F]{32}$/.test(generated.value) && generated.type === 'text' && generated.hidden === generated.value && generated.warning === '' && /Cluster master key set/.test(generated.summary), { warned, generated });
  await evaluate(`(() => { window.__copied = null; navigator.clipboard.writeText = text => { window.__copied = text; return Promise.resolve(); }; return true; })()`);
  await evaluate(`${q('#panel-lp0 .panel-field[data-keys~="lp0_master_key"] .panel-copy')}.click()`);
  await sleep(80);
  const copied = await evaluate(`({ copied: window.__copied, toast: document.getElementById('toast').innerText, icon: Boolean(${q('#panel-lp0 .panel-field[data-keys~="lp0_master_key"] .panel-copy .icon.copy')}) })`);
  check(`${tag} LP0: the copy button puts the generated key on the clipboard`, copied.icon && copied.copied === generated.value && /copied/i.test(copied.toast), copied);

  const checks = '#panel-lp0 .panel-field[data-keys~="lp0_signal_checks"][data-byte="3"] input';
  const master = '#panel-lp0 .panel-field[data-keys~="lp0_signal_checks"][data-byte="0"] select';
  const rssiBefore = await evaluate(`({ value: ${q(checks)}.value, disabled: ${q(checks)}.disabled })`);
  await evaluate(`(() => { const s = ${q(master)}; s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(60);
  const rssiAfter = await evaluate(`({ disabled: ${q(checks)}.disabled, hidden: document.getElementById('new-value-' + settingsData.settings.lp0_signal_checks.id).value })`);
  check(`${tag} LP0: the signal-check master switch gates the RSSI threshold (default 100 = -100 dBm)`, rssiBefore.value === '100' && !rssiBefore.disabled && rssiAfter.disabled && rssiAfter.hidden === '000101640114', { rssiBefore, rssiAfter });

  // The card: start sends 20 CF 03 <medium> <selection> <port>; the reply renders the job.
  await evaluate(FAKE_DEVICE);
  await evaluate(`(() => { document.getElementById('lp0-offload-medium').value = '0'; document.getElementById('lp0-offload-selection').value = '2'; document.getElementById('lp0-offload-port').value = '4'; startLp0Offload(); return true; })()`);
  await sleep(120);
  const sent = await evaluate(`({ writes: window.__writes, status: document.getElementById('lp0-job-status').textContent })`);
  check(`${tag} LP0: Start offload sends the start command with medium, selection and port`, sent.writes.some(w => JSON.stringify(w) === JSON.stringify([0x20, 0xCF, 0x03, 0, 2, 4])) && /Waiting for the device/.test(sent.status), sent);
  const reply = [0x20, 0xCF, 17, 7, 0, 0, 0, 3, 0, 2, 4, 1, 0x8D, 0xFF, 0xFF, 0xFF, 42, 0, 0, 0]; // job 7, discovering, LP0, unconfirmed, port 4, 1 attempt, -115, 42 confirmed
  await evaluate(`handleNotifications({ target: { value: new DataView(new Uint8Array(${J(reply)}).buffer) } })`);
  await sleep(80);
  const answered = await evaluate(`({ status: document.getElementById('lp0-job-status').textContent, toast: document.getElementById('toast').innerText, state: document.querySelector('#lp0-job-status .lp0-job-state').textContent })`);
  check(`${tag} LP0: the device's job reply is decoded into the card`, /Start answered: discovering/.test(answered.state) && /in progress/.test(answered.status) && /Job 7/.test(answered.status) && /unconfirmed records over LP0/.test(answered.status) && /port 4/.test(answered.status) && /42 records confirmed saved/.test(answered.status) && /Offload job 7 discovering/.test(answered.toast), answered);
  await evaluate(`(() => { document.getElementById('lp0-delete-selector').value = '8'; requestLp0DeleteConfirmed(); return true; })()`);
  const overlay = await evaluate(`({ hidden: document.getElementById('lp0-delete-confirm-overlay').classList.contains('hidden'), text: document.getElementById('lp0-delete-confirm-text').textContent })`);
  await evaluate(`lp0DeleteConfirmed()`);
  await sleep(80);
  const deleted = await evaluate(`({ writes: window.__writes, hidden: document.getElementById('lp0-delete-confirm-overlay').classList.contains('hidden') })`);
  check(`${tag} LP0: deleting confirmed logs asks first, then sends D2 01 08`, !overlay.hidden && /LP0 offload station/.test(overlay.text) && deleted.hidden && deleted.writes.some(w => JSON.stringify(w) === JSON.stringify([0x20, 0xD2, 0x01, 8])), { overlay, deleted });

  // Statistics report (port 23, id 0x9D) in the Logs card: a replayed flash record decodes.
  const body = new Array(102).fill(0); body[0] = 3; body[1] = 0x63; body[3] = 0xFF; body[4] = 0x1F; body[5] = 0x10; body[6] = 0x0E; body[13 + 6 * 4] = 12; body[13 + 9 * 4] = 0xE8; body[13 + 9 * 4 + 1] = 0x03; body[97] = 0x9C; body[98] = 0x1D; body[101] = 93;
  const frame = [29, 23, 0x9D, 102, ...body, 0, 0, 0, 0];
  await evaluate(`(() => { recentLogState.active = true; recentLogState.port = 23; recentLogState.label = 'lp0 statistics'; recentLogState.records = []; recentLogState.requestedCount = 10; recentLogState.flashBuffer = null;
    tryHandleRecentLogResponse(new Uint8Array(${J(frame)})); finishRecentLogRequest(); return true; })()`);
  const logRow = await evaluate(`({ details: document.querySelector('#recent-log-results .recent-log-details') ? document.querySelector('#recent-log-results .recent-log-details').textContent : '', items: document.querySelectorAll('#recent-log-results .recent-log-list li').length })`);
  check(`${tag} LP0: a stored station statistics report is summarised and expandable in the Logs card`, /Station statistics v3; up 1 hour/.test(logRow.details) && /sd card detected, sd card writable/.test(logRow.details) && /12 data packets saved \(1000 bytes\)/.test(logRow.details) && /SD 7580 MB, 93% free/.test(logRow.details) && logRow.items === 13 + 1 + 21, logRow);

  // An 8.0 status with the 8.1.0 schema loaded by hand: no panel, no card.
  const older = await evaluate(`(() => { lastStatusInfo = { ver_fw_major: 8, ver_fw_minor: 0 }; mountSettingsPanels(); renderLp0Section(); renderFeatures();
    return { panel: Boolean(document.getElementById('panel-lp0')), card: !document.getElementById('lp0-area').classList.contains('hidden'), feature: Array.from(document.querySelectorAll('#features-list .feature-name')).map(n => n.textContent).includes('LP0 offload') }; })()`);
  check(`${tag} LP0: an 8.0 collar with the 8.1.0 schema picked by hand still gets no LP0 panel or card`, !older.panel && !older.card && !older.feature, older);
}
async function noBluetoothNote(tag) {
  await evaluate(`(() => { delete navigator.bluetooth; Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true }); initBrowserSupportNote(); return true; })()`);
  const note = await evaluate(`(() => { const n = document.getElementById('browser-support-note'); return { hidden: n.classList.contains('hidden'), text: n.textContent, link: n.querySelector('a') ? n.querySelector('a').href : null }; })()`);
  const toastBefore = await evaluate(`document.getElementById('toast').innerText`);
  await evaluate(`(() => { document.body.classList.remove('connected'); return true; })()`);
  await focus('#connect-button');
  await sleep(100);
  const toast = await evaluate(`document.getElementById('toast').innerText`);
  if (ios) check(`${tag} without Web Bluetooth on iOS the note links to Bluefy`, !note.hidden && /Bluefy/.test(note.text) && /apps\.apple\.com/.test(note.link || ''), note);
  else check(`${tag} without Web Bluetooth the note names Chrome, Edge and Bluefy`, !note.hidden && /Chrome or Edge/.test(note.text) && /Bluefy/.test(note.text), note);
  check(`${tag} Scan without Web Bluetooth shows a toast instead of throwing`, /not available/.test(toast) && toast !== toastBefore, { toast });
}

try {
  for (const page of (process.env.ONLY ? [`/${process.env.ONLY}.html`] : ['/composer.html', '/index.html'])) {
    const tag = `[${page.slice(1, -5)} ${ios ? 'ios' : mobile ? 'mobile' : 'desktop'}]`;
    const scenarios = [fixInterval, nightInterval, minSatellites, coordinate, utcHour, listInterval, exportPath];
    if (page === '/index.html') scenarios.push(applyFlow, applyMismatch, autoLocationTime, scanPicker, noBluetoothNote, featuresCard, dfuList, dfuVersion, lp0Offload);
    for (const scenario of scenarios) {
      await loadPage(page);
      try { await scenario(tag, page); } catch (error) { check(`${tag} ${scenario.name}`, false, { error: error.message }); }
    }
  }
} catch (error) { console.error('ERROR', error.message); die(3); }
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed (${ios ? 'ios' : mobile ? 'mobile' : 'desktop'})`);
die(failed ? 1 : 0);
