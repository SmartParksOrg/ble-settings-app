const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const engine = require(path.join(root, 'panels/panel-engine.js'));
const definitions = require(path.join(root, 'panels/panel-definitions.js'));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'settings/settings-v8.0.1.json'), 'utf8'));
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
        assert.ok(schema.settings[key], `schema has ${key}`);
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
