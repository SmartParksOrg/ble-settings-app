const CACHE_NAME = 'app-cache-v1';
const STATIC_FILES = [
    '/ble-settings-app/', // for index.html
    '/ble-settings-app/index.html',
    '/ble-settings-app/composer.html',
    '/ble-settings-app/style.css',
    '/ble-settings-app/functions.js',
    '/ble-settings-app/manifest.json',
    '/ble-settings-app/composer-manifest.json',
    '/ble-settings-app/settings/settings-v6.14.1.json',
    '/ble-settings-app/settings/settings-v6.12.1.json',
    '/ble-settings-app/settings/settings-v6.11.0.json',
    '/ble-settings-app/settings/settings-v6.10.0.json',
    '/ble-settings-app/settings/settings-v6.9.0.json',
    '/ble-settings-app/settings/settings-v6.8.1.json',
    '/ble-settings-app/settings/settings-v4.4.2.json',
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
