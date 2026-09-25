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
    assert.equal(rules.get('ublox_send_interval').gates.size, 0);
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
