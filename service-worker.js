const CACHE_NAME = 'app-cache-v1';
const STATIC_FILES = [
    '/', // for index.html
    '/index.html',
    '/composer.html',
    '/style.css',
    '/functions.js',
    '/manifest.json',
    '/composer-manifest.json',
    '/settings/settings-v4.4.2.json',
    '/settings/settings-v6.10.0.json',
    '/settings/settings-v6.8.1.json',
    '/settings/settings-v6.9.0.json'
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