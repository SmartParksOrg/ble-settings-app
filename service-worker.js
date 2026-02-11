const CACHE_NAME = 'app-cache-v10';
const BASE_URL = new URL(self.registration.scope);
const toUrl = (path) => new URL(path, BASE_URL).toString();
const DFU_MANIFEST_URL = toUrl('assets/dfu/manifest.json');
const STATIC_FILES = [
    toUrl('./'),
    toUrl('index.html'),
    toUrl('composer.html'),
    toUrl('style.css'),
    toUrl('hardware-types.js'),
    toUrl('functions.js'),
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

async function cacheBundledDfuFiles(cache) {
    try {
        const response = await fetch(DFU_MANIFEST_URL, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Manifest fetch failed: ${response.status}`);
        }
        const manifest = await response.json();
        const releases = Array.isArray(manifest?.releases) ? manifest.releases : [];
        const files = releases.flatMap(release => Array.isArray(release?.files) ? release.files : []);
        const paths = files.map(file => file?.path).filter(Boolean);
        if (paths.length) {
            await cache.addAll(paths.map(path => toUrl(path)));
        }
    } catch (error) {
        console.warn('Failed to cache bundled DFU files', error);
    }
}

// Install Event: Cache all static files
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async cache => {
            console.log('Caching static files');
            await cache.addAll(STATIC_FILES);
            await cacheBundledDfuFiles(cache);
        })
    );
    self.skipWaiting();
});

// Activate Event: Cleanup old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        console.log('Deleting old cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
});

// Fetch Event: Network first, fallback to cache
self.addEventListener('fetch', event => {
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache the updated file
                return caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, response.clone());
                    return response;
                });
            })
            .catch(() => {
                // Fallback to cache if the network fails
                return caches.match(event.request);
            })
    );
});
