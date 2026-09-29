const CACHE = 'escaner-krezco-v11';
const APP_FILES = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icons/icon.svg', './vendor/quagga.min.js', './vendor/zxing-browser.min.js', './vendor/tesseract.min.js'];

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(saved => saved || fetch(event.request).then(response => {
    const url = new URL(event.request.url);
    if (url.origin === location.origin && response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match('./index.html'))));
});

