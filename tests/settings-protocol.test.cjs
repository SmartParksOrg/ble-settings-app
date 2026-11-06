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

test('the schema dropdown lists releases first and development snapshots in a Beta group at the end', () => {
    const ctx = app();
    const node = tag => ({ tag, children: [], appendChild(child) { this.children.push(child); return child; } });
    const dropdown = node('select');
    ctx.document.getElementById = () => dropdown;
    ctx.document.createElement = tag => node(tag);
    ctx.populateSettingsIntoPage('Choose a settings file');
    const [placeholder, ...rest] = dropdown.children;
    assert.equal(placeholder.textContent, 'Choose a settings file');
    const group = rest[rest.length - 1];
    assert.equal(group.tag, 'optgroup', 'the Beta group is the last entry');
    assert.match(group.label, /^Beta/);
    assert.deepEqual(group.children.map(o => o.value), ['./settings/settings-v8.2.0.json']);
    assert.equal(group.children[0].textContent, 'settings-v8.2.0.json (beta)');
    const releases = rest.slice(0, -1);
    assert.equal(releases[0].value, './settings/settings-v8.0.3.json', 'the latest release is the first real choice');
    assert.ok(releases.every(o => o.tag === 'option' && !/beta/.test(o.textContent)));
    assert.equal(releases.length + group.children.length, ctx.evaluate('SETTINGS_FILES.length'));
});

test('schema selection compares numeric major/minor versions', () => {
    const ctx = app();
    const files = ['settings-v8.10.0.json', 'settings-v8.0.0.json', 'settings-v7.2.0.json'];
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 0 }, files), 'settings-v8.0.0.json');
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 1 }, files), null);
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 9, ver_fw_minor: 0 }, files), null);
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 0 }), 'settings-v8.0.3.json');
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 2 }), 'settings-v8.2.0.json', 'the 8.2.0 beta schema');
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 1 }), null, 'no 8.1 schema is bundled any more');
    assert.equal(ctx.findSettingsFileForFirmware({ ver_fw_major: 8, ver_fw_minor: 3 }), null);
});

test('the 8.2.0 beta schema adds the LP0 offload settings, commands and statistics message', async () => {
    const ctx = app();
    await ctx.loadSettingsMeta();
    await ctx.loadSettings('settings/settings-v8.2.0.json', { ver_fw_major: 8, ver_fw_minor: 2 });
    const data = ctx.evaluate('settingsData');
    for (const key of ['lp0_master_key', 'lp0_signal_checks', 'lp0_focus_offloading', 'lp0_statistics_interval', 'lp0_gps_before_start', 'lp0_discovery_retry_count', 'lr_enabled', 'ublox_require_time']) {
        assert.ok(data.settings[key], key);
        assert.ok(ctx.evaluate(`settingsMeta.settings.${key}`), `${key} named in the meta`);
    }
    assert.equal(ctx.getById('0x0527')[0], 'lp0_master_key');
    assert.equal(ctx.getById('0x052A')[0], 'lp0_discovery_retry_count');
    assert.equal(data.settings.lp0_discovery_retry_count.default, 0);
    assert.equal(data.settings.lp0_discovery_retry_count.max, 255);
    assert.equal(data.settings.lp0_signal_checks.default, '{0x01,0x01,0x01,0x64,0x00,0x14}', 'the background margin check is off by default since 2026-11-03');
    assert.equal(ctx.getById('0x0528')[0], 'lr_enabled');
    assert.equal(ctx.getById('0x0529')[0], 'lp0_gps_before_start');
    assert.equal(ctx.getById('0x0619')[0], 'ublox_require_time');
    assert.equal(ctx.getById('0xD3')[0], 'cmd_recover_sd');
    assert.equal(ctx.getById('0xCF')[0], 'cmd_offload_start');
    assert.equal(ctx.getById('0xD1')[0], 'cmd_offload_cancel');
    assert.equal(ctx.getById('0xD2')[0], 'cmd_flash_clear_confirmed');
    assert.equal(data.ports.port_lp0_statistics, 23);
    assert.equal(data.messages.msg_lp0_statistics.id, '0x9D');
    assert.ok(ctx.isCredentialSetting(data.settings.lp0_master_key), 'the master key is exported only with the credentials');
    assert.ok(!ctx.isCredentialSetting(data.settings.lp0_signal_checks));
    // The full master key write: family 0x05, id 0x27, 16 bytes.
    const key = data.settings.lp0_master_key;
    const record = ctx.encodeProtocolRecord(key, ctx.settingToBytes('lp0_master_key', key, 'EC7F380E7ADFB2E5C9BBDE5AC21694A8'));
    assert.deepEqual(Array.from(record).slice(0, 4), [0x05, 0x27, 0x10, 0xEC]);
    assert.equal(record.length, 19);
});

test('LP0 signal checks are validated byte by byte against the schema bounds', async () => {
    const ctx = app();
    await ctx.loadSettingsMeta();
    await ctx.loadSettings('settings/settings-v8.2.0.json');
    const checks = ctx.evaluate('settingsData.settings.lp0_signal_checks');
    assert.doesNotThrow(() => ctx.validateInput('lp0_signal_checks', checks, '010101640014'), 'the firmware default');
    assert.doesNotThrow(() => ctx.validateInput('lp0_signal_checks', checks, '010101640114'), 'the pre-2026-11-03 default');
    assert.doesNotThrow(() => ctx.validateInput('lp0_signal_checks', checks, '0000007D017F'), 'at the maxima');
    assert.throws(() => ctx.validateInput('lp0_signal_checks', checks, '020101640114'), /Byte 1 must be between 0 and 1/);
    assert.throws(() => ctx.validateInput('lp0_signal_checks', checks, '0101017E0114'), /Byte 4 must be between 0 and 125/);
    assert.throws(() => ctx.validateInput('lp0_signal_checks', checks, '010101640180'), /Byte 6 must be between 0 and 127/);
    assert.throws(() => ctx.validateInput('lp0_signal_checks', checks, '0101'), /Length must be 12 hex chars/);
    // Arrays with an all-zero max (every older byte array) are not range-checked.
    const node = ctx.evaluate('settingsData.settings.lp0_node_params');
    assert.doesNotThrow(() => ctx.validateInput('lp0_node_params', node, 'FFFFFFFFFF'));
    const masterKey = ctx.evaluate('settingsData.settings.lp0_master_key');
    assert.doesNotThrow(() => ctx.validateInput('lp0_master_key', masterKey, 'FF'.repeat(16)), 'max of all 0xFF admits every key');
    const preview = ctx.formatCustomByteArrayPreview('lp0_signal_checks', checks, '010001640014');
    assert.match(preview, /All signal checks/);
    assert.match(preview, /-100 dBm/);
    assert.match(preview, /20 dB/);
});

function statisticsBody({ version = 3, latest = 0, known = 0, uptime = 0, pending = 0, peak = 0, counters = [], capacity = 0xFFFFFFFF, free = 0xFF } = {}) {
    const body = new Uint8Array(version === 1 ? 97 : 102);
    const view = new DataView(body.buffer);
    body[0] = version;
    view.setUint16(1, latest, true);
    view.setUint16(3, known, true);
    view.setUint32(5, uptime, true);
    view.setUint16(9, pending, true);
    view.setUint16(11, peak, true);
    counters.forEach((value, index) => view.setUint32(13 + index * 4, value, true));
    if (version > 1) {
        view.setUint32(97, capacity, true);
        body[101] = free;
    }
    return body;
}

test('LP0 station statistics decode flags, counters and SD capacity per version', () => {
    const ctx = app();
    const counters = Array.from({ length: 21 }, (_, index) => index * 10);
    counters[9] = 123456; // data_saved_bytes
    const body = statisticsBody({ latest: 0b0000010001100011, known: 0b0001111111111111, uptime: 93784, pending: 2, peak: 5, counters, capacity: 7580, free: 93 });
    const decoded = ctx.decodeLp0StatisticsMessage(body);
    assert.equal(decoded.version, 3);
    assert.equal(decoded.uptimeSeconds, 93784);
    assert.equal(decoded.pendingSdJobs, 2);
    assert.equal(decoded.peakSdJobs, 5);
    assert.equal(decoded.status.length, 13);
    const flag = key => decoded.status.find(entry => entry.key === key);
    assert.equal(flag('card_detected').value, true);
    assert.equal(flag('card_writable').value, true);
    assert.equal(flag('sdfs_unresponsive').value, false);
    assert.equal(flag('enabled').value, true);
    assert.equal(flag('listening').value, true);
    assert.equal(flag('flash_available').value, true);
    assert.equal(flag('sdfs_error').value, false);
    assert.equal(decoded.counters.visits_complete, 0);
    assert.equal(decoded.counters.visits_partial, 10);
    assert.equal(decoded.counters.data_saved, 60);
    assert.equal(decoded.counters.data_saved_bytes, 123456);
    assert.equal(decoded.counters.report_sd_failed, 200);
    assert.equal(decoded.sdCapacityMb, 7580);
    assert.equal(decoded.sdFreePercent, 93);
    const summary = ctx.summarizeLp0Statistics(decoded);
    assert.match(summary, /^Station statistics v3; up 1 day 2 hours/);
    assert.match(summary, /sd card detected, sd card writable, lp0 enabled, listening for trackers, flash logging available/);
    assert.match(summary, /0 visits complete, 10 partial, 90 not completed/);
    assert.match(summary, /60 data packets saved \(123456 bytes\), 70 failed, 80 dropped/);
    assert.match(summary, /SD 7580 MB, 93% free/);
    assert.doesNotMatch(summary, /unknown/);

    // Unknown bits are reported as unknown, never as healthy; unknown capacity stays null.
    const partial = ctx.decodeLp0StatisticsMessage(statisticsBody({ version: 2, latest: 0xFFFF, known: 0b11, counters }));
    assert.equal(partial.status.length, 11, 'version 2 has no bits 11 and 12');
    assert.equal(partial.status.find(entry => entry.key === 'card_detected').value, true);
    assert.equal(partial.status.find(entry => entry.key === 'enabled').value, null);
    assert.equal(partial.sdCapacityMb, null);
    assert.equal(partial.sdFreePercent, null);
    assert.match(ctx.summarizeLp0Statistics(partial), /SD size unknown; 9 status flags unknown$/);

    const v1 = ctx.decodeLp0StatisticsMessage(statisticsBody({ version: 1, counters }));
    assert.equal(v1.sdCapacityMb, null);
    assert.equal(v1.counters.report_sd_failed, 200);
    assert.throws(() => ctx.decodeLp0StatisticsMessage(statisticsBody({ version: 3 }).slice(0, 50)), /expected 102/);
    assert.throws(() => ctx.decodeLp0StatisticsMessage(new Uint8Array([9])), /Unknown statistics version 9/);
});

test('the offload job reply decodes the state, medium, selection, errno and confirmed count', () => {
    const ctx = app();
    const reply = new Uint8Array(17);
    const view = new DataView(reply.buffer);
    view.setUint32(0, 7, true);      // job id
    reply[4] = 3;                     // discovering
    reply[5] = 0;                     // LP0
    reply[6] = 2;                     // unconfirmed
    reply[7] = 0;                     // all ports
    reply[8] = 1;                     // attempts
    view.setInt32(9, -119, true);     // EINPROGRESS (newlib numbering, not Linux's 115)
    view.setUint32(13, 42, true);     // confirmed
    const decoded = ctx.decodeOffloadJobReply(reply);
    assert.equal(decoded.jobId, 7);
    assert.equal(decoded.stateLabel, 'discovering');
    assert.equal(decoded.mediumLabel, 'LP0');
    assert.equal(decoded.selectionLabel, 'unconfirmed records');
    assert.equal(decoded.port, 0);
    assert.equal(decoded.attempts, 1);
    assert.equal(decoded.result, -119);
    assert.match(decoded.resultLabel, /in progress/);
    assert.equal(decoded.confirmed, 42);

    view.setUint32(0, 0, true);
    reply[4] = 7; reply[5] = 2; reply[6] = 0; reply[7] = 4;
    view.setInt32(9, -115, true);     // ENETDOWN
    const failed = ctx.decodeOffloadJobReply(reply);
    assert.equal(failed.stateLabel, 'failed');
    assert.equal(failed.mediumLabel, 'satellite');
    assert.equal(failed.selectionLabel, 'all records');
    assert.equal(failed.port, 4);
    assert.match(failed.resultLabel, /satellite modem/);
    view.setInt32(9, -9999, true);
    assert.equal(ctx.decodeOffloadJobReply(reply).resultLabel, 'firmware error -9999');
    assert.throws(() => ctx.decodeOffloadJobReply(reply.slice(0, 10)), /expected 17/);
});

test('transfer commands encode the firmware bytes and the state probe is a cancel of an impossible job', () => {
    const ctx = app();
    const plain = value => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(ctx.encodeOffloadStart(3, 2, 0)), [0x20, 0xCF, 0x03, 3, 2, 0], 'Bluetooth, unconfirmed, all ports');
    assert.deepEqual(plain(ctx.encodeOffloadStart(0, 2, 4)), [0x20, 0xCF, 0x03, 0, 2, 4]);
    assert.deepEqual(plain(ctx.encodeOffloadCancel(7)), [0x20, 0xD1, 0x04, 7, 0, 0, 0], 'little-endian job ID');
    assert.deepEqual(plain(ctx.encodeOffloadCancel(0x01020304)), [0x20, 0xD1, 0x04, 4, 3, 2, 1]);
    assert.deepEqual(plain(ctx.encodeOffloadCancel(0)), [0x20, 0xD1, 0x04, 0, 0, 0, 0], 'job 0 stops whatever runs');
    assert.equal(ctx.evaluate('OFFLOAD_STATUS_PROBE_JOB_ID'), 0xFFFFFFFF);
    assert.deepEqual(plain(ctx.encodeOffloadCancel(ctx.evaluate('OFFLOAD_STATUS_PROBE_JOB_ID'))), [0x20, 0xD1, 0x04, 0xFF, 0xFF, 0xFF, 0xFF]);
    // The probe's reply: refused with ESTALE, job fields of the current job.
    const reply = ctx.decodeOffloadJobReply([9, 0, 0, 0, 4, 3, 2, 0, 0, 0x7B, 0xFF, 0xFF, 0xFF, 2, 0, 0, 0]);
    assert.equal(reply.jobId, 9);
    assert.equal(reply.stateLabel, 'sending');
    assert.equal(reply.mediumLabel, 'Bluetooth');
    assert.equal(reply.result, -133);
    assert.match(reply.resultLabel, /does not match/);
    assert.equal(reply.confirmed, 2);
});

test('errno values in the job reply follow newlib (the firmware libc), not Linux', () => {
    const ctx = app();
    // The reply SP051307 gave on 2026-11-06 to 20 CF 03 03 02 00 while it was already streaming:
    // job 2, waiting, Bluetooth, unconfirmed, all ports, result 0xFFFFFF89 = -119.
    const field = ctx.decodeOffloadJobReply([2, 0, 0, 0, 2, 3, 2, 0, 0, 0x89, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]);
    assert.equal(field.result, -119);
    assert.equal(field.stateLabel, 'waiting');
    assert.match(field.resultLabel, /^in progress/);
    const errno = JSON.parse(JSON.stringify(ctx.evaluate('OFFLOAD_ERRNO')));
    assert.equal(errno.EINPROGRESS, -119);
    assert.equal(errno.ESTALE, -133);
    assert.equal(errno.ECANCELED, -140);
    assert.equal(errno.ENOTSUP, -134);
    assert.equal(errno.ENOTCONN, -128);
    assert.equal(errno.ENETDOWN, -115);
    assert.equal(errno.EMSGSIZE, -122);
    assert.equal(errno.EBUSY, -16);
    assert.match(ctx.decodeOffloadJobReply([0, 0, 0, 0, 7, 3, 2, 0, 0, 0x74, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]).resultLabel, /cancelled/);
    assert.match(ctx.decodeOffloadJobReply([0, 0, 0, 0, 7, 0, 2, 0, 3, 0xFA, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]).resultLabel, /no station offered/);
    assert.match(ctx.decodeOffloadJobReply([0, 0, 0, 0, 7, 3, 2, 0, 0, 0x8D, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]).resultLabel, /^firmware error -115|ENETDOWN/, 'the old Linux EINPROGRESS value is not in progress any more');
});

test('the station status rows read the SD card, reader and radio state and never call unknown healthy', () => {
    const ctx = app();
    const plain = value => JSON.parse(JSON.stringify(value));
    const counters = Array.from({ length: 21 }, () => 0);
    counters[0] = 5; counters[1] = 1; counters[6] = 12; counters[9] = 1000; counters[16] = 3;
    const healthy = ctx.decodeLp0StatisticsMessage(statisticsBody({ latest: 0b0000010001100011, known: 0b0001111111111111, uptime: 3600, counters, capacity: 7580, free: 93 }));
    const rows = ctx.describeStationReport(healthy);
    const row = label => plain(rows.find(entry => entry.label === label) || null);
    assert.deepEqual(row('SD card'), { label: 'SD card', value: 'present and writable', level: 'ok' });
    assert.deepEqual(row('SD reader'), { label: 'SD reader', value: 'responding', level: 'ok' });
    assert.deepEqual(row('LP0 radio'), { label: 'LP0 radio', value: 'listening for trackers', level: 'ok' });
    assert.equal(row('Up since boot').value, '1 hour');
    assert.deepEqual(row('Tracker visits'), { label: 'Tracker visits', value: '5 complete, 1 partial, 0 not completed', level: 'muted' });
    assert.deepEqual(row('Records saved to SD'), { label: 'Records saved to SD', value: '12 packets, 1000 bytes', level: 'muted' });
    assert.deepEqual(row('SD space'), { label: 'SD space', value: '7580 MB, 93% free', level: 'muted' });
    assert.deepEqual(row('Storage errors since boot'), { label: 'Storage errors since boot', value: 'none', level: 'ok' });
    assert.equal(row('Reports').value, '3 generated, 0 failed to send');
    assert.ok(!row('Unknown status flags') && !row('Storage queue') && !row('Flash logging'));

    // Card missing, storage fault latched, reader unresponsive, radio fault, queue full, flash off, errors.
    counters[10] = 2; counters[11] = 1; counters[7] = 1; counters[2] = 3;
    const latest = (1 << 11) | (1 << 12) | (1 << 2) | (1 << 8) | (1 << 9) | (1 << 5);
    const known = 0b0001111111111111;
    const faulted = ctx.decodeLp0StatisticsMessage(statisticsBody({ latest, known, uptime: 90, counters, capacity: 7580, free: 4 }));
    const faultRows = ctx.describeStationReport(faulted);
    const faultRow = label => plain(faultRows.find(entry => entry.label === label) || null);
    assert.deepEqual(faultRow('SD card'), { label: 'SD card', value: 'missing', level: 'warn' });
    assert.deepEqual(faultRow('SD reader'), { label: 'SD reader', value: 'not responding', level: 'warn' });
    assert.deepEqual(faultRow('LP0 radio'), { label: 'LP0 radio', value: 'radio fault', level: 'warn' });
    assert.deepEqual(faultRow('Storage queue'), { label: 'Storage queue', value: 'full', level: 'warn' });
    assert.deepEqual(faultRow('Flash logging'), { label: 'Flash logging', value: 'disabled', level: 'warn' });
    assert.deepEqual(faultRow('Tracker visits'), { label: 'Tracker visits', value: '5 complete, 1 partial, 3 not completed', level: 'muted' });
    assert.deepEqual(faultRow('Records saved to SD'), { label: 'Records saved to SD', value: '12 packets, 1000 bytes; 1 failed, 0 dropped', level: 'warn' });
    assert.equal(faultRow('SD space').level, 'warn', 'under 10% free');
    assert.deepEqual(faultRow('Storage errors since boot'), { label: 'Storage errors since boot', value: '2 media, 1 reader', level: 'warn' });

    // Unknown bits: the version 2 report leaves the card-missing and fault bits unknown; nothing known is a muted "unknown".
    const unknown = ctx.decodeLp0StatisticsMessage(statisticsBody({ version: 2, latest: 0, known: 0, counters }));
    const unknownRows = ctx.describeStationReport(unknown);
    const unknownRow = label => plain(unknownRows.find(entry => entry.label === label) || null);
    assert.deepEqual(unknownRow('SD card'), { label: 'SD card', value: 'unknown', level: 'muted' });
    assert.deepEqual(unknownRow('SD reader'), { label: 'SD reader', value: 'unknown', level: 'muted' });
    assert.deepEqual(unknownRow('LP0 radio'), { label: 'LP0 radio', value: 'unknown', level: 'muted' });
    assert.deepEqual(unknownRow('SD space'), { label: 'SD space', value: 'unknown (reader units not qualified yet)', level: 'muted' });
    assert.equal(unknownRow('Unknown status flags').value, '11');
    // A card that is detected but whose write was not checked yet is not called writable.
    const detectedOnly = ctx.decodeLp0StatisticsMessage(statisticsBody({ latest: 0b1, known: 0b1, counters }));
    assert.deepEqual(plain(ctx.describeStationReport(detectedOnly)[0]), { label: 'SD card', value: 'present, write not yet verified', level: 'muted' });
});

// Message keys decoded on the main page (index.html) rather than in functions.js: positions,
// scans, CMDQ, fence, messenger, status and the device timestamp have cards of their own.
const PAGE_DECODED_MESSAGES = ['msg_status', 'msg_ublox_location', 'msg_ublox_location_short', 'msg_ublox_resend_location', 'msg_last_position', 'msg_timestamp',
    'msg_lr_messaging', 'msg_lr_messaging_timestamp', 'msg_ble_cmdq', 'msg_fence', 'msg_wifi_scan', 'msg_wifi_scan_aggregated', 'msg_ble_scan', 'msg_ble_scan_aggregated'];

test('every message in every bundled schema has a decoder, or is on the documented raw-only list', () => {
    const ctx = app();
    const shared = Object.keys(ctx.evaluate('MESSAGE_SUMMARIZERS'));
    const rawOnly = JSON.parse(JSON.stringify(ctx.evaluate('MESSAGES_WITHOUT_DECODER')));
    const covered = new Set([...shared, ...rawOnly, ...PAGE_DECODED_MESSAGES]);
    for (const file of ctx.evaluate('SETTINGS_FILES')) {
        const schema = JSON.parse(fs.readFileSync(path.join(root, 'settings', file), 'utf8'));
        for (const key of Object.keys(schema.messages || {})) {
            assert.ok(covered.has(key), `${key} in ${file} has no decoder: port it from the release's ttn_decoder.js into MESSAGE_SUMMARIZERS (functions.js)`);
        }
    }
    // The raw-only list stays honest: nothing on it has a summarizer, and nothing decoded on the page is listed twice.
    for (const key of rawOnly) {
        assert.ok(!shared.includes(key) && !PAGE_DECODED_MESSAGES.includes(key), `${key} is listed as raw-only but has a decoder`);
    }
});

test('the shared message decoders mirror the firmware TTN decoder layouts', () => {
    const ctx = app();
    const plain = value => JSON.parse(JSON.stringify(value));
    const describe = (key, body) => ctx.describeMessageBody(key, Uint8Array.from(body));
    // Flash status: % used, count u32 LE.
    assert.deepEqual(plain(ctx.decodeFlashStatusMessage([42, 0x10, 0x27, 0, 0])), { usedPercent: 42, messageCount: 10000 });
    assert.equal(describe('msg_flash_status', [42, 0x10, 0x27, 0, 0]), 'Flash 42% used, 10000 messages stored');
    assert.equal(describe('msg_flash_status', [0, 1, 0, 0, 0]), 'Flash 0% used, 1 message stored');
    assert.match(describe('msg_flash_status', [1, 2]), /^Could not decode: Flash status body is 2 bytes/);
    // LR satellites: count, then id/C/N0 pairs.
    assert.deepEqual(plain(ctx.decodeLrSatellitesMessage([3, 12, 34, 7, 20, 25, 41])), { count: 3, satellites: [{ id: 12, cnr: 34 }, { id: 7, cnr: 20 }, { id: 25, cnr: 41 }] });
    assert.equal(describe('msg_lr_satellites', [2, 12, 34, 7, 20]), '2 satellites seen: id 12 (C/N0 34); id 7 (C/N0 20)');
    assert.equal(describe('msg_lr_satellites', [5, 12, 34]), '5 satellites seen (1 reported): id 12 (C/N0 34)', 'a truncated body reports fewer than announced');
    assert.equal(describe('msg_lr_satellites', [0]), '0 satellites seen');
    // u-blox satellites: count, then id, C/N0, elevation, azimuth u16, constellation.
    const ublox = [2, 12, 34, 45, 0x7B, 0x00, 1, 20, 30, 60, 0x2C, 0x01, 4];
    assert.deepEqual(plain(ctx.decodeUbloxSatellitesMessage(ublox)), { count: 2, satellites: [
        { id: 12, cn0: 34, elevation: 45, azimuth: 123, constellation: 'GPS' }, { id: 20, cn0: 30, elevation: 60, azimuth: 300, constellation: 'Galileo' }] });
    assert.equal(describe('msg_ublox_satellites', ublox), '2 satellites seen: GPS 12 (C/N0 34, elevation 45°, azimuth 123°); Galileo 20 (C/N0 30, elevation 60°, azimuth 300°)');
    assert.deepEqual(plain(ctx.describeMessageRows('msg_ublox_satellites', Uint8Array.from(ublox)))[1], { label: 'Galileo 20', value: 'C/N0 30, elevation 60°, azimuth 300°' });
    // GNSS: the NAV payload as hex, first body byte skipped (as in the TTN decoder).
    assert.deepEqual(plain(ctx.decodeGnssMessage([0x01, 0xAB, 0xCD, 0xEF])), { navPayload: 'abcdef' });
    assert.equal(describe('msg_gnss', [0x01, 0xAB, 0xCD, 0xEF]), 'LR1110 GNSS scan, 3-byte NAV payload for the LoRa Cloud solver: abcdef');
    assert.equal(describe('msg_gnss', [0x01]), 'LR1110 GNSS scan without a NAV payload');
    // External switch: activity + duration; status: impulse count when the first byte is 2.
    assert.equal(describe('msg_external_switch_detection', [1, 0xD0, 0x07, 0, 0]), 'External switch active (activity 1) for 2 seconds (2000 ms)');
    assert.equal(describe('msg_external_switch_detection_status', [2, 0x39, 0x30, 0, 0]), 'External switch: 12345 impulses counted');
    assert.equal(describe('msg_external_switch_detection_status', [0, 3, 0, 0, 0]), 'External switch inactive (activity 0), 3 active detections');
    // Air quality: 20 = BME690 only, 25 = BMV080 only, 45 = both (BMV080 first).
    const f32 = value => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value, true); return Array.from(b); };
    const bme = [...f32(52), ...f32(24.3), ...f32(1012.4), ...f32(41.2), ...f32(123456)];
    const bmv = [...f32(3.2), ...f32(1.1), ...f32(4), ...f32(12), ...f32(10), ...f32(13), 1];
    assert.equal(describe('msg_air_quality', bme), 'Air quality: IAQ 52, 24.3 °C, 41.2 % RH, 1012.4 hPa, raw gas 123456');
    assert.equal(describe('msg_air_quality', bmv), 'Air quality: PM1/PM2.5/PM10 1.1/3.2/4 µg/m³, 10/12/13 particles/cm³, sensor obstructed');
    const both = ctx.decodeAirQualityMessage(Uint8Array.from([...bmv, ...bme]));
    assert.equal(plain(both).bme690.humidity.toFixed(1), '41.2');
    assert.equal(plain(both).bmv080.pm10Mass, 4);
    assert.equal(ctx.describeMessageRows('msg_air_quality', Uint8Array.from([...bmv, ...bme])).length, 12);
    assert.match(describe('msg_air_quality', [1, 2, 3]), /^Could not decode: Air quality body is 3 bytes/);
    // Memfault chunks are opaque; the LP0 statistics summary is shared too; unknown keys give null.
    assert.match(describe('msg_memfault_chunks', new Array(40).fill(7)), /^Memfault diagnostics chunk, 40 bytes/);
    assert.match(describe('msg_lp0_statistics', Array.from(statisticsBody({ uptime: 60, counters: new Array(21).fill(0) }))), /^Station statistics v3; up 1 minute/);
    assert.equal(ctx.describeMessageBody('msg_status', [1, 2, 3]), null);
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

test('every setting survives an encode/decode round trip in both schema generations', async () => {
    for (const file of [v8, v7]) {
        const ctx = app();
        await ctx.loadSettingsMeta();
        await ctx.loadSettings(file);
        const settings = ctx.evaluate('settingsData.settings');
        let checked = 0;
        for (const key of Object.keys(settings)) {
            const setting = settings[key];
            if (setting.length === 0) continue;
            // Inputs hold byte arrays as bare hex (the renderer strips the {0x..} notation).
            const rendered = ctx.normalizeRenderableValue(setting.default);
            const value = setting.conversion === 'byte_array' ? ctx.stripBytes(rendered) : rendered;
            const bytes = ctx.settingToBytes(key, setting, value);
            if (setting.conversion === 'string') {
                assert.ok(bytes.length <= setting.length, `${file}: ${key} encodes to at most ${setting.length} bytes`);
            } else {
                assert.equal(bytes.length, setting.length, `${file}: ${key} encodes to ${setting.length} bytes`);
            }
            const decoded = ctx.bytesToSetting(setting, bytes);
            assert.ok(ctx.isSettingValueEqual(key, setting, decoded, value), `${file}: ${key} round-trips (${value} -> ${decoded})`);
            checked += 1;
        }
        assert.ok(checked > 100, `${file}: ${checked} settings checked`);
    }
});

test('export-style values re-import as equal for PIN, MAC, coordinates and byte arrays', async () => {
    const ctx = app();
    await ctx.loadSettingsMeta();
    await ctx.loadSettings(v8);
    const settings = ctx.evaluate('settingsData.settings');
    const pin = settings.device_pin;
    const pinRaw = '01020304';
    assert.equal(ctx.formatDevicePinForDisplay(pinRaw), '1234');
    assert.ok(ctx.isSettingValueEqual('device_pin', pin, pinRaw, '1234'), 'PIN digits from an export match the raw storage form');
    const mac = settings.cmdq_searched_mac_address;
    assert.ok(ctx.isSettingValueEqual('cmdq_searched_mac_address', mac, 'D81068ACDAE4', 'd8:10:68:ac:da:e4'), 'MAC with separators matches raw hex');
    const lat = settings.gps_init_lat;
    assert.ok(ctx.isSettingValueEqual('gps_init_lat', lat, '465556280', 465556280), 'numeric export value matches the raw string');
    const weights = settings.outdoor_detection_parameters;
    const raw = 'CBEC6B122A13790F201C0000';
    assert.ok(ctx.isSettingValueEqual('outdoor_detection_parameters', weights, raw, raw.toLowerCase()), 'byte arrays compare case-insensitively');
});

test('exported values keep booleans the device reported as real booleans', async () => {
    const ctx = app();
    await ctx.loadSettingsMeta();
    await ctx.loadSettings(v8);
    const settings = ctx.evaluate('settingsData.settings');
    const led = settings.led_enabled;
    // Device values are typed (bytesToSetting), input values are strings: both must export alike.
    assert.equal(ctx.bytesToSetting(led, [1]), true);
    assert.equal(ctx.exportSettingValue('led_enabled', led, true), true, 'boolean true from the device');
    assert.equal(ctx.exportSettingValue('led_enabled', led, 'true'), true, 'string true from an input');
    assert.equal(ctx.exportSettingValue('led_enabled', led, 1), true);
    assert.equal(ctx.exportSettingValue('led_enabled', led, false), false);
    assert.equal(ctx.exportSettingValue('led_enabled', led, 'false'), false);
    assert.equal(ctx.exportSettingValue('status_send_interval', settings.status_send_interval, 3600), 3600);
    assert.equal(ctx.exportSettingValue('status_send_interval', settings.status_send_interval, '3600'), 3600);
    assert.equal(ctx.exportSettingValue('device_pin', settings.device_pin, '01020304'), '1234');
    assert.equal(ctx.exportSettingValue('app_key', settings.app_key, '{0x01, 0x02}'), '0102');
    assert.equal(ctx.exportSettingValue('device_name', settings.device_name, 'SP051307'), 'SP051307');
    // A value exported from a device boolean re-imports as unchanged on a device with the same value.
    assert.ok(ctx.isSettingValueEqual('led_enabled', led, true, ctx.exportSettingValue('led_enabled', led, true)));
});
