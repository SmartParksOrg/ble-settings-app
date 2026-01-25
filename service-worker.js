const CACHE_NAME = 'app-cache-v2';
const BASE_URL = new URL(self.registration.scope);
const toUrl = (path) => new URL(path, BASE_URL).toString();
const STATIC_FILES = [
    toUrl('./'),
    toUrl('index.html'),
    toUrl('composer.html'),
    toUrl('style.css'),
    toUrl('functions.js'),
    toUrl('manifest.json'),
    toUrl('composer-manifest.json'),
    toUrl('favicon.ico'),
    toUrl('icon512_maskable.png'),
    toUrl('icon512_rounded.png'),
    toUrl('assets/smart-parks-logo.png'),
    toUrl('settings/settings_testing_1.json'),
    toUrl('settings/settings-v6.15.0.json'),
    toUrl('settings/settings-v6.14.1.json'),
    toUrl('settings/settings-v6.12.1.json'),
    toUrl('settings/settings-v6.11.0.json'),
    toUrl('settings/settings-v6.10.0.json'),
    toUrl('settings/settings-v6.9.0.json'),
    toUrl('settings/settings-v6.8.1.json'),
    toUrl('settings/settings-v4.4.2.json'),
];

// Install Event: Cache all static files
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Caching static files');
            return cache.addAll(STATIC_FILES);
        })
    );
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
