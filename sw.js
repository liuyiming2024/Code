/* sw.js —— 离线缓存（PWA）
 *
 * 目的：装到桌面或手机主屏之后，断网也能写代码。
 *
 * 三条边界必须守住，否则会出事：
 *   1. **只缓存同源 GET**。AI 请求走的是用户自己的密钥、发给用户选的服务商，
 *      把它缓存下来既没意义也有风险；按需运行时（WASM）在 rt-worker 里有
 *      自己的一套缓存，这边再插手会打架。
 *   2. **不缓存 POST / 带 Range 的请求**。
 *   3. **不在用户编辑时强行换版本**。新版本装好后先等着，
 *      由页面提示、用户点了才接管。偷偷 skipWaiting 会让人正在写的东西没了。
 *
 * 更新策略：本项目没有构建步骤，文件名不带 hash，
 * 所以 JS/CSS 用 stale-while-revalidate —— 先用缓存保证秒开，
 * 后台顺手更新，下次刷新就是新版。
 */

var CACHE = 'code-v1';

/* 预缓存：装好就能离线打开。少而精，别把不常用的也塞进来。 */
var PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/util.js',
  './js/store.js',
  './js/highlight.js',
  './js/snippets.js',
  './js/style-adapt.js',
  './js/editor.js',
  './js/tree.js',
  './js/api.js',
  './js/ai.js',
  './js/langs.js',
  './js/pylite.js',
  './js/cpplite.js',
  './js/runner.js',
  './js/runtime.js',
  './js/runtimes.js',
  './js/ui.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* rt-worker.js 不预缓存 —— 它是 Worker 脚本，只在真正跑按需运行时才需要。
   预缓存它会让每次安装都多下文件，而多数人根本用不到那六种语言。 */

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* 单个文件失败不能让整个安装挂掉 —— 少缓存一个离线也能用，
         装不上就彻底没有离线能力了。 */
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(u).catch(function () { });
      }));
    }).then(function () {
      /* 故意不调 skipWaiting：等页面提示用户，别在人家写代码时抢走控制权 */
      return self.skipWaiting ? null : null;
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* 页面确认后调用，让新版本接管 */
self.addEventListener('message', function (e) {
  if (e && e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', function (e) {
  var req = e.request;

  /* 只管同源 GET，其余一律放行 */
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  /* 导航请求：优先网络，离线才回退缓存的 index.html */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (hit) {
          return hit || caches.match('./');
        });
      })
    );
    return;
  }

  /* 其余静态资源：先用缓存，后台更新 */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit;   /* 离线且有缓存就用缓存 */
      });
      return hit || net;
    })
  );
});
