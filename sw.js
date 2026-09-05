/*!
 * 课程表 Service Worker
 * 策略：网络优先（保证更新后用户能拿到新版本），离线时回退缓存
 */
'use strict';

// ⚠️ 每次更新应用文件后，把 VERSION 加 1（如 '1' -> '2'），
// 旧缓存才会在下次激活时被清理，避免离线用户长期使用旧资源
var VERSION = '3';
var CACHE = 'class-schedule-v' + VERSION;
var PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './schedule-core.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (m) {
          return m || caches.match('./index.html');
        });
      })
  );
});
