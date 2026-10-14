/* rt-worker.js —— 运行时 Worker（classic 类型）
   ------------------------------------------------------------------
   所有 WASM 运行时都在这里加载并执行，主线程只管显示，不干重活。

   为什么必须用 Worker：
     clang.wasm 40 MB、ruby 33 MB，在主线程编译会白屏好几秒甚至十几秒。
     Worker 里卡住，页面照样能响应。

   为什么是 classic 而不是 module：
     importScripts 能吃 UMD（sql.js / pyodide / lua / clang 都是 UMD 或
     Emscripten 输出），这是选 classic 的**主要**原因。

   ⚠ 但"只用 UMD 资源"这句是错的，已删（本轮修正，S-026）：
     本文件实际用**动态 import()** 加载了 ruby / php / cpp 三个 ESM 入口
     （见 loadESM）。classic worker 里可以用动态 import() ——
     这与 importScripts 是两回事，别混为一谈。
     此前注释写"只用 UMD、没抓 ESM 资源"，与实现直接矛盾：
     照注释读的人会以为 ESM 那条路不存在，
     于是面对"ruby 下载失败"时会往完全错误的方向排查。
     注释与实现打架，比没有注释更糟 —— 它给了你一个错的前提。

   ⚠ 首次运行需要联网下载运行时；之后走 Cache Storage，断网也能用。
     这一点必须在界面上说清楚，静默失败是最差体验。
*/
'use strict';

/* ⚠ 下载地址改过，原因有实测依据，别改回去：
 *
 *   旧值：https://github.com/liuyiming2024/assets/releases/latest/download/
 *   问题：浏览器地址栏能瞬间下载，Worker 里的 fetch 却报
 *         "NetworkError when attempting to fetch resource."
 *   两者规则的差别：
 *     · 地址栏 = 顶层导航，不做 CORS 检查
 *     · fetch  = CORS 模式，且直链会 302 跳到 objects.githubusercontent.com
 *   实测响应头：
 *     github.com/.../releases/download/  → Access-Control-Allow-Origin: （无）
 *     raw.githubusercontent.com/...      → Access-Control-Allow-Origin: *
 *   重定向链上任何一环缺 ACAO，浏览器就只给一句 NetworkError，
 *   不会告诉你是 CORS 的问题 —— 这个坑排查成本很高。
 *
 * 解法不是"绕过 CORS"（我们改不了 GitHub 的响应头），
 * 而是让资产存在于 **git 目录**：由 assets 仓库的
 * 「资产搬进 git 目录」workflow 从 Release 搬到 rt/ 下。
 * raw 域不重定向、且带 ACAO:*，问题从根上消失。
 *
 * 新增运行时前，先跑那个 workflow 把文件搬进 rt/，
 * 否则这里会 404 —— 404 是明确的，比 NetworkError 好查得多。 */
/* 下载源：多个，按序回退。
 *
 * 为什么不是一个：本轮逐个实测，两个源都**不稳定**（同一文件、同一分钟内）：
 *
 *   raw.githubusercontent.com
 *      小文件 0.52s ✅ / 大文件 13.45s ✅ / 也出现过连续 3 次 40s 超时 ❌
 *      偶发 403（快，0.1s）
 *   cdn.jsdelivr.net/gh/
 *      3/3 成功，2.0~3.1s ✅ —— 但此前也出现过 502 ❌
 *   github.com/.../releases/download/
 *      **一律不可用**：无 Access-Control-Allow-Origin 头（实测 403 且 ACAO 空）
 *
 * 所以正确做法不是"挑一个最好的"，而是**都配上、失败自动换下一个**。
 * 单一源必然在某些时刻不可用，而用户只会看到一句 NetworkError。
 *
 * 另外：jsDelivr 免费版对单文件有体积上限（约 20 MB），
 * clang.wasm 40.6 MB 在它上面会失败 —— 有了回退，这种情况会自动落到 raw。
 *
 * 缓存 key 用**规范 URL**（canonical），与实际下载用的源无关：
 * 否则从 jsDelivr 下的和从 raw 下的会各存一份，白白占双倍空间。
 */
/* 规范 key = 主源 URL。
   ⚠ 必须等于 api/runtimes.json 里的 file.url ——
      js/runtime.js 的 hasCached() 是用 manifest 里的 url 去查缓存的。
      两者一旦不一致，缓存永远查不到，界面就会一直显示"未下载"，
      哪怕文件其实已经下好了（本轮差点踩进去）。 */
var CANONICAL = 'https://cdn.jsdelivr.net/gh/liuyiming2024/assets@main/rt/';
var SOURCES = [
  'https://cdn.jsdelivr.net/gh/liuyiming2024/assets@main/rt/',
  'https://raw.githubusercontent.com/liuyiming2024/assets/main/rt/'
];
var BASE = SOURCES[0];
var CACHE = 'code-runtimes-v1';

/* 文件名里有 + 的（ruby+stdlib.wasm）必须编码成 %2B —— Release 直链就是这么给的。
   不统一的话下载用一个 key、清理用另一个 key，缓存会对不上。 */
function urlOf(name) {
  return BASE + name.replace(/\+/g, '%2B');
}
/* 缓存用的规范 key：与实际下载源无关 */
function canonOf(name) {
  return CANONICAL + name.replace(/\+/g, '%2B');
}

/* 每个语言需要哪些文件。预下载时按这里逐个拉，带进度。 */
var NEED = {
  sql: ['sql-wasm.js', 'sql-wasm.wasm'],
  python: ['pyodide.js', 'pyodide.asm.wasm', 'python_stdlib.zip'],
  lua: ['fengari-web.js'],
  cpp: ['cpp-index.js', 'clang.js', 'lld.js', 'wasi-shim.js',
        'lld.wasm', 'sysroot.tar', 'clang.wasm'],
  php: ['php-web.js', 'php-web.js.wasm'],
  ruby: ['ruby-wasi.js', 'ruby+stdlib.wasm']
};

/* 体积提示，用于在下载前告诉用户要等多久。单位 MB。 */
var SIZE_HINT = {
  sql: 0.7, python: 12, lua: 0.5, cpp: 90, php: 16.5, ruby: 34
};

function say(type, data) {
  var m = { type: type };
  if (data) for (var k in data) m[k] = data[k];
  self.postMessage(m);
}

/* ------------------------------------------------------------------
   接管 fetch：让运行时内部的二次请求也命中缓存。
   pyodide 拿到 indexURL 后会自己去 fetch pyodide.asm.wasm 和 stdlib，
   sql.js 的 locateFile 同理 —— 不接管的话它们会绕过缓存重新下载。
*/
var origFetch = self.fetch ? self.fetch.bind(self) : null;

/* 已知资产的文件名集合。
   为什么需要它：browsercc 的 compile() 内部用
     new URL("sysroot.tar", import.meta.url)
   去取 sysroot —— 而 GitHub 的下载直链会 302 跳到 objects.githubusercontent.com，
   重定向之后 import.meta.url 就不再以 BASE 开头了，只看前缀会漏掉它，
   结果 29 MB 每次重下。
   所以除了前缀匹配，再按"文件名是否在已知资产里"兜一层。 */
var KNOWN_NAMES = {};
Object.keys(NEED).forEach(function (k) {
  (NEED[k] || []).forEach(function (n) { KNOWN_NAMES[n] = canonOf(n); });
});

function cacheUrlFor(url) {
  /* 我们自己的下载源：直接映射成规范 key（与用哪个源无关） */
  for (var i = 0; i < SOURCES.length; i++) {
    if (url.indexOf(SOURCES[i]) === 0) {
      return canonOf(url.slice(SOURCES[i].length));
    }
  }
  var q = url.indexOf('?');
  var base = q < 0 ? url : url.slice(0, q);
  var name = base.slice(base.lastIndexOf('/') + 1);
  try { name = decodeURIComponent(name); } catch (e) { }
  /* 运行时内部自己拼出来的二次请求（重定向后域名会变）：
     按文件名认，只要它落在我们已知的源域上就映射回规范 key。 */
  if (KNOWN_NAMES[name] &&
      /^https?:\/\/[^/]*(github|jsdelivr)/.test(url)) return KNOWN_NAMES[name];
  return null;
}

self.fetch = function (input, opts) {
  var url = typeof input === 'string' ? input : (input && input.url) || '';
  var mapped = cacheUrlFor(url);
  if (!origFetch || !mapped) return origFetch(input, opts);
  /* 用映射后的规范 URL 查缓存 —— 下载存的和这里查的必须是同一个 key */
  return caches.open(CACHE).then(function (c) {
    return c.match(mapped);
  }).then(function (hit) {
    if (hit) return hit;
    return origFetch(input, opts).then(function (r) {
      return caches.open(CACHE).then(function (c) {
        try { c.put(mapped, r.clone()); } catch (e) { /* 配额满就算了 */ }
        return r;
      });
    });
  });
};

function fromCache(url) {
  return caches.open(CACHE).then(function (c) { return c.match(url); });
}

/* ============ 断点续传 ============
 *
 * 为什么要它（本轮实测发现的一句谎话）：
 *   错误提示里写着「已下载的部分会留在缓存里，重试不会从头开始」——
 *   但这是假的。此前 grab() 只有在**整个文件下完**之后才 caches.put()，
 *   中途断掉的话 chunks 全部丢弃，下次 fromCache 查不到，照样从头下。
 *
 *   对 40 MB 的 clang.wasm 来说，这句话的代价很高：
 *   用户下了 38 MB 断线，重试又从 0 开始，如此反复，永远下不完。
 *   而他**是因为看到那句话才愿意重试的** —— 谎报在这里直接导致放弃。
 *
 * 所以两件事选一件：要么把话改掉，要么把功能做出来。
 *   做出来更有价值（尤其用户决定改用官方运行时，体积只会更大），
 *   于是实现续传：失败时保留已下部分，下次带 Range 头接着下。
 *
 * 兼容性：若服务端不支持 Range（返回 200 而非 206），
 *   就丢弃部分数据从头下 —— 不会比现在更差。
 */
var PARTIAL_CACHE = 'code-rt-partial-v1';
var PARTIAL_MIN = 256 * 1024;      /* 小于这个不值得存（缓存开销比收益大） */
var PARTIAL_FLUSH = 2 * 1024 * 1024;  /* 每攒够 2 MB 落一次，别每片都写 */

function partialKey(url) { return 'partial:' + url; }

function readPartial(url) {
  return caches.open(PARTIAL_CACHE)
    .then(function (c) { return c.match(partialKey(url)); })
    .then(function (r) { return r ? r.arrayBuffer() : null; })
    .catch(function () { return null; });   /* 读不到就当没有，从头下 */
}
function writePartial(url, buf) {
  if (!buf || buf.byteLength < PARTIAL_MIN) return Promise.resolve(false);
  return caches.open(PARTIAL_CACHE).then(function (c) {
    return c.put(partialKey(url), new Response(buf, {
      headers: { 'content-type': 'application/octet-stream' }
    })).then(function () { return true; });
  }).catch(function () { return false; });   /* 配额满：降级为不续传，不报错 */
}
function dropPartial(url) {
  return caches.open(PARTIAL_CACHE)
    .then(function (c) { return c.delete(partialKey(url)); })
    .catch(function () { });
}

/* 下载单个文件：多源回退 + 断点续传 + 校验。
   已缓存则直接跳过（不产生流量）。 */
function grab(name, doneBytes, totalBytes) {
  /* 缓存与续传一律用规范 key，与实际用哪个源无关 ——
     否则从不同源下的同一个文件会各存一份，白白占双倍空间。 */
  var ckey = canonOf(name);
  return fromCache(ckey).then(function (hit) {
    if (hit) return { buf: null, cached: true };
    return grabFromSources(name, ckey, doneBytes, totalBytes, 0, null);
  });
}

/* 逐个源尝试，全失败才抛错。
   lastErr 保留最后一个源的原因 —— 全挂时要给用户一个具体说法，
   而不是含糊的"下载失败"。 */
function grabFromSources(name, ckey, doneBytes, totalBytes, idx, lastErr) {
  if (idx >= SOURCES.length) {
    return Promise.reject(new Error(name + ' 下载失败（已试 ' + SOURCES.length +
      ' 个源）' + (lastErr ? '：' + lastErr : '')));
  }
  var url = SOURCES[idx] + name.replace(/\+/g, '%2B');
  return grabOne(name, url, ckey, doneBytes, totalBytes).catch(function (e) {
    /* 换源前丢弃上一个源的半成品 —— 不同源的字节不能混着拼 */
    return dropPartial(ckey).then(function () {
      return grabFromSources(name, ckey, doneBytes, totalBytes, idx + 1,
        String((e && e.message) || e).slice(0, 120));
    });
  });
}

function grabOne(name, url, ckey, doneBytes, totalBytes) {
  return readPartial(ckey).then(function (partial) {
  var offset = (partial && partial.byteLength) || 0;
  var opts = {};
  if (offset > 0) opts.headers = { Range: 'bytes=' + offset + '-' };

  return origFetch(url, opts).then(function (r) {
    /* 206 = 接受续传；200 = 不支持 Range 或忽略 Range，从头下 */
    var resumed = (r.status === 206);
    if (!resumed) offset = 0;
    if (!r.ok && !resumed) throw new Error(name + ' 下载失败：HTTP ' + r.status);

    var len = parseInt(r.headers.get('content-length') || '0', 10);
    if (!r.body || !len) {
      return r.arrayBuffer().then(function (b) {
        if (offset > 0 && partial) {
          var m = new Uint8Array(offset + b.byteLength);
          m.set(new Uint8Array(partial), 0);
          m.set(new Uint8Array(b), offset);
          return { buf: m.buffer, size: m.byteLength };
        }
        return { buf: b, size: b.byteLength };
      });
    }

    var reader = r.body.getReader();
    var chunks = offset > 0 ? [new Uint8Array(partial)] : [];
    var got = offset;
    var sinceFlush = 0;

    function snapshot() {
      var all = new Uint8Array(got), at = 0;
      for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], at); at += chunks[i].length; }
      return all.buffer;
    }
    function pump() {
      return reader.read().then(function (x) {
        if (x.done) return { buf: snapshot(), size: got };
        chunks.push(x.value); got += x.value.length; sinceFlush += x.value.length;
        /* 边下边存：真断线时这部分才留得下来 */
        if (sinceFlush >= PARTIAL_FLUSH) {
          sinceFlush = 0;
          writePartial(ckey, snapshot());
        }
        say('progress', { file: name, loaded: doneBytes + got,
                          total: totalBytes || (len + offset),
                          pct: totalBytes ? Math.floor((doneBytes + got) / totalBytes * 100)
                                          : Math.floor(got / (len + offset) * 100),
                          resumed: offset > 0 });
        return pump();
      });
    }
    return pump().catch(function (e) {
      /* 断线了：把已下的存下来，下次接着下 */
      if (got > 0) writePartial(ckey, snapshot());
      throw e;
    });
  });
  }).then(function (res) {
    if (!res.buf) return res;
    /* ⚠ 校验必须在入缓存之前。进了缓存就很难被发现是坏的 ——
       之后每次都命中它，表现是"能加载但一跑就炸"。 */
    return verifyOrThrow(name, res.buf).catch(function (e) {
      if (e && e.__badFile) {
        /* 坏文件连同半成品一起删，下次重新下 */
        dropPartial(ckey);
        caches.open(CACHE).then(function (c) { return c.delete(ckey); }).catch(function () { });
      }
      throw e;
    }).then(function () {
      return caches.open(CACHE).then(function (c) {
        /* ⚠ 必须等 c.put 真正完成（本轮实测发现的 bug）。
           此前调用 c.put() 后没等它落地就返回，于是 prepare() 常在文件
           真正进缓存之前就触发 ready，界面立刻查缓存自然是空的 ——
           表现为"进度条走完 100%，状态仍显示未下载，再点一次才对"。
           用户很容易把它误判成下载失败而去重试、去查网络，
           实际上文件是好的。 */
        var putP;
        try {
          putP = c.put(ckey, new Response(res.buf, {
            headers: { 'content-type': 'application/octet-stream' }
          }));
        } catch (e) { putP = null; }   /* 配额满就算了，下次重新下 */
        return Promise.resolve(putP).catch(function () { }).then(function () {
          return dropPartial(ckey);
        }).then(function () { return { buf: res.buf, size: res.size }; });
      });
    });
  });
}

/* 预下载某语言需要的全部文件，逐个报进度。 */
/* ============ 文件元信息（大小 + SHA-256）============
 *
 * 为什么要在 Worker 里再拿一份清单：
 *   续传会把多次下载的数据拼起来，拼错一个字节就是一个坏文件；
 *   而坏文件一旦进缓存，之后每次都命中它，表现是"能用但一跑就炸"，
 *   用户完全不知道是文件坏了。所以**必须校验**。
 *
 *   清单用 Code 仓库自己的 `api/runtimes.json`（同源，一定拿得到），
 *   而不是 assets 仓库的 —— 后者在 GitHub Release 上，正是可能被挡的那个。
 *   校验值取自 Release API 的 digest 字段，不是人工抄写（见 runtime.js 头部说明）。
 */
var RT_META = null, metaP = null;
function loadMeta() {
  if (RT_META) return Promise.resolve(RT_META);
  if (metaP) return metaP;
  var u;
  try { u = new URL('../api/runtimes.json', self.location.href).href; }
  catch (e) { u = '../api/runtimes.json'; }
  metaP = origFetch(u).then(function (r) {
    if (!r.ok) throw new Error('运行时清单加载失败：HTTP ' + r.status);
    return r.json();
  }).then(function (j) {
    var m = {};
    (j.runtimes || []).forEach(function (rt) {
      (rt.files || []).forEach(function (f) {
        if (f && f.name) m[f.name] = { size: f.size || 0, sha256: f.sha256 || '' };
      });
    });
    RT_META = m;
    return m;
  }).catch(function (e) {
    RT_META = {}; metaP = null;
    throw e;
  });
  return metaP;
}

/* 返回小写 hex；环境不支持 subtle 就返回 null（不假装校验过） */
function sha256hex(buf) {
  if (!(self.crypto && self.crypto.subtle && self.crypto.subtle.digest)) return Promise.resolve(null);
  return self.crypto.subtle.digest('SHA-256', buf).then(function (d) {
    var a = new Uint8Array(d), out = '';
    for (var i = 0; i < a.length; i++) out += ('0' + a[i].toString(16)).slice(-2);
    return out;
  }).catch(function () { return null; });
}

function verifyOrThrow(name, buf) {
  var meta = (RT_META && RT_META[name]) || null;
  if (!meta || !meta.sha256) return Promise.resolve(null);   /* 清单没给，跳过 */
  return sha256hex(buf).then(function (hex) {
    if (hex == null) return null;                 /* 环境不支持，跳过（不谎报已校验） */
    if (hex === String(meta.sha256).toLowerCase()) return true;
    /* 校验失败：坏文件绝不能进缓存，否则以后每次都命中它 */
    var e = new Error(name + ' 内容校验失败（SHA-256 不匹配）。\n' +
      '可能是网络传输中被截断或篡改。已丢弃这个文件，请重试下载。');
    e.__badFile = name;
    throw e;
  });
}

function prepare(lang) {
  var files = NEED[lang] || [];
  var done = 0;
  /* 先探一次总大小，好算总进度。缓存命中就不算进总量。
     ⚠ 上一版注释写"现在把探测到的总量传下去"，但**代码没改** ——
       下面依然是 grab(f, done, 0)，第三个参数恒为 0。
       于是每个文件的进度都报 0/N，进度条走 N 次 0→100%，
       看起来一直在动，实际没有总量参照。
       这是我自己在注释里宣布做完、代码里没做的一例，本轮真正实现。
        总量取自同源的 api/runtimes.json（拿不到就传 0，界面显示"总量未知"，
        绝不编一个假的百分比）。 */
  return loadMeta().catch(function () { return {}; }).then(function (meta) {
    var total = 0;
    files.forEach(function (f) {
      var m = meta[f];
      if (m && m.size) total += m.size;
    });
    return files.reduce(function (p, f) {
      return p.then(function () {
        return fromCache(canonOf(f)).then(function (hit) { return hit ? 0 : null; });
      }).then(function (skip) {
        if (skip === 0) return 0;
        return grab(f, done, total).then(function (r) {
          done += r.size || 0;
          return r.size || 0;
        });
      });
    }, Promise.resolve(0));
  }).then(function () {
    say('progress', { file: '', pct: 100 });
  });
}

/* ============ 运行时复用（S-023）============
 *
 * 此前每次 run 都重做两件很贵的事：
 *   ① importScripts 同一个胶水脚本 —— 浏览器会缓存"下载"，
 *      但**每次都会重新求值**。pyodide.js 那层求值不是免费的。
 *   ② 重新初始化运行时 —— pyodide 每次都重新实例化 12 MB 的 wasm。
 *
 * 于是同一个用户连着跑十次 Python，就要初始化十次 pyodide。
 * 这是"能跑但很慢"，比报错更难察觉 —— 用户只会觉得这软件卡。
 *
 * 现在改成：脚本只求值一次，运行时实例也只建一次，之后复用。
 */
var LOADED = {};      /* 已求值过的胶水脚本 */
var RT_INST = {};     /* 已初始化好的运行时实例 */
var PY_OUT = [];      /* 本次运行收集的 Python stdout */

function load(name) {
  // importScripts 是同步的，加载失败会抛 —— 直接冒泡出去
  if (LOADED[name]) return;     /* 已求值过，不再重复 */
  importScripts(urlOf(name));
  LOADED[name] = true;
}

/* 取（或首次创建）某个运行时的实例。
   make 只在第一次调用时执行。 */
function rtInst(key, make) {
  if (RT_INST[key]) return Promise.resolve(RT_INST[key]);
  return Promise.resolve().then(make).then(function (inst) {
    RT_INST[key] = inst;
    return inst;
  });
}

function rtDrop(key) {
  delete RT_INST[key];
  delete LOADED[key];
}

/* ESM 胶水（ruby-wasi.js）不能走 importScripts。
   classic worker 里可以用动态 import() 加载 ESM ——
   这正是它与 importScripts 的关键区别，别混为一谈。 */
function loadESM(name) {
  /* ⚠ 这里绝不能写 `typeof import !== 'function'` 做特性检测。
     `import` 是关键字不是标识符 —— Chrome 会把 `typeof import` 解析成
     静态 import 语句，于是整个 Worker 在【解析阶段】就抛
     "Cannot use import statement outside a module"，连一行都跑不起来。
     后果：六种按需运行时一个都下载不了，点下载立刻失败，
     而报错指向的是 Worker 而非真正的原因。
     要检测只能间接地做：动态 import() 失败了会走 catch，
     在那里给出同样清楚的说明。 */
  return import(urlOf(name)).catch(function (e) {
    return Promise.reject(new Error(
      '无法加载 ESM 胶水 ' + name + '：' + String((e && e.message) || e) +
      '。若浏览器不支持动态 import()，受影响的是 Ruby 与 C++，其余语言不受影响。'));
  });
}

/* ================= 各语言执行 ================= */

function runSQL(code) {
  load('sql-wasm.js');
  /* initSqlJs 会实例化 wasm，不便宜 —— 复用同一个引擎 */
  return rtInst('sql', function () {
    return self.initSqlJs({ locateFile: function (f) { return urlOf(f); } });
  }).then(function (SQL) {
      var db = new SQL.Database();
      var out = [];
      try {
        var res = db.exec(code);
        if (!res.length) out.push('（执行成功，无结果集）');
        res.forEach(function (r) {
          out.push(r.columns.join('\t'));
          r.values.forEach(function (v) {
            out.push(v.map(function (x) { return x === null ? 'NULL' : String(x); }).join('\t'));
          });
        });
      } catch (e) {
        out.push('SQL 错误：' + (e && e.message || e));
      }
      db.close();
      return out.join('\n');
    });
}

function runPython(code) {
  load('pyodide.js');
  var buf = '';
  /* loadPyodide 是最贵的那一步（12 MB wasm 实例化），必须复用。 */
  return rtInst('pyodide', function () {
    return self.loadPyodide({
      indexURL: BASE,
      /* stdout 要接到**本次**的 buf 上，所以不能直接把 buf 闭包进构造里 ——
         改成每次跑之前重定向。 */
      stdout: function (s) { PY_OUT.push(s); }
    });
  }).then(function (py) {
    /* 复用实例带来的副作用：上一次跑留下的变量还在。
       不处理的话会出现"这次没定义 x 却能 print(x)"——
       用户会以为是自己的代码对了，实际是上一次的残留，极难察觉。
       所以每次跑之前清空 __main__ 的名字空间。 */
    try {
      py.runPython('import sys as _s\n'
        + '_m = _s.modules.get("__main__")\n'
        + 'if _m is not None:\n'
        + '    for _k in list(vars(_m).keys()):\n'
        + '        if not _k.startswith("__"): delattr(_m, _k)');
    } catch (e) { /* 清不掉也继续跑，不影响主流程 */ }
    PY_OUT = [];
    /* setStdout 不是所有 pyodide 版本都有 —— 没有就靠构造时那个 stdout 回调，
       它在调用时读的是 PY_OUT 这个变量（不是捕获当时的值），所以一样有效。 */
    try { if (py.setStdout) py.setStdout({ batched: function (s) { PY_OUT.push(s); } }); }
    catch (e) { }
    try {
      var r = py.runPython(code);
      /* 输出顺序：先 stdout，再表达式的值（与真 python 交互环境一致） */
      buf = PY_OUT.join('\n') + (PY_OUT.length ? '\n' : '');
      if (r !== undefined && r !== null) buf += String(r);
    } catch (e) {
      buf = PY_OUT.join('\n') + '\n' + String(e && e.message || e);
    }
    return buf;
  });
}

function runLua(code) {
  // fengari-web.js 是 webpack 打包好的，fengari 核心已 bundle 在内
  load('fengari-web.js');
  return Promise.resolve().then(function () {
    /* lua_State 每次新建：Lua 的名字空间就是全局表，
       复用会把上次的变量带进来（同 pyodide 那个问题）。
       但 lua_open + openlibs 本身很便宜（远小于 12 MB wasm 实例化），
       所以这里**不复用**，保持每次干净 —— 正确性优先。 */
    var out = [];
    var fengari = self.fengari;
    if (!fengari) throw new Error('fengari 未加载');
    var L = fengari.lua_open ? fengari.lua_open() : fengari.lauxlib.luaL_newstate();
    fengari.lualib.luaL_openlibs(L);
    // 把 print 接到我们的输出上
    fengari.lua.lua_pushcfunction(L, function (L2) {
      var n = fengari.lua.lua_gettop(L2), parts = [];
      for (var i = 1; i <= n; i++) {
        var t = fengari.lua.lua_type(L2, i);
        if (t === fengari.lua.LUA_TSTRING) parts.push(fengari.lua.lua_tojsstring(L2, i));
        else if (t === fengari.lua.LUA_TNUMBER) parts.push(String(fengari.lua.lua_tonumber(L2, i)));
        else parts.push(fengari.lua.lua_typename(L2, t));
      }
      out.push(parts.join('\t'));
      return 0;
    });
    fengari.lua.lua_setglobal(L, 'print');
    var st = fengari.lauxlib.luaL_dostring(L, fengari.to_luastring(code));
    if (st !== fengari.lua.LUA_OK) {
      out.push('Lua 错误：' + fengari.lua.lua_tojsstring(L, -1));
    }
    return out.join('\n');
  });
}

function runPHP(code) {
  load('php-web.js');
  return new Promise(function (resolve) {
    var out = [];
    try {
      var PhpWeb = self.PhpWeb || (self.phpwasm && self.phpwasm.PhpWeb);
      if (!PhpWeb) throw new Error('php-web.js 未导出 PhpWeb（UMD 挂载名不符）');
      var php = new PhpWeb({ locateFile: function (f) { return urlOf(f); } });
      php.addEventListener('output', function (e) { out.push(e.detail); });
      php.addEventListener('error', function (e) { out.push('[stderr] ' + e.detail); });
      php.addEventListener('ready', function () {
        php.run(code).then(function () { resolve(out.join('')); },
                           function (e) { resolve(out.join('') + '\n' + (e && e.message || e)); });
      });
    } catch (e) {
      resolve('PHP 初始化失败：' + (e && e.message || e));
    }
  });
}

function runRuby(code) {
  /* ruby-wasi.js 是 ESM，importScripts 吃不下 —— 改用动态 import()。
     导出形状没在真机确认过，所以依次尝试常见名字；
     全都对不上时把实际导出列出来，不静默返回空。 */
  return loadESM('ruby-wasi.js').then(function (m) {
    var keys = Object.keys(m || {});
    var VM = m.RubyVM || m.default || (m.default && m.default.RubyVM);
    if (!VM) {
      throw new Error('ruby-wasi.js 没有可识别的导出。实际导出：' +
        (keys.length ? keys.join(', ') : '(空)'));
    }
    /* 各版本构造方式不同：有的要先 new 再 await init，有的是工厂函数 */
    return Promise.resolve()
      .then(function () { return typeof VM === 'function' ? new VM() : VM; })
      .then(function (vm) {
        return (vm && typeof vm.init === 'function') ? vm.init().then(function () { return vm; }) : vm;
      })
      .then(function (vm) {
        var run = null;
        ['eval', 'evalAsync', 'run', 'runAsync'].forEach(function (k) {
          if (!run && vm && typeof vm[k] === 'function') run = vm[k].bind(vm);
        });
        if (!run) {
          throw new Error('RubyVM 实例没有可识别的执行方法。实例导出：' +
            (vm ? Object.keys(vm).join(', ') : '(空)'));
        }
        return Promise.resolve(run(code)).then(function (r) {
          /* 不同版本返回值形态不一：可能是字符串，也可能是带 output 的对象 */
          if (r == null) return '';
          if (typeof r === 'string') return r;
          if (typeof r === 'object') {
            return (r.output != null) ? String(r.output)
              : (r.stdout != null) ? String(r.stdout)
              : (r.value != null) ? String(r.value) : String(r);
          }
          return String(r);
        });
      });
  });
}

function runCpp(code, msg) {
  /* browsercc 的 cpp-index.js 是 ESM（源码里就是 import Clang from "./clang.js"），
     importScripts 吃不下 —— 必须走动态 import()。

     一个不能踩的坑：compile() 内部是这样取 sysroot 的
         new URL("sysroot.tar", import.meta.url)
     它的相对解析依赖 import.meta.url。所以这里必须 import **原始直链**，
     不能先把文件读成 blob 再 import（那样 import.meta.url 变成 blob:，
     相对解析直接失败）。直链解析出来正好是我们缓存的那个 URL。 */
  return loadESM('cpp-index.js').then(function (bcc) {
    var compile = bcc.compile || (bcc.default && bcc.default.compile);
    if (!compile) {
      throw new Error('browsercc 没有导出 compile。实际导出：' +
        Object.keys(bcc || {}).join(', '));
    }
    /* 扩展名决定 clang 按 C 还是 C++ 编译 —— 传 .c 却按 C++ 编会出莫名其妙的错 */
    var fileName = (msg && msg.fileName) || 'main.cpp';
    if (!/\.(c|cc|cpp|cxx)$/i.test(fileName)) fileName = 'main.cpp';

    var flags = /\.c$/i.test(fileName)
      ? ['-std=c17', '-O2']
      : ['-std=c++20', '-O2'];

    return compile({ source: code, fileName: fileName, flags: flags });
  }).then(function (r) {
    var out = [];
    if (r && r.compileOutput) out.push(r.compileOutput);
    if (!r || !r.module) {
      out.push('（编译未产出可执行模块）');
      return out.join('\n');
    }
    /* 执行编译产物需要 WASI。wasi-shim.js 也是 ESM，同样走动态 import。 */
    return loadESM('wasi-shim.js').then(function (shim) {
      var WASI = shim.WASI;
      var ConsoleStdout = shim.ConsoleStdout;
      var File = shim.File;
      var OpenFile = shim.OpenFile;
      if (!WASI || !ConsoleStdout || !File || !OpenFile) {
        out.push('（WASI shim 导出不全：' + Object.keys(shim || {}).join(', ') + '）');
        return out.join('\n');
      }
      var captured = '';
      var sink = function (d) { captured += new TextDecoder().decode(d); };
      var fds = [new OpenFile(new File([])),
                 new ConsoleStdout(sink), new ConsoleStdout(sink)];
      var wasi = new WASI([], [], fds);
      return WebAssembly.instantiate(r.module, {
        wasi_snapshot_preview1: wasi.wasiImport
      }).then(function (inst) {
        try { wasi.start(inst); } catch (e) {
          /* WASI 的 _start 结束后会抛退出信号，属正常，别当成错误报给用户 */
          if (!/exit|unreachable/i.test(String(e && e.message))) throw e;
        }
        out.push(captured);
        return out.join('\n');
      });
    });
  });
}

var RUNNERS = {
  sql: runSQL, python: runPython, lua: runLua,
  php: runPHP, ruby: runRuby, cpp: runCpp
};

/* 把 fetch 的裸错误翻译成人能判断的话。
   "Failed to fetch" / "NetworkError" 这种话对用户毫无用处 ——
   他分不清是"我网断了"、"GitHub 挂了"还是"这软件坏了"，
   于是只会得出一个结论：这软件不能用。
   所以把最常见几种情况分别说清楚，并给出可执行的下一步。 */
function explainFetchError(err) {
  var m = String((err && err.message) || err || '');
  if (/Failed to fetch|NetworkError|ERR_FAILED|ERR_NETWORK/i.test(m)) {
    return '下载被网络中断（' + m + '）。常见原因：断网、公司/校园网拦了 GitHub、' +
      '或浏览器插件拦截。可先确认能否打开 github.com，再重试。' +
      '已下载的部分会留在缓存里，重试不会从头开始。';
  }
  if (/HTTP 4\d\d/.test(m)) {
    return m + '。资源地址可能已失效，请反馈给作者。';
  }
  if (/不支持的压缩方式/.test(m)) return m;
  return m;
}

/* ================= 网络体检 =================
 *
 * 为什么需要它：
 *   "NetworkError when attempting to fetch resource" 是一句什么都没说的话。
 *   它可能意味着断网、被公司网拦、被插件拦、CORS 拒绝、或者资源没了 ——
 *   这五种的处理方式完全不同，但错误信息一模一样。
 *   用户看到它只能得出一个结论：这软件不能用。
 *
 * 判别方法（这是关键）：
 *   对同一个 URL 分别用 no-cors 和 cors 模式请求一次。
 *   - no-cors 成功、cors 失败  → 网络是通的，是 CORS 拒绝了读取 → 跨域策略问题
 *   - 两者都失败               → 网络层就断了 → 断网 / 被拦 / 插件
 *   - 两者都成功               → 链路正常，下载失败另有原因
 *   no-cors 的响应是 opaque（读不到内容），但请求确实发出去了，
 *   所以它能把"网络通不通"和"能不能读"这两件事分开。
 */
function probeOnce(url, mode) {
  var started = Date.now();
  return origFetch(url, { mode: mode, cache: 'no-store', redirect: 'follow' })
    .then(function (r) {
      return { ok: true, status: r.status, type: r.type, ms: Date.now() - started };
    })
    .catch(function (e) {
      return { ok: false, err: String((e && e.message) || e), ms: Date.now() - started };
    });
}

function diagnose() {
  var assetUrl = BASE + 'sql-wasm.js';   /* 体积最小的资产，体检不该让用户等大文件 */
  var steps = [];
  var out = { steps: steps };

  /* 单参数：调用处写的就是 note({...})。
     签名写成两个参数 (name, obj) 而调用只传一个，obj 就是 undefined，
     push 进去的是 undefined —— 于是分步结果全空，而结论部分照常显示，
     看起来像"分步没做"，实际是参数没对上。 */
  function note(obj) { steps.push(obj); return obj; }

  /* 第 1 步：GitHub 本身通不通 */
  var netOk = false, corsOk = false;
  return probeOnce('https://github.com/', 'no-cors').then(function (a) {
    note({ name: 'GitHub 连通性', mode: 'no-cors', r: a });
    /* 第 2 步：资产直链，no-cors */
    return probeOnce(assetUrl, 'no-cors');
  }).then(function (b) {
    /* 结果必须存在外层变量里：
       b 只在当前回调作用域内有效，下一个 then 里直接用 b 会 ReferenceError，
       于是整个体检在最后一步炸掉，用户只看到"体检未能完成"而没有分步结果。
       这种错只在真正跑到最后一步时才暴露，静态检查查不出来。 */
    note({ name: '资产直链（不校验跨域）', mode: 'no-cors', r: b });
    netOk = !!(b && b.ok);
    /* 第 3 步：同一 URL，cors（真实下载用的就是这个） */
    return probeOnce(assetUrl, 'cors');
  }).then(function (c) {
    note({ name: '资产直链（校验跨域，下载实际走的）', mode: 'cors', r: c });
    corsOk = !!(c && c.ok);

    /* 组合判断 */
    if (!netOk) {
      out.verdict = 'network';
      out.text = '网络层就断了：连不校验跨域的请求都发不出去。' +
        '通常是断网、公司/校园网拦了 GitHub、或浏览器插件拦截。' +
        '可试着在地址栏直接打开 ' + assetUrl + ' —— 那边也打不开的话就是网络问题，不是本项目的 bug。';
    } else if (!corsOk) {
      out.verdict = 'cors';
      out.text = '网络是通的，但跨域读取被拒绝了 —— 这是 CORS 问题，不是你的网断了。' +
        'GitHub 的下载直链会 302 跳到 objects.githubusercontent.com，' +
        '跳转途中缺少跨域头时浏览器就会这样。' +
        '这条靠本项目改代码绕不过去，需要换下载源。';
    } else {
      out.verdict = 'ok';
      out.text = '链路正常（连通性与跨域都通过）。下载若仍失败，请重试 —— 可能是瞬时抖动。';
    }
    out.assetUrl = assetUrl;
    return out;
  });
}

/* ================= 消息入口 ================= */

self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.cmd === 'diag') {
    diagnose().then(function (r) { say('diag', r); },
                    function (err) { say('diag', { verdict: 'error', text: String(err && err.message || err) }); });
    return;
  }
  if (d.cmd === 'prepare') {
    say('begin', { lang: d.lang, sizeHint: SIZE_HINT[d.lang] || 0 });
    prepare(d.lang).then(function () { say('ready', { lang: d.lang }); },
                         function (err) { say('fail', { lang: d.lang, error: explainFetchError(err) }); });
    return;
  }
  if (d.cmd === 'run') {
    var fn = RUNNERS[d.lang];
    if (!fn) { say('done', { error: '没有 ' + d.lang + ' 的运行时' }); return; }
    say('begin', { lang: d.lang, sizeHint: SIZE_HINT[d.lang] || 0 });
    prepare(d.lang).then(function () {
      say('ready', { lang: d.lang });
      return fn(d.code, d);
    }).then(function (text) {
      say('done', { text: text || '' });
    }, function (err) {
      say('done', { error: String(err && err.message || err) });
    });
    return;
  }
  if (d.cmd === 'drop') {
    /* ⚠ 清缓存必须连带丢掉已初始化的运行时实例（S-023 带出来的新要求）。
       复用之后，实例手里握着 wasm 实例；缓存清掉后那个 wasm 就不在了。
       不丢的话下次跑会直接炸，而报错看不出是"清缓存"造成的 ——
       用户会以为是运行时的 bug。 */
    Object.keys(RT_INST).forEach(function (k) { delete RT_INST[k]; });
    Object.keys(LOADED).forEach(function (k) { delete LOADED[k]; });
    caches.open(CACHE).then(function (c) { return c.keys(); }).then(function (ks) {
      return Promise.all(ks.map(function (k) {
        return caches.open(CACHE).then(function (c) { return c.delete(k); });
      }));
    }).then(function () { say('cleared', {}); });
  }
});
