// Offline-first service worker.
//
// The app must open instantly with no internet or a bad connection (2G in the field), so every
// same-origin file is served from the cache first and the network is only used for files that
// are not cached yet. Updates arrive through this file: a deploy changes CACHE_NAME (the deploy
// workflow stamps the commit into it), the browser installs the new worker, the install fetches
// every app file fresh into a new cache, and the page reloads once the new worker is in control.
// A slow link therefore never delays an open; it only delays the next update.
//
// The bundled DFU binaries (34 MB) are not downloaded during install: the install copies the
// ones the previous cache already holds, and the missing ones are fetched one by one in the
// background when a page asks (PRECACHE_DFU), so a failed download costs one file, not the set,
// and a deploy does not download the binaries again.
const CACHE_NAME = 'app-cache-v68'; // the deploy workflow replaces this line with the commit
const BASE_URL = new URL(self.registration.scope);
const toUrl = (path) => new URL(path, BASE_URL).toString();
const DFU_MANIFEST_URL = toUrl('assets/dfu/manifest.json');
const DFU_RELEASES_PREFIX = toUrl('assets/dfu/releases/');
const CROSS_ORIGIN_CACHED_HOSTS = ['unpkg.com']; // the map library; tiles stay network only
const STATIC_FILES = [
    toUrl('./'),
    toUrl('index.html'),
    toUrl('composer.html'),
    toUrl('style.css'),
    toUrl('hardware-types.js'),
    toUrl('device-icons.js'),
    toUrl('functions.js'),
    toUrl('panels/panel-engine.js'),
    toUrl('panels/panel-definitions.js'),
    toUrl('panels/panel-renderer.js'),
    toUrl('dfu/dfu.js'),
    toUrl('dfu/cbor.js'),
    toUrl('dfu/mcumgr.js'),
    toUrl('manifest.json'),
    toUrl('composer-manifest.json'),
    toUrl('version.json'),
    toUrl('settings-meta.json'),
    toUrl('device-version-notes.json'),
    toUrl('favicon.ico'),
    toUrl('icon512_maskable.png'),
    toUrl('icon512_rounded.png'),
    toUrl('assets/smart-parks-logo.png'),
    toUrl('assets/dfu/manifest.json'),
    toUrl('settings/settings-v8.1.0.json'),
    toUrl('settings/settings-v8.0.3.json'),
    toUrl('settings/settings-v8.0.2.json'),
    toUrl('settings/settings-v8.0.1.json'),
    toUrl('settings/settings-v8.0.0.json'),
    toUrl('settings/settings-v7.2.0.json'),
    toUrl('settings/settings_v7.0.0.json'),
    toUrl('settings/settings-v7.1.0.json'),
    toUrl('settings/settings-v5.0.1.json'),
    toUrl('settings/settings-v6.15.0.json'),
    toUrl('settings/settings-v6.14.1.json'),
    toUrl('settings/settings-v6.12.1.json'),
    toUrl('settings/settings-v6.11.0.json'),
    toUrl('settings/settings-v6.10.0.json'),
    toUrl('settings/settings-v6.9.0.json'),
    toUrl('settings/settings-v6.8.1.json'),
    toUrl('settings/settings-v4.4.2.json'),
];

async function readDfuPaths(cache) {
    const cached = await cache.match(DFU_MANIFEST_URL);
    const response = cached || await fetch(DFU_MANIFEST_URL);
    if (!response || !response.ok) {
        throw new Error(`Manifest fetch failed: ${response ? response.status : 'no response'}`);
    }
    if (!cached) {
        await cache.put(DFU_MANIFEST_URL, response.clone());
    }
    const manifest = await response.json();
    const releases = Array.isArray(manifest?.releases) ? manifest.releases : [];
    const files = releases.flatMap(release => Array.isArray(release?.files) ? release.files : []);
    return files.map(file => file?.path).filter(Boolean).map(path => toUrl(path));
}

// A new cache starts with the DFU binaries the previous caches already hold: their paths carry
// the firmware version, so a cached copy is never stale, and the previous cache is deleted on
// activation.
async function copyDfuFilesFromOldCaches(cache) {
    const wanted = new Set(await readDfuPaths(cache));
    const oldNames = (await caches.keys()).filter(name => name !== CACHE_NAME);
    let copied = 0;
    for (const name of oldNames) {
        const old = await caches.open(name);
        for (const request of await old.keys()) {
            if (!wanted.has(request.url) || await cache.match(request.url)) {
                continue;
            }
            const response = await old.match(request);
            if (response) {
                await cache.put(request.url, response);
                copied += 1;
            }
        }
    }
    return copied;
}

let dfuFill = null;

// Fetches the bundled DFU binaries that are not cached yet, one at a time, and stops at the
// first network failure (the next PRECACHE_DFU request resumes where it stopped). Returns the
// count of cached and total binaries.
function fillDfuCache() {
    if (dfuFill) {
        return dfuFill;
    }
    dfuFill = (async () => {
        const cache = await caches.open(CACHE_NAME);
        const paths = await readDfuPaths(cache);
        let cached = 0;
        let stopped = false;
        for (const url of paths) {
            if (await cache.match(url)) {
                cached += 1;
                continue;
            }
            if (stopped) {
                continue;
            }
            try {
                const response = await fetch(url);
                if (response && response.ok) {
                    await cache.put(url, response);
                    cached += 1;
                } else {
                    console.warn('DFU file not available', url, response && response.status);
                }
            } catch (error) {
                console.warn('DFU precache stopped (offline?)', url, error);
                stopped = true;
            }
        }
        return { cached, total: paths.length, complete: cached === paths.length };
    })().finally(() => {
        dfuFill = null;
    });
    return dfuFill;
}

async function broadcast(message) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach(client => client.postMessage(message));
}

const INSTALL_ATTEMPTS = 3;
const INSTALL_PARALLEL = 4;
const INSTALL_RETRY_DELAY_MS = 1500;

// Fetches one app file fresh (bypassing the HTTP cache, so a new worker never installs a stale
// page), retrying a few times so one dropped request on a lossy link does not fail the install.
async function fetchFresh(url) {
    let lastError = null;
    for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(new Request(url, { cache: 'reload' }));
            if (response && response.ok) {
                return response;
            }
            lastError = new Error(`HTTP ${response ? response.status : 'no response'}`);
        } catch (error) {
            lastError = error;
        }
        if (attempt < INSTALL_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, INSTALL_RETRY_DELAY_MS));
        }
    }
    throw new Error(`${url}: ${lastError && lastError.message}`);
}

// A few files at a time: a 2G link is better served by a short queue than by 45 parallel
// requests. Every file must arrive, or the install fails and the previous worker keeps serving.
async function cacheAppFiles(cache) {
    const queue = STATIC_FILES.slice();
    const workers = Array.from({ length: INSTALL_PARALLEL }, async () => {
        while (queue.length) {
            const url = queue.shift();
            await cache.put(url, await fetchFresh(url));
        }
    });
    await Promise.all(workers);
}

// Install: every app file fresh from the network, then the DFU binaries the previous cache
// already had.
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async cache => {
            console.log(`Caching app files into ${CACHE_NAME}`);
            await cacheAppFiles(cache);
            try {
                const copied = await copyDfuFilesFromOldCaches(cache);
                if (copied) {
                    console.log(`Copied ${copied} DFU files from the previous cache`);
                }
            } catch (error) {
                console.warn('Could not copy DFU files from the previous cache', error);
            }
        })
    );
    self.skipWaiting();
});

async function clearOldCaches() {
    const cacheNames = await caches.keys();
    await Promise.all(
        cacheNames.map(cache => {
            if (cache !== CACHE_NAME) {
                console.log('Deleting old cache:', cache);
                return caches.delete(cache);
            }
            return Promise.resolve();
        })
    );
}

// Activate: drop the previous cache and take control of open tabs. The DFU fill starts in the
// background; the pages ask for it again on every open, so a fill the browser interrupts is
// resumed.
self.addEventListener('activate', event => {
    event.waitUntil(
        clearOldCaches().then(() => self.clients.claim())
    );
    fillDfuCache().then(status => broadcast({ type: 'DFU_CACHE_STATUS', ...status })).catch(() => null);
});

self.addEventListener('message', event => {
    if (!event.data) {
        return;
    }
    if (event.data.type === 'SKIP_WAITING') {
        event.waitUntil(self.skipWaiting());
    } else if (event.data.type === 'PRECACHE_DFU') {
        event.waitUntil(
            fillDfuCache()
                .then(status => broadcast({ type: 'DFU_CACHE_STATUS', ...status }))
                .catch(error => console.warn('DFU precache failed', error))
        );
    }
});

function isCachedCrossOrigin(url) {
    return CROSS_ORIGIN_CACHED_HOSTS.includes(url.hostname);
}

// Cache first: a cached file is returned at once, whatever the network is doing. Only a file
// that is not cached yet goes to the network, and a good response is kept for next time.
async function cacheFirst(request) {
    const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) {
        return cached;
    }
    const response = await fetch(request);
    if (response && response.ok && response.type !== 'opaque') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone()).catch(error => console.warn('Cache put failed', request.url, error));
    }
    return response;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') {
        return;
    }
    const url = new URL(request.url);
    if (url.origin === self.location.origin || isCachedCrossOrigin(url)) {
        event.respondWith(cacheFirst(request));
    }
    // Everything else (map tiles) goes straight to the network and is never cached.
});
