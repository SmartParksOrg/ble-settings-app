const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const CBOR = require(path.join(root, 'dfu/cbor.js'));

function loadMcuManager() {
    const source = fs.readFileSync(path.join(root, 'dfu/mcumgr.js'), 'utf8');
    const factory = new Function('CBOR', 'module', 'crypto', `${source}\nreturn MCUManager;`);
    return factory(CBOR, { exports: {} }, globalThis.crypto);
}

const silent = { info() {}, error() {} };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeCharacteristic({ failWrites = 0 } = {}) {
    let failures = failWrites;
    const listeners = new Map();
    return {
        writes: [],
        async writeValueWithoutResponse(value) {
            if (failures > 0) {
                failures -= 1;
                throw new Error('GATT operation failed for unknown reason.');
            }
            this.writes.push(new Uint8Array(value));
        },
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
        async startNotifications() {},
        emit(bytes) {
            const fn = listeners.get('characteristicvaluechanged');
            fn({ target: { value: new DataView(Uint8Array.from(bytes).buffer) } });
        },
        listenerCount() { return listeners.size; },
    };
}

function smpFrame(op, group, id, seq, data) {
    const payload = new Uint8Array(CBOR.encode(data));
    return [op, 0, payload.length >> 8, payload.length & 255, group >> 8, group & 255, seq, id, ...payload];
}

function fakeDevice({ failConnects = 0 } = {}) {
    let failures = failConnects;
    const characteristic = fakeCharacteristic();
    const listeners = [];
    const gatt = {
        connected: false,
        async connect() {
            if (failures > 0) {
                failures -= 1;
                throw new Error('NetworkError: Connection attempt failed.');
            }
            this.connected = true;
            return this;
        },
        async getPrimaryService() {
            return { async getCharacteristic() { return characteristic; } };
        },
    };
    return {
        name: 'SP-TEST',
        gatt,
        characteristic,
        listeners,
        addEventListener(type, fn) { listeners.push(fn); },
        removeEventListener(type, fn) {
            const index = listeners.indexOf(fn);
            if (index >= 0) listeners.splice(index, 1);
        },
    };
}

async function syntheticImage(size = 300, version = [1, 2, 3]) {
    const header = new Uint8Array(32);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x96f3b83d, true);
    view.setUint32(4, 0, true);
    view.setUint16(8, 32, true);
    view.setUint16(10, 0, true);
    view.setUint32(12, size, true);
    view.setUint32(16, 0, true);
    view.setUint8(20, version[0]);
    view.setUint8(21, version[1]);
    view.setUint16(22, version[2], true);
    const body = new Uint8Array(size).map((_, i) => i & 255);
    const hashed = new Uint8Array([...header, ...body]);
    const sha = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', hashed));
    const tlv = new Uint8Array(4 + 4 + 32);
    const tlvView = new DataView(tlv.buffer);
    tlvView.setUint16(0, 0x6907, true);
    tlvView.setUint16(2, tlv.length, true);
    tlvView.setUint16(4, 16, true);
    tlvView.setUint16(6, 32, true);
    tlv.set(sha, 8);
    return { buffer: new Uint8Array([...hashed, ...tlv]).buffer, sha };
}

test('a rejected GATT write does not poison later writes', async () => {
    const MCUManager = loadMcuManager();
    const manager = new MCUManager({ logger: silent });
    const characteristic = fakeCharacteristic({ failWrites: 1 });
    manager._characteristic = characteristic;
    await assert.rejects(manager.cmdImageState(), /GATT operation failed/);
    await manager.cmdImageState();
    assert.equal(characteristic.writes.length, 1);
});

test('rejected chunk writes are retried, the MTU steps down, and acks advance the upload', async () => {
    const MCUManager = loadMcuManager();
    const manager = new MCUManager({ mtu: 240, chunkTimeout: 60000, logger: silent });
    const characteristic = fakeCharacteristic({ failWrites: 2 });
    manager._characteristic = characteristic;
    const errors = [];
    manager.onImageUploadError(error => errors.push(error));
    manager.onImageUploadProgress(() => {});
    const acks = [];
    manager.onImageUploadChunkAck(ack => acks.push(ack.off));
    try {
        await manager.cmdUpload(new Uint8Array(1000).buffer);
        await wait(1200);
        assert.deepEqual(errors, []);
        assert.equal(characteristic.writes.length, 1, 'first chunk written after two retries');
        assert.equal(manager.getMtu(), 200, 'MTU stepped down after the second rejection');
        assert.ok(characteristic.writes[0].length <= 200);
        const first = CBOR.decode(characteristic.writes[0].slice(8).buffer);
        assert.equal(first.off, 0);
        assert.equal(first.len, 1000);
        assert.equal(first.sha.length, 32);
        const dataLength = first.data.byteLength ?? first.data.length;
        manager._notification({ target: { value: new DataView(Uint8Array.from(smpFrame(3, 1, 1, 0, { rc: 0, off: dataLength })).buffer) } });
        await wait(50);
        assert.deepEqual(acks, [dataLength]);
        assert.equal(characteristic.writes.length, 2, 'ack triggers the next chunk');
        assert.equal(manager._writeRetries, 0, 'ack resets the write retry counter');
        const second = CBOR.decode(characteristic.writes[1].slice(8).buffer);
        assert.equal(second.off, dataLength);
        assert.equal(second.sha, undefined);
    } finally {
        manager.cancelUpload();
    }
});

test('imageInfo validates length, magic, version, and hash TLV', async () => {
    const MCUManager = loadMcuManager();
    const manager = new MCUManager({ logger: silent });
    await assert.rejects(manager.imageInfo(new ArrayBuffer(10)), /too short/);
    await assert.rejects(manager.imageInfo(new ArrayBuffer(64)), /magic/);
    const { buffer, sha } = await syntheticImage(300, [8, 0, 1]);
    const info = await manager.imageInfo(buffer);
    assert.equal(info.version, '8.0.1');
    assert.equal(info.imageSize, 300);
    assert.equal(info.hashValid, true);
    assert.equal(info.hash, Array.from(sha, b => b.toString(16).padStart(2, '0')).join(''));
    const corrupted = new Uint8Array(buffer.slice(0));
    corrupted[40] ^= 0xff;
    const bad = await manager.imageInfo(corrupted.buffer);
    assert.equal(bad.hashValid, false);
    await assert.rejects(manager.imageInfo(buffer.slice(0, 200)), /wrong image size/);
});

test('attachDevice rejects on failure without firing disconnect, and never duplicates listeners', async () => {
    const MCUManager = loadMcuManager();
    const manager = new MCUManager({ logger: silent, autoReconnect: false });
    const connects = [];
    const disconnects = [];
    manager.onConnect(() => connects.push(Date.now()));
    manager.onDisconnect(error => disconnects.push(error));
    const device = fakeDevice({ failConnects: 2 });
    await assert.rejects(manager.attachDevice(device), /Connection attempt failed/);
    await assert.rejects(manager.attachDevice(device), /Connection attempt failed/);
    assert.deepEqual(disconnects, [], 'failed attempts do not fire the disconnect callback');
    await manager.attachDevice(device);
    assert.equal(connects.length, 1);
    assert.equal(device.listeners.length, 1);
    assert.equal(device.characteristic.listenerCount(), 1);
    device.gatt.connected = false;
    await manager.attachDevice(device);
    assert.equal(connects.length, 2);
    assert.equal(device.listeners.length, 1, 'disconnect listener registered once per device');
    assert.equal(device.characteristic.listenerCount(), 1, 'notification listener registered once');
    device.listeners[0]();
    assert.equal(disconnects.length, 1, 'a real GATT disconnect still reaches the callback');
});
