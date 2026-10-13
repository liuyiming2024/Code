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

/* 预缓存：装好就能离线打开。少而精，别把不常用的也塞进来。
 *
 * ⚠ 这份清单曾经手写过，漏掉了 js/fs.js —— 结果是装到桌面后断网打开，
 *   Code.fs 未定义、boot() 里 fs.init() 直接崩，编辑器起不来。
 *   而 README 明写"装好是独立窗口，断网也能写、能跑"，这正是 PWA 的典型场景。
 *   手写清单必然会再漏（每加一个脚本就要记得同步一次），
 *   所以改成从 index.html 自动提取 —— 见下面的 deriveScripts()。
 */
var PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* 从 index.html 里抓出所有 <script src> 与 <link href>，自动并入预缓存。
   这样加脚本不用再记着改这里 —— 漏一个就会在离线时炸，代价太大。
   （Worker 脚本 rt-worker.js 除外：它只在跑按需运行时才用得上。） */
function deriveScripts(html) {
  var out = [];
  var re = /<script[^>]+src=["']([^"']+)["']/g, m;
  while ((m = re.exec(html))) {
    var u = m[1];
    if (/rt-worker/.test(u)) continue;      /* Worker 不预缓存 */
    if (/^https?:/.test(u)) continue;       /* 外链不管 */
    out.push(u.charAt(0) === '.' ? u : './' + u.replace(/^\.?\//, ''));
  }
  var re2 = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g, m2;
  while ((m2 = re2.exec(html))) {
    var u2 = m2[1];
    if (/^https?:/.test(u2)) continue;
    out.push(u2.charAt(0) === '.' ? u2 : './' + u2.replace(/^\.?\//, ''));
  }
  return out;
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    /* 先取 index.html，从里面抽出所有脚本与样式，再连同基础项一起缓存。
       自动提取是防"漏一个就离线崩"——手写清单已经漏过 fs.js 一次。 */
    fetch('./index.html').then(function (r) { return r.text(); })
      .catch(function () { return ''; })
      .then(function (html) {
        var list = PRECACHE.slice();
        deriveScripts(html).forEach(function (u) {
          if (list.indexOf(u) < 0) list.push(u);
        });
        return caches.open(CACHE).then(function (c) {
          /* 单个文件失败不能让整个安装挂掉 —— 少缓存一个离线也能用，
             装不上就彻底没有离线能力了。 */
          return Promise.all(list.map(function (u) {
            return c.add(u).catch(function () { });
          }));
        });
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
        /* ⚠ 不能无差别删（S-038）。
           运行时缓存（code-runtimes-v1）是长效的、达 90 MB，
           每次 SW 激活都删掉 = 用户每次更新都要重新下载一遍 C++ 工具链。
           只删本项目自己的旧版本缓存。 */
        if (k === CACHE) return;
        if (k.indexOf('code-runtimes') === 0) return;   /* 运行时：不删 */
        if (k.indexOf('code-') === 0) return caches.delete(k);  /* 本项目旧版本：删 */
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
