const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const v8 = 'settings/settings-v8.0.0.json';
const v7 = 'settings/settings-v7.2.0.json';

function app() {
    const context = vm.createContext({
        window: {},
        document: { addEventListener() {}, getElementById() { return null; } },
        console, TextEncoder, TextDecoder,
        fetch: async file => ({
            ok: true,
            json: async () => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
        })
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'functions.js'), 'utf8'), context);
    context.evaluate = code => vm.runInContext(code, context);
    return context;
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test('every bundled schema loads without losing settings, commands or values', async () => {
    const ctx = app();
    for (const file of fs.readdirSync(path.join(root, 'settings'))) {
        await ctx.loadSettings(`settings/${file}`);
        const counts = plain(ctx.evaluate(`({
            actual: settingsMap.size,
            expected: Object.keys(settingsData.settings).length +
                Object.keys(settingsData.commands).length + Object.keys(settingsData.values).length
        })`));
        assert.equal(counts.actual, counts.expected, file);
    }
});

test('v8 repeated byte IDs remain distinct across families and commands', async () => {
    const ctx = app();
    await ctx.loadSettings(v8);
    assert.equal(ctx.getById('0x0200')[0], 'tracker_type');
    assert.equal(ctx.getById('0x0300')[0], 'lr_send_flag');
    assert.equal(ctx.getById('0x0400')[0], 'ble_adv');
    assert.equal(ctx.getById('0xA000')[0], 'reset_reason');
    assert.equal(ctx.getById('0xA0')[0], 'cmd_join');
    assert.equal(ctx.getById('0x0600')[1].wireId, 0);
});

test('GPS interval writes and single reads match firmware wire examples', async () => {
    const ctx = app();
    for (const [file, write, read, valueRead] of [
        [v8, '0600043C000000', 'A8020600', 'A302A00E'],
        [v7, '02043C000000', 'A80102', 'A301E8']
    ]) {
        await ctx.loadSettings(file);
        const gps = ctx.getByKey('ublox_send_interval');
        const bytes = ctx.settingToBytes('ublox_send_interval', gps, '60');
        assert.equal(ctx.bytesToHex(ctx.encodeProtocolRecord(gps, bytes)), write);
        assert.equal(ctx.bytesToHex(ctx.encodeReadRequest(gps.id, 0xA8)), read);
        const flashId = ctx.evaluate('settingsData.values.flash_nr_msg.id');
        assert.equal(ctx.bytesToHex(ctx.encodeReadRequest(flashId, 0xA3)), valueRead);
        assert.equal(ctx.bytesToHex(ctx.encodeProtocolRecord(ctx.getById(0xA1)[1], [])), 'A100');
        assert.equal(ctx.bytesToHex(ctx.encodeProtocolRecord(ctx.getById(0xA7)[1], [])), 'A700');
        assert.throws(() => ctx.encodeReadRequest(flashId, 0xA8), /matching/);
        assert.throws(() => ctx.encodeReadRequest(gps.id, 0xA3), /matching/);
    }
});

test('stacked v8 settings and runtime values decode by family', async () => {
    const ctx = app();
    await ctx.loadSettings(v8);
    const records = ctx.decodeSettingRecords([
        0x02, 0x00, 1, 7,
        0x04, 0x00, 1, 1,
        0x06, 0x00, 4, 0x3C, 0, 0, 0
    ], 'setting');
    assert.deepEqual(plain(records.map(({ key, value }) => [key, value])), [
        ['tracker_type', 7], ['ble_adv', true], ['ublox_send_interval', 60]
    ]);
    const values = ctx.decodeSettingRecords([
        0xA0, 0x0E, 4, 25, 0, 0, 0,
        0xA0, 0x11, 1, 3,
        0xA0, 0x08, 4, 0, 0xF1, 0x53, 0x65
    ], 'value');
    assert.deepEqual(plain(values.map(({ key, value }) => [key, value])), [
        ['flash_nr_msg', 25], ['n_mes', 3], ['ublox_time', 1700000000]
    ]);
});

test('legacy stacked settings and values still decode', async () => {
    const ctx = app();
    await ctx.loadSettings(v7);
    assert.equal(ctx.decodeSettingRecords([2, 4, 60, 0, 0, 0], 'setting')[0].value, 60);
    assert.equal(ctx.decodeSettingRecords([0xE8, 4, 25, 0, 0, 0], 'value')[0].key, 'flash_nr_msg');
});

test('unknown addresses and wrong lengths do not desynchronize subsequent records', async () => {
    const ctx = app();
    await ctx.loadSettings(v8);
    const warnings = [];
    const records = ctx.decodeSettingRecords([
        0x09, 0x00, 2, 0xFF, 0xFF,
        0x06, 0x00, 1, 0xFF,
        0xA0, 0x00, 4, 0, 0, 0, 0,
        0x06, 0x00, 4, 60, 0, 0, 0
    ], 'setting', warning => warnings.push(warning));
    assert.equal(records.length, 1);
    assert.equal(records[0].key, 'ublox_send_interval');
    assert.equal(records[0].value, 60);
    assert.equal(warnings.length, 3);
    assert.throws(() => ctx.decodeSettingRecords([6, 0], 'setting'), /Truncated/);
    assert.throws(() => ctx.decodeSettingRecords([6, 0, 4, 60], 'setting'), /Truncated/);
});

test('schema selection compares numeric major/minor versions', () => {
    const ctx = app();
    const files = ['settings-v8.10.0.json', 'settings-v8.0.0.json', 'settings-v7.2.0.json'];
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 0 }, files), 'settings-v8.0.0.json');
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 1 }, files), null);
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 9, ver_fw_minor: 0 }, files), null);
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 0 }), 'settings-v8.0.1.json');
});

test('incompatible manually selected schemas fail before registering data', async () => {
    const ctx = app();
    await assert.rejects(ctx.loadSettings(v7, { ver_fw_major: 8, ver_fw_minor: 0 }), /different protocol/);
    await assert.rejects(ctx.loadSettings(v8, { ver_fw_major: 7, ver_fw_minor: 3 }), /different protocol/);
    assert.equal(ctx.evaluate('settingsData'), null);
    assert.equal(ctx.evaluate('settingsMap.size'), 0);
    await ctx.loadSettings(v8, { ver_fw_major: 8, ver_fw_minor: 0 });
    assert.equal(ctx.firmwareUsesFamilies({ ver_fw_major: 7, ver_fw_minor: 4 }), true);
});

test('credentials are identified by names across firmware versions', async () => {
    const ctx = app();
    for (const file of [v7, v8]) {
        await ctx.loadSettings(file);
        for (const key of ['app_key', 'device_eui', 'app_eui', 'device_name', 'device_pin', 'lp0_app_key', 'lp0_network_key', 'lp0_dev_addr']) {
            assert.equal(ctx.isCredentialSetting(ctx.getByKey(key)), true, `${file}: ${key}`);
        }
        assert.equal(ctx.isCredentialSetting(ctx.getByKey('ublox_send_interval')), false);
    }
});

test('v8 scan filters include manufacturer exclusion without changing older options', async () => {
    const ctx = app();
    await ctx.loadSettings(v8);
    assert.match(ctx.getSettingOptions('ble_scan_filter').find(option => option.value === 4).label, /Exclude/);
    await ctx.loadSettings(v7);
    assert.equal(ctx.getSettingOptions('ble_scan_filter').some(option => option.value === 4), false);
});

test('invalid family bytes and failed schema fetches clear the active schema', async () => {
    const ctx = app();
    await ctx.loadSettings(v7);
    const schema = JSON.parse(fs.readFileSync(path.join(root, v8), 'utf8'));
    delete schema.settings.tracker_type.family;
    ctx.fetch = async () => ({ ok: true, json: async () => schema });
    await assert.rejects(ctx.loadSettings(v8), /Invalid protocol byte/);
    assert.equal(ctx.evaluate('settingsMap.size'), 0);
    ctx.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(ctx.loadSettings(v8), /HTTP 404/);
    assert.equal(ctx.evaluate('settingsData'), null);
});

test('the settings list follows the meta order instead of alphabetical order', async () => {
    const ctx = app();
    await ctx.loadSettingsMeta();
    await ctx.loadSettings(v8);
    const groups = plain(ctx.groupAndSortSettings());
    const names = Object.keys(groups);
    assert.deepEqual(names.slice(0, 4), ['device', 'status', 'gps', 'outdoor']);
    assert.equal(names[names.length - 1] === '_other' || names.includes('memfault'), true);
    const gps = Object.keys(groups.gps);
    assert.deepEqual(gps.slice(0, 5), ['ublox_send_interval', 'ublox_multiple_intervals', 'ublox_interval1_start', 'ublox_send_interval_2', 'ublox_interval2_start']);
    assert.equal(gps[gps.length - 1], 'gps_init_lon');
    assert.equal(ctx.formatGroupTitle('gps'), 'Positioning (GPS)');
    assert.equal(ctx.formatGroupTitle('lorawan'), 'Network (LoRaWAN)');
    assert.equal(ctx.formatGroupTitle('unknown_group'), 'unknown group');
});
