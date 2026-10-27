const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const engine = require(path.join(root, 'panels/panel-engine.js'));
const definitions = require(path.join(root, 'panels/panel-definitions.js'));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'settings/settings-v8.0.1.json'), 'utf8'));
// Older firmware only: keys a panel may reference that v8 dropped (S-Band credentials).
const legacySchema = JSON.parse(fs.readFileSync(path.join(root, 'settings/settings-v6.15.0.json'), 'utf8'));
// Development firmware: the LP0 offload keys only exist from 8.1 on.
const betaSchema = JSON.parse(fs.readFileSync(path.join(root, 'settings/settings-v8.1.0.json'), 'utf8'));
const inSomeSchema = key => Boolean(schema.settings[key] || legacySchema.settings[key] || betaSchema.settings[key]);
const meta = JSON.parse(fs.readFileSync(path.join(root, 'settings-meta.json'), 'utf8'));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('conditions evaluate against effective values with lenient booleans and numbers', () => {
    const values = { on: 'true', off: '0', n: '60', s: 'abc' };
    const get = key => values[key];
    assert.equal(engine.evaluateCondition({ key: 'on', truthy: true }, get), true);
    assert.equal(engine.evaluateCondition({ key: 'off', truthy: true }, get), false);
    assert.equal(engine.evaluateCondition({ key: 'on', equals: true }, get), true);
    assert.equal(engine.evaluateCondition({ key: 'n', equals: 60 }, get), true);
    assert.equal(engine.evaluateCondition({ key: 'n', gt: 0 }, get), true);
    assert.equal(engine.evaluateCondition({ key: 'n', in: [30, 60] }, get), true);
    assert.equal(engine.evaluateCondition({ key: 's', equals: 'abc' }, get), true);
    assert.equal(engine.evaluateCondition({ all: [{ key: 'on', truthy: true }, { key: 'n', gt: 100 }] }, get), false);
    assert.equal(engine.evaluateCondition({ any: [{ key: 'on', truthy: false }, { key: 'n', gte: 60 }] }, get), true);
    assert.equal(engine.evaluateCondition({ not: { key: 'off', truthy: true } }, get), true);
    assert.equal(engine.evaluateCondition(null, get), true);
    assert.deepEqual([...engine.conditionKeys({ all: [{ key: 'a' }, { any: [{ key: 'b' }, { not: { key: 'c' } }] }] })], ['a', 'b', 'c']);
});

test('write order puts dependents before a switch that turns on and after one that turns off', () => {
    const on = engine.planWriteOrder([
        { key: 'ublox_multiple_intervals', value: 'true' },
        { key: 'ublox_send_interval_2', value: '3600' },
        { key: 'ublox_interval1_start', value: '7' },
        { key: 'ublox_interval2_start', value: '18' },
    ], definitions);
    assert.equal(on[on.length - 1].key, 'ublox_multiple_intervals');
    assert.deepEqual(on.slice(0, 3).map(item => item.key), ['ublox_send_interval_2', 'ublox_interval1_start', 'ublox_interval2_start']);

    const off = engine.planWriteOrder([
        { key: 'ublox_send_interval_2', value: '0' },
        { key: 'ublox_multiple_intervals', value: 'false' },
    ], definitions);
    assert.deepEqual(off.map(item => item.key), ['ublox_multiple_intervals', 'ublox_send_interval_2']);
});

test('write order keeps unrelated keys stable, honours writeAfter, and survives cycles', () => {
    const stable = engine.planWriteOrder([
        { key: 'device_name', value: 'A' },
        { key: 'led_enabled', value: 'false' },
        { key: 'status_send_interval', value: '600' },
    ], definitions);
    assert.deepEqual(stable.map(item => item.key), ['device_name', 'led_enabled', 'status_send_interval']);

    const custom = { panels: [{ id: 'x', fields: [
        { key: 'b', writeAfter: ['a'] },
        { key: 'a' },
    ] }] };
    const explicit = engine.planWriteOrder([{ key: 'b', value: 1 }, { key: 'a', value: 2 }], custom);
    assert.deepEqual(explicit.map(item => item.key), ['a', 'b']);

    const cyclic = { panels: [{ id: 'y', fields: [
        { key: 'p', writeAfter: ['q'] },
        { key: 'q', writeAfter: ['p'] },
    ] }] };
    const fallback = engine.planWriteOrder([{ key: 'p', value: 1 }, { key: 'q', value: 2 }], cyclic);
    assert.deepEqual(fallback.map(item => item.key), ['p', 'q']);
});

test('nested group conditions gate every field inside the group', () => {
    const rules = engine.collectFieldRules(definitions);
    assert.ok(rules.get('gps_skipped_triggered_interval').gates.has('enable_motion_trig_gps'));
    assert.ok(rules.get('outdoor_detection_tau').gates.has('outdoor_detection_enabled'));
    assert.ok(rules.get('gps_triggered_interval').gates.has('gps_motion_triggered_min_num_of_triggers_per_interval'));
    assert.deepEqual([...rules.get('ublox_send_interval').gates], ['ublox_multiple_intervals'], 'the fix interval is gated by the schedule switch');
    assert.equal(rules.get('ublox_active_tracking').gates.size, 0);
});

test('draft tracks entries, validity and listeners', () => {
    const draft = engine.createDraft();
    const seen = [];
    const unsubscribe = draft.subscribe(d => seen.push(d.size));
    draft.set('a', { id: '0x01', value: '1', valid: true });
    draft.set('b', { id: '0x02', value: 'x', valid: false });
    assert.equal(draft.size, 2);
    assert.equal(draft.invalidCount(), 1);
    draft.set('b', { valid: true });
    assert.equal(draft.get('b').value, 'x', 'partial set keeps earlier fields');
    assert.equal(draft.invalidCount(), 0);
    draft.clear('a');
    draft.clear('missing');
    assert.deepEqual(draft.keys(), ['b']);
    draft.reset();
    draft.reset();
    assert.deepEqual(seen, [1, 2, 2, 1, 0]);
    unsubscribe();
    draft.set('c', { value: 1 });
    assert.deepEqual(seen, [1, 2, 2, 1, 0], 'unsubscribed listener is not called');
});

test('apply runner writes sequentially, reads back, and classifies each result', async () => {
    const events = [];
    const device = { a: '1', b: '2', c: '3' };
    const summary = await engine.runApply({
        items: [
            { key: 'a', value: '10' },
            { key: 'b', value: '20' },
            { key: 'c', value: '30' },
            { key: 'd', value: '40' },
        ],
        write: async item => {
            events.push(`write ${item.key}`);
            if (item.key === 'd') throw new Error('GATT write failed');
            if (item.key !== 'b') device[item.key] = item.value; // the device silently keeps b
            await wait(5);
        },
        read: async item => {
            events.push(`read ${item.key}`);
            return item.key === 'c' ? null : device[item.key];
        },
        isEqual: (item, readValue) => String(readValue) === String(item.value),
        onItem: ({ item, status }) => events.push(`${item.key}:${status}`),
        settleMs: 0,
    });
    assert.deepEqual(events, [
        'write a', 'read a', 'a:verified',
        'write b', 'read b', 'b:mismatch',
        'write c', 'read c', 'c:unverified',
        'write d', 'd:failed',
    ]);
    assert.equal(summary.verified, 1);
    assert.equal(summary.mismatch, 1);
    assert.equal(summary.unverified, 1);
    assert.equal(summary.failed, 1);
    assert.match(summary.results[3].error.message, /GATT write failed/);
});

test('the Positioning definition only references settings that exist in the v8.0.1 schema and meta', () => {
    const keys = new Set();
    definitions.panels.forEach(panel => engine.walkFields(panel.fields, field => {
        engine.fieldKeys(field).forEach(key => keys.add(key));
        engine.conditionKeys(field.enabledWhen, keys);
        engine.conditionKeys(field.visibleWhen, keys);
        (field.options || []).forEach(option => {
            engine.conditionKeys(option.when, keys);
            Object.keys(option.set || {}).forEach(key => keys.add(key));
        });
    }));
    for (const key of keys) {
        assert.ok(inSomeSchema(key), `a bundled schema has ${key}`);
        assert.ok(meta.settings[key], `meta has ${key}`);
    }
    assert.ok(keys.size >= 25);
});

test('settings-meta categories cover every category and every setting in the v8.0.1 schema', () => {
    for (const [key, setting] of Object.entries(schema.settings)) {
        const category = meta.settings[key] && meta.settings[key].category;
        assert.ok(category, `${key} has a category`);
        const entry = meta.categories[category];
        assert.ok(entry && entry.title && Number.isFinite(entry.order), `category ${category} is defined`);
        if (entry.settings.length) {
            assert.ok(entry.settings.includes(key), `${key} is ordered inside ${category}`);
        }
    }
    const orders = Object.values(meta.categories).map(entry => entry.order);
    assert.equal(new Set(orders).size, orders.length, 'category orders are unique');
});

test('schedule type options resolve from effective values and write set plus missing ensure values', () => {
    const choice = definitions.panels[0].fields.find(field => field.control === 'choice' && field.label === 'Schedule type');
    const values = { ublox_send_interval: '900', ublox_multiple_intervals: 'false', ublox_send_interval_2: '0' };
    const get = key => values[key];
    assert.equal(engine.resolveOption(choice, get).id, 'fixed');
    values.ublox_multiple_intervals = 'true';
    assert.equal(engine.resolveOption(choice, get).id, 'day-night');

    const dayNight = choice.options.find(option => option.id === 'day-night');
    assert.deepEqual(engine.optionWrites(dayNight, get), [
        { key: 'ublox_multiple_intervals', value: true },
        { key: 'ublox_send_interval_2', value: 3600 },
    ], 'interval 1 is already set, so only the night interval is ensured');
    const fixed = choice.options.find(option => option.id === 'fixed');
    values.ublox_send_interval = '0';
    assert.deepEqual(engine.optionWrites(fixed, get), [
        { key: 'ublox_multiple_intervals', value: false },
        { key: 'ublox_send_interval', value: 300 },
    ]);
});

test('the scheduled-fixes switch turns off to zero and turns on by restoring remembered values', () => {
    const field = definitions.panels[0].fields.find(f => f.control === 'switch');
    const values = { ublox_send_interval: '900', ublox_multiple_intervals: 'true' };
    const get = key => values[key];
    assert.equal(engine.isSwitchOn(field, get), true);
    assert.deepEqual(engine.switchWrites(field, false, get, null), [
        { key: 'ublox_send_interval', value: 0 },
        { key: 'ublox_multiple_intervals', value: false },
    ]);
    const remembered = { ublox_send_interval: '900', ublox_multiple_intervals: 'true' };
    values.ublox_send_interval = '0';
    values.ublox_multiple_intervals = 'false';
    assert.equal(engine.isSwitchOn(field, get), false);
    assert.deepEqual(engine.switchWrites(field, true, get, remembered), [
        { key: 'ublox_send_interval', value: '900' },
        { key: 'ublox_multiple_intervals', value: 'true' },
    ], 'restores both remembered values');
    assert.deepEqual(engine.switchWrites(field, true, get, null), [
        { key: 'ublox_send_interval', value: 300 },
    ], 'with nothing remembered, a sensible interval is used and the schedule type is left alone');
});

test('durations, UTC hours and day segments format for people', () => {
    assert.equal(engine.formatDurationWords(0), 'off');
    assert.equal(engine.formatDurationWords(45), '45 seconds');
    assert.equal(engine.formatDurationWords(900), '15 minutes');
    assert.equal(engine.formatDurationWords(5400), '1 hour 30 minutes');
    assert.equal(engine.formatDurationWords(86400), '1 day');
    assert.equal(engine.formatDurationWords(90061), '1 day 1 hour');
    assert.equal(engine.formatUtcHour('7'), '07:00');
    const close = (actual, expected) => {
        assert.equal(actual.length, expected.length);
        actual.forEach((segment, i) => {
            assert.ok(Math.abs(segment.left - expected[i].left) < 1e-9, `left ${segment.left}`);
            assert.ok(Math.abs(segment.width - expected[i].width) < 1e-9, `width ${segment.width}`);
        });
    };
    close(engine.daySegments(7, 18), [{ left: 700 / 24, width: 1100 / 24 }]);
    close(engine.daySegments(18, 7), [{ left: 1800 / 24, width: 600 / 24 }, { left: 0, width: 700 / 24 }]);
    close(engine.daySegments(9, 9), [{ left: 0, width: 100 }]);
});

test('the positioning summary reads as sentences for each mode', () => {
    const base = {
        ublox_send_interval: '900', ublox_multiple_intervals: 'false', ublox_send_interval_2: '3600',
        ublox_interval1_start: '7', ublox_interval2_start: '18', ublox_active_tracking: 'false',
        outdoor_detection_enabled: 'false', enable_motion_trig_gps: 'false', gps_triggered_interval: '0',
        gps_motion_triggered_min_num_of_triggers_per_interval: '0', gps_skipped_triggered_interval: '5',
        gps_resend_interval: '0',
    };
    const describe = (overrides = {}) => engine.describePositioning(key => ({ ...base, ...overrides })[key], { localTime: hour => `${Number(hour) + 2}:00` });
    assert.equal(describe(), 'Fix every 15 minutes, all day.');
    assert.equal(describe({ ublox_send_interval: '0' }), 'Scheduled fixes are off.');
    assert.equal(describe({ ublox_send_interval: '0', enable_motion_trig_gps: 'true', ublox_active_tracking: 'true' }),
        'Scheduled fixes are off. Motion-triggered and outdoor detection have no effect while scheduled fixes are off.');
    assert.equal(describe({ ublox_multiple_intervals: 'true' }),
        'Fix every 15 minutes from 07:00 UTC (9:00 local) to 18:00 UTC (20:00 local), and every 1 hour the rest of the day.');
    assert.equal(describe({ enable_motion_trig_gps: 'true' }),
        'Fix every 15 minutes, all day. While the tracker is still, up to 5 scheduled fixes are skipped.');
    assert.equal(describe({ enable_motion_trig_gps: 'true', gps_triggered_interval: '60', gps_motion_triggered_min_num_of_triggers_per_interval: '3' }),
        'Fix every 15 minutes, all day. An extra fix is taken after 3 movements within 1 minute.');
    assert.equal(describe({ outdoor_detection_enabled: 'true', ublox_active_tracking: 'true', gps_resend_interval: '600' }),
        'Fix every 15 minutes, all day. Fixes are only attempted when the tracker is probably outdoors. The receiver stays on between fixes and reports heading and speed. The last position is resent every 10 minutes.');
    const partial = engine.describePositioning(key => ({ ublox_send_interval: '300' })[key] ?? null);
    assert.equal(partial, 'Fix every 5 minutes, all day.', 'missing keys are simply left out');
});

test('the fix-quality summary describes cold, hot, satellite check and accuracy settings', () => {
    const values = { cold_fix_timeout: '200', cold_fix_retry: '200', hot_fix_timeout: '65', hot_fix_retry: '4',
        ublox_min_satellites: '3', ublox_min_satellites_timer: '30', horizontal_accuracy: '50' };
    const get = key => values[key] ?? null;
    assert.equal(engine.describeFixQuality(get),
        'Cold fix: up to 3 minutes 20 seconds per attempt, 200 attempts. Hot fix: up to 1 minute 5 seconds per attempt, 4 attempts. An attempt is abandoned after 30 seconds if fewer than 3 satellites are visible. Accuracy target 50 m.');
    values.ublox_min_satellites = '0';
    assert.match(engine.describeFixQuality(get), /not abandoned early/);
    assert.equal(engine.describeFixQuality(key => ({ hot_fix_retry: '1' })[key] ?? null), 'Hot fix: 1 attempt.');
});

test('port bitmask helpers match the firmware bit layout (bit = port - 1)', () => {
    assert.equal(engine.portBit(1), 1);
    assert.equal(engine.portBit(4), 8);
    assert.equal(engine.isPortSet('846383', 1), true);
    assert.equal(engine.isPortSet('846383', 5), false);
    assert.equal(engine.setPort('0', 4, true), 8);
    assert.equal(engine.setPort('8', 4, false), 0);
    assert.equal(engine.setPort('4294967295', 32, false), 2147483647);
    assert.equal(engine.setPort('2147483647', 32, true), 4294967295, 'bit 31 stays unsigned');
});

test('network, device and data summaries read as sentences', () => {
    const options = key => ({
        lr_region: [{ value: 1, label: 'EU 868' }],
        lr_adr_profile: [{ value: 1, label: 'Mobile, long range' }, { value: 3, label: 'Custom data rate' }],
    })[key];
    const network = { lr_region: '1', lr_adr_profile: '1', lr_adr: '3', rejoin_interval: '3600' };
    assert.equal(engine.describeNetwork(key => network[key] ?? null, { options }),
        'Region EU 868. Adaptive data rate: Mobile, long range. Rejoin attempts every 1 hour.');
    network.lr_adr_profile = '3';
    assert.match(engine.describeNetwork(key => network[key] ?? null, { options }), /custom, DR3 \(SF9 \/ 125 kHz\)/);
    network.lr_adr = '9';
    assert.match(engine.describeNetwork(key => network[key] ?? null, { options }), /DR9 \(not defined for this region\)/);

    const device = { device_name: 'SP051307', device_pin: '00000000', led_enabled: 'true', status_send_interval: '3600' };
    const pinDigits = raw => (raw.match(/.{2}/g) || []).map(pair => pair[1]).join('');
    assert.equal(engine.describeDevice(key => device[key] ?? null, { pinDigits }),
        'SP051307. No Bluetooth PIN. Status LED on. Status report every 1 hour.');
    device.device_pin = '01020304';
    assert.match(engine.describeDevice(key => device[key] ?? null, { pinDigits }), /Bluetooth PIN set/);

    const ports = [{ name: 'port_a', number: 1, label: 'A' }, { name: 'port_b', number: 2, label: 'B' }, { name: 'port_c', number: 4, label: 'C' }];
    const columns = [{ key: 'lr_send_flag', label: 'LoRaWAN', summaryLabel: 'over LoRaWAN' }, { key: 'flash_store_flag', label: 'Store', summaryLabel: 'stored to flash' }];
    const flags = { lr_send_flag: String(1 | 2), flash_store_flag: String(8) };
    assert.equal(engine.describeDataFlags(key => flags[key] ?? null, ports, columns), 'Of 3 message types: 2 over LoRaWAN, 1 stored to flash.');
});

test('every panel definition only references settings, options and ports that exist for v8.0.1', () => {
    const keys = new Set();
    definitions.panels.forEach(panel => engine.walkFields(panel.fields, field => {
        engine.fieldKeys(field).forEach(key => keys.add(key));
        (field.columns || []).forEach(column => keys.add(column.key));
        engine.conditionKeys(field.enabledWhen, keys);
        (field.options || []).forEach(option => {
            engine.conditionKeys(option.when, keys);
            Object.keys(option.set || {}).forEach(key => keys.add(key));
        });
        if (field.control === 'select') {
            assert.ok(Array.isArray(meta.settings[field.key].options) && meta.settings[field.key].options.length, `${field.key} has options in the meta`);
        }
    }));
    for (const key of keys) {
        assert.ok(inSomeSchema(key), `a bundled schema has ${key}`);
    }
    Object.keys(definitions.portLabels).forEach(port => {
        if (schema.ports[port] === undefined && betaSchema.ports[port] === undefined) assert.ok(port === 'port_rf_scan', `${port} is a known port or a legacy one`);
    });
    assert.deepEqual(definitions.panels.map(panel => panel.id), ['positioning', 'data', 'network', 'device', 'satellite', 'sband', 'lp0', 'vhf', 'wifi-scanning', 'ble-scanning', 'cmdq', 'fence', 'switch', 'air-quality', 'sensors']);
    definitions.supersededSections.forEach(item => assert.ok(schema.settings[item.key], `superseded key ${item.key}`));
    // No setting is edited by two panels (one editing path per key).
    const seen = new Map();
    definitions.panels.forEach(panel => engine.walkFields(panel.fields, field => {
        engine.fieldKeys(field).concat((field.columns || []).map(column => column.key)).forEach(key => {
            if (field.control === 'switch' || field.control === 'choice' || field.control === 'mode') return; // composite controls share keys with their fields
            assert.ok(!seen.has(key) || seen.get(key) === panel.id, `${key} appears in ${seen.get(key)} and ${panel.id}`);
            seen.set(key, panel.id);
        });
    }));
    assert.ok(seen.size >= 100, `${seen.size} settings covered by panels`);
    definitions.panels.forEach(panel => engine.walkFields(panel.fields, field => {
        (field.warnings || []).forEach(item => engine.conditionKeys(item.when).forEach(key => assert.ok(inSomeSchema(key), `warning key ${key}`)));
        (field.onAlso || []).forEach(item => assert.ok(schema.settings[item.key], `onAlso key ${item.key}`));
    }));
});

test('settings-meta categories cover every setting in the v8.1.0 development schema too', () => {
    for (const key of Object.keys(betaSchema.settings)) {
        const category = meta.settings[key] && meta.settings[key].category;
        assert.ok(category, `${key} has a category`);
        const entry = meta.categories[category];
        assert.ok(entry && entry.settings.includes(key), `${key} is ordered inside ${category}`);
        assert.ok(meta.settings[key].display_name, `${key} has a display name`);
    }
    for (const key of ['cmd_offload_start', 'cmd_offload_cancel', 'cmd_flash_clear_confirmed', 'cmd_recover_sd']) {
        assert.ok(betaSchema.commands[key], `${key} in the 8.1.0 schema`);
        assert.ok(meta.commands[key] && meta.commands[key].description, `${key} described in the meta`);
    }
    assert.ok(meta.commands.cmd_flash_clear_confirmed.options.some(option => option.value === 8), 'LP0 selector 0x08 offered');
});

test('byte helpers read and write one byte of a hex or brace-formatted byte array', () => {
    assert.equal(engine.byteAt('02040A013C', 0), 2);
    assert.equal(engine.byteAt('02040A013C', 4), 0x3C);
    assert.equal(engine.byteAt('{0x01,0x00,0x0a,0x01,0x3c}', 2), 10);
    assert.ok(Number.isNaN(engine.byteAt('0204', 2)), 'past the end');
    assert.ok(Number.isNaN(engine.byteAt(null, 0)));
    assert.equal(engine.setByte('00000A013C', 0, 2, 5), '02000A013C');
    assert.equal(engine.setByte('{0x00,0x00,0x0a,0x01,0x3c}', 1, 7, 5), '00070A013C');
    assert.equal(engine.setByte('', 4, 60, 5), '000000003C', 'an empty value is padded');
    assert.equal(engine.setByte('0102030405', 2, 300, 5), '0102FF0405', 'clamped to a byte');
    assert.equal(engine.hexDigits(' 0xAb, 0xcd '), 'ABCD');
});

test('conditions can test one byte of a byte-array setting', () => {
    const values = { lp0_node_params: '02030A013C', lp0_signal_checks: '010101640114' };
    const get = key => values[key];
    assert.equal(engine.evaluateCondition({ key: 'lp0_node_params', byte: 0, equals: 2 }, get), true);
    assert.equal(engine.evaluateCondition({ key: 'lp0_node_params', byte: 0, equals: 1 }, get), false);
    assert.equal(engine.evaluateCondition({ key: 'lp0_node_params', byte: 0, in: [1, 2] }, get), true);
    assert.equal(engine.evaluateCondition({ key: 'lp0_node_params', byte: 1, gt: 2 }, get), true);
    assert.equal(engine.evaluateCondition({ key: 'lp0_signal_checks', byte: 3, equals: 100 }, get), true);
    assert.equal(engine.evaluateCondition({ key: 'lp0_node_params', byte: 9, equals: 0 }, get), false, 'a missing byte matches nothing');
    assert.deepEqual([...engine.conditionKeys({ key: 'lp0_node_params', byte: 0, equals: 2 })], ['lp0_node_params']);
});

test('the LP0 panel is gated to the 8.1 schema and its byte fields fit the arrays', () => {
    const panel = definitions.panels.find(item => item.id === 'lp0');
    assert.ok(panel.beta && panel.minFirmware.major === 8 && panel.minFirmware.minor === 1);
    panel.requires.forEach(key => {
        assert.ok(betaSchema.settings[key], `${key} in 8.1.0`);
    });
    assert.ok(panel.requires.some(key => !schema.settings[key]), 'at least one required key is missing from 8.0.x, so the panel is left out there');
    const keys = new Set();
    engine.walkFields(panel.fields, field => {
        engine.fieldKeys(field).forEach(key => {
            keys.add(key);
            assert.ok(betaSchema.settings[key], `${key} in 8.1.0`);
            assert.ok(meta.settings[key] && meta.settings[key].display_name, `${key} named in the meta`);
        });
        if (field.control === 'byte') {
            const setting = betaSchema.settings[field.key];
            assert.equal(setting.conversion, 'byte_array', `${field.key} is a byte array`);
            assert.ok(Number.isInteger(field.byte) && field.byte >= 0 && field.byte < setting.length, `${field.label} byte ${field.byte} inside ${setting.length}`);
            (field.options || []).forEach(option => assert.ok(option.value >= 0 && option.value <= 255, `${field.label} option ${option.value}`));
            if (!field.options) assert.ok(field.min >= 0 && field.max <= 255, `${field.label} range`);
        }
        if (field.control === 'hex') {
            assert.equal(betaSchema.settings[field.key].conversion, 'byte_array');
        }
        engine.conditionKeys(field.enabledWhen, keys);
    });
    for (const key of ['lp0_node_params', 'lp0_master_key', 'lp0_signal_checks', 'lp0_focus_offloading', 'lp0_gps_before_start', 'lp0_statistics_interval', 'lp0_communication_params', 'lp0_tx_frequency_hz', 'lp0_app_key']) {
        assert.ok(keys.has(key), `${key} edited in the LP0 panel`);
    }
    // The 8.1 additions outside LP0 sit in the Network and Positioning panels, and only there.
    const panelOf = key => definitions.panels.find(panel => { let found = false; engine.walkFields(panel.fields, field => { if (engine.fieldKeys(field).includes(key)) found = true; }); return found; });
    assert.equal(panelOf('lr_enabled').id, 'network');
    assert.equal(panelOf('ublox_require_time').id, 'positioning');
    assert.ok(!schema.settings.lr_enabled && !schema.settings.ublox_require_time, 'absent from 8.0.x, so those fields are skipped there');
    assert.ok(!keys.has('lp0_send_flag'), 'the send mask stays in the Data matrix');
    const stationId = panel.fields.find(field => field.label === 'Station ID');
    assert.equal(engine.evaluateCondition(stationId.enabledWhen, key => ({ lp0_node_params: '02000A013C' })[key]), true);
    assert.equal(engine.evaluateCondition(stationId.enabledWhen, key => ({ lp0_node_params: '01000A013C' })[key]), false);
    const plan = engine.planWriteOrder([{ key: 'lp0_node_params' }, { key: 'lp0_statistics_interval' }], definitions);
    assert.deepEqual(plan.map(change => change.key), ['lp0_node_params', 'lp0_statistics_interval'], 'same-key byte gates do not reorder');
});

test('the LP0 summary reads as sentences for off, tracker and station', () => {
    const describe = values => engine.describeLp0(key => (key in values ? values[key] : null));
    assert.equal(describe({ lp0_node_params: '00000A013C', lp0_master_key: '00000000000000000000000000000000', lp0_focus_offloading: 'false', lp0_statistics_interval: '3600' }),
        'Offloading off. Cluster master key is the all-zero default.');
    assert.equal(describe({ lp0_node_params: '01000A013C', lp0_master_key: 'EC7F380E7ADFB2E5C9BBDE5AC21694A8', lp0_focus_offloading: true }),
        'Tracker: looks for a station every 1 minute, 10 station slots. Cluster master key set. Focus on offloading.');
    assert.equal(describe({ lp0_node_params: '0100 0A 01 00', lp0_master_key: '{0x01,0x00}' }),
        'Tracker: looks for a station as soon as LP0 is idle, 10 station slots. Cluster master key set.');
    assert.equal(describe({ lp0_node_params: '02030A013C', lp0_master_key: 'AB', lp0_statistics_interval: '0' }),
        'Offload station, ID 3 of 10 slots. Cluster master key set. Statistics off.');
    assert.equal(describe({ lp0_node_params: '02000A013C', lp0_statistics_interval: 7200 }),
        'Offload station, ID 0 of 10 slots. Statistics every 2 hours.');
    assert.equal(describe({ lp0_node_params: '02000A013C', lp0_gps_before_start: true, lp0_statistics_interval: 7200 }),
        'Offload station, ID 0 of 10 slots. GPS fix before offloading. Statistics every 2 hours.');
    assert.equal(describe({ lp0_node_params: '02000A013C', lp0_gps_before_start: 'false', lp0_statistics_interval: 7200 }),
        'Offload station, ID 0 of 10 slots. Statistics every 2 hours.');
    assert.equal(describe({}), '');
});

test('the generic schedule summary covers off, fixed, day/night and zero-interval states', () => {
    const cfg = { enabledKey: 'satellite_enabled', interval1Key: 'satellite_send_interval', multipleKey: 'satellite_multiple_intervals',
        start1Key: 'satellite_interval1_start', interval2Key: 'satellite_send_interval2', start2Key: 'satellite_send_interval2_start',
        verb: 'Send', subject: 'Satellite sending' };
    const values = { satellite_enabled: 'false', satellite_send_interval: '86400', satellite_multiple_intervals: 'false',
        satellite_interval1_start: '7', satellite_send_interval2: '86400', satellite_send_interval2_start: '19' };
    const get = key => values[key] ?? null;
    assert.equal(engine.describeSchedule(get, cfg), 'Satellite sending is off.');
    values.satellite_enabled = 'true';
    assert.equal(engine.describeSchedule(get, cfg), 'Send every 1 day, all day.');
    values.satellite_multiple_intervals = 'true';
    values.satellite_send_interval = '3600';
    assert.equal(engine.describeSchedule(get, cfg, { localTime: h => `${Number(h) + 2}:00` }),
        'Send every 1 hour from 07:00 UTC (9:00 local) to 19:00 UTC (21:00 local), and every 1 day the rest of the day.');
    values.satellite_multiple_intervals = 'false';
    values.satellite_send_interval = '0';
    assert.equal(engine.describeSchedule(get, cfg), 'Satellite sending is on but its interval is 0, so nothing is sent.');
});

test('the fix-quality summary warns when the satellite timer is below the firmware minimum', () => {
    const values = { ublox_min_satellites: '3', ublox_min_satellites_timer: '0' };
    const text = engine.describeFixQuality(key => values[key] ?? null);
    assert.match(text, /Warning: the satellite check runs every second \(timer 0 s, below the firmware minimum of 5 s\)/);
    values.ublox_min_satellites_timer = '30';
    assert.match(engine.describeFixQuality(key => values[key] ?? null), /abandoned after 30 seconds if fewer than 3/);
});

test('data rate numbers translate to the spreading factor of the selected region', () => {
    assert.equal(engine.describeDataRate(1, 0), 'SF12 / 125 kHz', 'EU 868');
    assert.equal(engine.describeDataRate('1', '5'), 'SF7 / 125 kHz');
    assert.equal(engine.describeDataRate(1, 6), 'SF7 / 250 kHz');
    assert.equal(engine.describeDataRate(1, 7), 'FSK 50 kbps');
    assert.equal(engine.describeDataRate(1, 8), null, 'EU 868 has no DR8');
    assert.equal(engine.describeDataRate(3, 0), 'SF10 / 125 kHz', 'US 915');
    assert.equal(engine.describeDataRate(3, 4), 'SF8 / 500 kHz');
    assert.equal(engine.describeDataRate(3, 7), null, 'US 915 DR7 is RFU');
    assert.equal(engine.describeDataRate(3, 8), 'SF12 / 500 kHz, downlink only');
    assert.equal(engine.describeDataRate(3, 13), 'SF7 / 500 kHz, downlink only');
    assert.equal(engine.describeDataRate(4, 0), 'SF12 / 125 kHz', 'AU 915');
    assert.equal(engine.describeDataRate(4, 6), 'SF8 / 500 kHz');
    assert.equal(engine.describeDataRate(2, 0), 'SF12 / 125 kHz', 'AS 923');
    assert.equal(engine.describeDataRate(6, 0), 'SF12 / 812 kHz', 'WW 2.4 GHz');
    assert.equal(engine.describeDataRate(10, 6), null, 'KR 920 stops at DR5');
    assert.equal(engine.describeDataRate(99, 0), null, 'unknown region');
    assert.equal(engine.describeDataRate(1, -1), null);
    assert.equal(engine.describeDataRate(1, 'x'), null);

    const eu = engine.dataRateOptions(1, 15);
    assert.deepEqual(eu.map(o => o.value), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(eu[0].label, 'DR0 = SF12 / 125 kHz');
    const us = engine.dataRateOptions(3, 15);
    assert.deepEqual(us.map(o => o.value), [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13], 'DR7 is skipped');
    assert.deepEqual(engine.dataRateOptions(3, 4).map(o => o.value), [0, 1, 2, 3, 4], 'capped by the setting max');
    assert.deepEqual(engine.dataRateOptions(99), []);
});
