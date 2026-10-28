// The service worker must open the app from its cache whatever the network does: cache first
// for app files, a fresh install of every app file per deploy, DFU binaries carried over from
// the previous cache and filled one by one in the background. Runs the worker in a vm context
// with a small in-memory Cache API and a scripted fetch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const SCOPE = 'https://example.org/app/';
const MANIFEST = {
    releases: [{ releaseId: 'r', files: [
        { path: 'assets/dfu/releases/r/a.bin' },
        { path: 'assets/dfu/releases/r/b.bin' },
        { path: 'assets/dfu/releases/r/c.bin' },
    ] }],
};

class FakeResponse {
    constructor(body, { ok = true, status = 200, type = 'basic' } = {}) {
        this.body = body; this.ok = ok; this.status = status; this.type = type;
    }
    clone() { return new FakeResponse(this.body, this); }
    async json() { return JSON.parse(this.body); }
}
class FakeRequest {
    constructor(url, init = {}) { this.url = typeof url === 'string' ? url : url.url; this.mode = init.mode || 'cors'; this.cache = init.cache || 'default'; this.method = init.method || 'GET'; }
}
class FakeCache {
    constructor() { this.store = new Map(); }
    key(request) { return typeof request === 'string' ? request : request.url; }
    async match(request, options = {}) {
        const strip = url => (options.ignoreSearch ? url.split('?')[0] : url);
        const wanted = strip(this.key(request));
        for (const [url, response] of this.store) if (strip(url) === wanted) return response;
        return undefined;
    }
    async put(request, response) { this.store.set(this.key(request), response); }
    async keys() { return Array.from(this.store.keys()).map(url => new FakeRequest(url)); }
    async addAll(requests) {
        for (const request of requests) {
            const response = await this.fetch(request);
            if (!response || !response.ok) throw new TypeError(`addAll failed for ${request.url}`);
            this.store.set(request.url, response);
        }
    }
}

function worker({ network = {}, oldCaches = {} } = {}) {
    const caches = new Map();
    const fetched = [];
    const fetch = async (request, init) => {
        const url = typeof request === 'string' ? request : request.url;
        fetched.push({ url, cache: (typeof request === 'string' ? init && init.cache : request.cache) || 'default' });
        const answer = network[url] === undefined ? network['*'] : network[url];
        if (answer instanceof Error) throw answer;
        if (answer === undefined) throw new TypeError('offline');
        const value = typeof answer === 'function' ? answer() : answer;
        if (value instanceof Error) throw value;
        return value instanceof FakeResponse ? value : new FakeResponse(value);
    };
    const cacheStorage = {
        async open(name) { if (!caches.has(name)) { const c = new FakeCache(); c.fetch = fetch; caches.set(name, c); } return caches.get(name); },
        async keys() { return Array.from(caches.keys()); },
        async delete(name) { return caches.delete(name); },
        async match(request, options) {
            for (const cache of caches.values()) { const hit = await cache.match(request, options); if (hit) return hit; }
            return undefined;
        },
    };
    for (const [name, entries] of Object.entries(oldCaches)) {
        const cache = new FakeCache(); cache.fetch = fetch; caches.set(name, cache);
        for (const [url, body] of Object.entries(entries)) cache.store.set(url, new FakeResponse(body));
    }
    const listeners = {};
    const posted = [];
    const self = {
        registration: { scope: SCOPE },
        location: { origin: new URL(SCOPE).origin },
        clients: { async claim() { self.claimed = true; }, async matchAll() { return [{ postMessage: m => posted.push(m) }]; } },
        skipWaiting: async () => { self.skipped = true; },
        addEventListener: (name, fn) => { listeners[name] = fn; },
    };
    const context = vm.createContext({ self, caches: cacheStorage, fetch, Request: FakeRequest, Response: FakeResponse, URL, console: { log() {}, warn() {} }, setTimeout: fn => fn() });
    vm.runInContext(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), context);
    const cacheName = vm.runInContext('CACHE_NAME', context);
    const dispatch = async (name, extra = {}) => {
        const waits = [];
        const event = { waitUntil: p => waits.push(p), ...extra };
        let responded = null;
        event.respondWith = p => { responded = p; };
        listeners[name](event);
        await Promise.all(waits);
        return responded;
    };
    return { caches, cacheName, fetched, posted, dispatch, self };
}

const plain = value => JSON.parse(JSON.stringify(value)); // vm objects have another realm's prototypes
const manifestNetwork = { [`${SCOPE}assets/dfu/manifest.json`]: JSON.stringify(MANIFEST) };

test('the cache name follows the pattern the deploy workflow stamps', () => {
    const source = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
    assert.match(source, /^const CACHE_NAME = 'app-cache-[a-z0-9]+';/m);
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-pages.yml'), 'utf8');
    assert.match(workflow, /sed -i "s\/\^const CACHE_NAME = '\[\^'\]\*';\/const CACHE_NAME = 'app-cache-\$\{GITHUB_SHA::7\}';\/" service-worker\.js/);
});

test('install fetches every app file fresh and does not download the DFU binaries', async () => {
    const w = worker({ network: { '*': 'file', ...manifestNetwork } });
    await w.dispatch('install');
    const cache = w.caches.get(w.cacheName);
    assert.ok(await cache.match(`${SCOPE}index.html`));
    assert.ok(await cache.match(`${SCOPE}functions.js`));
    assert.ok(await cache.match(`${SCOPE}settings/settings-v8.1.0.json`));
    assert.ok(w.fetched.every(f => f.cache === 'reload' || f.url.endsWith('manifest.json')), 'app files bypass the HTTP cache');
    assert.equal(w.fetched.filter(f => f.url.includes('/releases/')).length, 0);
    assert.ok(w.self.skipped);
});

test('install copies the DFU binaries the previous cache holds, dropping ones no longer in the manifest', async () => {
    const w = worker({
        network: { '*': 'file', ...manifestNetwork },
        oldCaches: { 'app-cache-old': { [`${SCOPE}assets/dfu/releases/r/a.bin`]: 'A', [`${SCOPE}assets/dfu/releases/gone/z.bin`]: 'Z', [`${SCOPE}index.html`]: 'stale page' } },
    });
    await w.dispatch('install');
    const cache = w.caches.get(w.cacheName);
    assert.equal((await cache.match(`${SCOPE}assets/dfu/releases/r/a.bin`)).body, 'A');
    assert.equal(await cache.match(`${SCOPE}assets/dfu/releases/gone/z.bin`), undefined);
    assert.equal((await cache.match(`${SCOPE}index.html`)).body, 'file', 'app files come from the network, not the old cache');
    await w.dispatch('activate');
    assert.deepEqual(Array.from(w.caches.keys()), [w.cacheName]);
    assert.ok(w.self.claimed);
});

test('a file that keeps failing fails the install, so the previous worker keeps serving', async () => {
    const w = worker({ network: { '*': 'file', [`${SCOPE}style.css`]: new FakeResponse('', { ok: false, status: 404 }) } });
    await assert.rejects(w.dispatch('install'), /style\.css: HTTP 404/);
    assert.equal(w.fetched.filter(f => f.url.endsWith('/style.css')).length, 3, 'three attempts per file');
});

test('a dropped request is retried and the install succeeds, a few files at a time', async () => {
    let drops = 2;
    let inFlight = 0, peak = 0;
    const network = { '*': () => { inFlight += 1; peak = Math.max(peak, inFlight); inFlight -= 1; return 'file'; },
        [`${SCOPE}functions.js`]: () => { if (drops > 0) { drops -= 1; return new TypeError('network dropped'); } return 'file'; } };
    const w = worker({ network });
    network[`${SCOPE}assets/dfu/manifest.json`] = JSON.stringify(MANIFEST);
    await w.dispatch('install');
    assert.equal((await w.caches.get(w.cacheName).match(`${SCOPE}functions.js`)).body, 'file');
    assert.equal(w.fetched.filter(f => f.url.endsWith('/functions.js')).length, 3);
    assert.ok(peak <= 4, `at most four requests in flight, saw ${peak}`);
});

test('the DFU fill fetches missing binaries one at a time, stops at a network failure and resumes later', async () => {
    const network = { '*': 'file', ...manifestNetwork, [`${SCOPE}assets/dfu/releases/r/b.bin`]: new TypeError('offline') };
    const w = worker({ network });
    await w.dispatch('install');
    await w.dispatch('message', { data: { type: 'PRECACHE_DFU' } });
    const cache = w.caches.get(w.cacheName);
    assert.ok(await cache.match(`${SCOPE}assets/dfu/releases/r/a.bin`));
    assert.equal(await cache.match(`${SCOPE}assets/dfu/releases/r/b.bin`), undefined);
    assert.equal(await cache.match(`${SCOPE}assets/dfu/releases/r/c.bin`), undefined, 'nothing after the failure is tried');
    assert.deepEqual(plain(w.posted.at(-1)), { type: 'DFU_CACHE_STATUS', cached: 1, total: 3, complete: false });
    network[`${SCOPE}assets/dfu/releases/r/b.bin`] = 'B';
    await w.dispatch('message', { data: { type: 'PRECACHE_DFU' } });
    assert.deepEqual(plain(w.posted.at(-1)), { type: 'DFU_CACHE_STATUS', cached: 3, total: 3, complete: true });
    assert.equal(w.fetched.filter(f => f.url.endsWith('/a.bin')).length, 1, 'a cached binary is not fetched again');
});

test('app files are answered from the cache without touching the network, misses are fetched and kept', async () => {
    const w = worker({ network: { '*': 'file', ...manifestNetwork } });
    await w.dispatch('install');
    w.fetched.length = 0;
    const page = await w.dispatch('fetch', { request: new FakeRequest(`${SCOPE}index.html?x=1`, { mode: 'navigate' }) });
    assert.equal((await page).body, 'file');
    const script = await w.dispatch('fetch', { request: new FakeRequest(`${SCOPE}functions.js`) });
    assert.equal((await script).body, 'file');
    assert.equal(w.fetched.length, 0, 'cached files never wait for the network');
    const miss = await w.dispatch('fetch', { request: new FakeRequest(`${SCOPE}assets/dfu/releases/r/a.bin`) });
    assert.equal((await miss).body, 'file');
    assert.equal(w.fetched.length, 1);
    assert.ok(await w.caches.get(w.cacheName).match(`${SCOPE}assets/dfu/releases/r/a.bin`));
    const tile = await w.dispatch('fetch', { request: new FakeRequest('https://a.tile.openstreetmap.org/1/2/3.png') });
    assert.equal(tile, null, 'map tiles are left to the browser');
    const leaflet = await w.dispatch('fetch', { request: new FakeRequest('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js') });
    assert.equal((await leaflet).body, 'file', 'the map library is cached like an app file');
    assert.equal(await w.dispatch('fetch', { request: new FakeRequest(`${SCOPE}x`, { method: 'POST' }) }), null);
});

test('the cache-first match ignores a query string only for navigations', async () => {
    const w = worker({ network: { '*': 'file', ...manifestNetwork } });
    await w.dispatch('install');
    w.fetched.length = 0;
    await w.dispatch('fetch', { request: new FakeRequest(`${SCOPE}functions.js?v=2`) });
    assert.equal(w.fetched.length, 1, 'a changed asset URL is a different file');
});
