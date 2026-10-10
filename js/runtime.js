/* runtime.js —— 按需运行时：下载、缓存、校验、加载
 *
 * 设计依据（Code/docs/runtimes.md，三条硬性要求）：
 *   1. 放 Web Worker —— 主线程加载几十 MB 的 WASM 会白屏好几秒
 *   2. 显示下载进度 —— 用户主动点了运行，就得知道在下载什么、还剩多少
 *   3. 说清首次需要联网 —— 缓存后离线可用，但首次不是，别装作没有
 *
 * 另外两条来自 assets 库的经验：
 *   4. 只认 Release 文件直链 —— 网页地址会下到 HTML，
 *      文件不到 1KB 却显示"成功"，这种假成功最难查
 *   5. 下载完必须校验 SHA-256 —— 清单里的哈希是唯一可信依据
 *
 * 为什么用 Cache Storage 而不是 IndexedDB 存二进制：
 *   Cache Storage 就是为 HTTP 响应设计的，存进去的是完整 Response，
 *   下次 fetch 直接命中，不用自己序列化 ArrayBuffer。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var MANIFEST_URL = 'api/runtimes.json';
  var CACHE_NAME = 'code-runtimes-v1';
  var manifest = null;          /* 清单（含真实 sha256 与直链） */
  var state = {};               /* id -> { ready, progress, error, size } */
  var workers = {};             /* id -> Worker */
  var jobs = {};                /* id -> Promise，防止重复下载 */

  /* ---------- SHA-256（Web Crypto，本机计算，不上传） ---------- */
  function sha256(buf) {
    if (global.crypto && global.crypto.subtle) {
      return global.crypto.subtle.digest('SHA-256', buf).then(function (d) {
        return Array.prototype.map.call(new Uint8Array(d), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      });
    }
    /* 没有 crypto.subtle（比如 file:// 下部分浏览器）就跳过校验，
       但要如实标记，不能假装校验过 */
    return Promise.resolve(null);
  }

  /* ---------- 清单 ---------- */
  function loadManifest() {
    if (manifest) return Promise.resolve(manifest);
    return fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('清单读取失败：HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        manifest = j;
        (j.runtimes || []).forEach(function (rt) {
          state[rt.id] = state[rt.id] || { ready: false, progress: 0, error: null };
        });
        return manifest;
      });
  }

  function findRt(id) {
    if (!manifest) return null;
    for (var i = 0; i < manifest.runtimes.length; i++) {
      if (manifest.runtimes[i].id === id) return manifest.runtimes[i];
    }
    return null;
  }

  /* ---------- 缓存 ---------- */
  function cache() {
    if (!global.caches) return Promise.resolve(null);
    return global.caches.open(CACHE_NAME);
  }

  function cachedBuf(url) {
    return cache().then(function (c) {
      if (!c) return null;
      return c.match(url).then(function (r) { return r ? r.arrayBuffer() : null; });
    }).catch(function () { return null; });
  }

  function putCache(url, buf) {
    return cache().then(function (c) {
      if (!c) return null;
      return c.put(url, new Response(buf, { status: 200, headers: { 'Content-Type': 'application/wasm' } }));
    }).catch(function () { return null; });
  }

  /* ---------- 带进度的下载 ----------
     用 reader 逐块读，才能报进度。一次性 res.arrayBuffer() 拿不到中间进度。 */
  function download(url, onProgress) {
    return fetch(url, { mode: 'cors' }).then(function (res) {
      if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
      var total = parseInt(res.headers.get('Content-Length') || '0', 10);
      /* 直链校验：拿到的是 HTML 说明地址指向了网页而非文件 */
      var ct = res.headers.get('Content-Type') || '';
      if (/text\/html/i.test(ct)) {
        throw new Error('下载到的不是文件而是网页（Content-Type: ' + ct + '）。' +
          '清单里的地址必须是 Release 文件直链。');
      }
      if (!res.body || !res.body.getReader) return res.arrayBuffer();

      var reader = res.body.getReader();
      var chunks = [], got = 0;
      return pump();
      function pump() {
        return reader.read().then(function (step) {
          if (step.done) return concat(chunks, got);
          chunks.push(step.value);
          got += step.value.length;
          if (onProgress) onProgress(got, total);
          return pump();
        });
      }
    });
  }

  function concat(chunks, len) {
    var out = new Uint8Array(len), p = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].length; }
    return out.buffer;
  }

  /* ---------- 确保某个运行时就绪 ---------- */
  function ensure(id, onProgress) {
    if (jobs[id]) return jobs[id];
    jobs[id] = loadManifest().then(function () {
      var rt = findRt(id);
      if (!rt) throw new Error('清单里没有这个运行时：' + id);
      var st = state[id] || (state[id] = { ready: false, progress: 0, error: null });
      st.error = null;
      st.progress = 0;

      var files = rt.files || [{ name: rt.file, url: rt.url, sha256: rt.sha256, size: rt.size }];
      var got = [];
      var i = 0;

      return next();
      function next() {
        if (i >= files.length) { st.ready = true; st.progress = 1; return got; }
        var f = files[i];
        return cachedBuf(f.url).then(function (buf) {
          if (buf) return verify(f, buf, true);
          /* 未缓存 → 下载 */
          return download(f.url, function (done, total) {
            var base = i / files.length;
            var within = total ? (done / total) : 0;
            st.progress = base + within / files.length;
            if (onProgress) onProgress(st.progress, f.name);
          }).then(function (buf2) { return verify(f, buf2, false); });
        }).then(function (buf) {
          got.push({ name: f.name, buf: buf });
          i++;
          return next();
        });
      }

      function verify(f, buf, fromCache) {
        return sha256(buf).then(function (h) {
          /* crypto 不可用时无法校验，如实记录，不谎称"校验通过" */
          if (h === null) {
            st.verified = false;
            st.note = '本机无法计算 SHA-256，已跳过校验';
          } else if (f.sha256 && f.sha256 !== h) {
            if (!fromCache) throw new Error('校验失败：' + f.name + ' 的 SHA-256 与清单不一致');
            /* 缓存里的坏了，删掉重下 */
            return cache().then(function (c) {
              if (c) return c.delete(f.url);
            }).then(function () {
              return download(f.url, onProgress).then(function (b2) { return verify(f, b2, true); });
            });
          } else {
            st.verified = true;
          }
          if (!fromCache) return putCache(f.url, buf).then(function () { return buf; }, function () { return buf; });
          return buf;
        });
      }
    }).catch(function (e) {
      var st = state[id] || (state[id] = { ready: false, progress: 0, error: null });
      st.error = e.message || String(e);
      st.ready = false;
      delete jobs[id];
      throw e;
    });
    return jobs[id];
  }

  function status(id) {
    if (!id) return null;
    return state[id] || null;
  }

  /* ---------- Worker ----------
     WASM 必须在 Worker 里加载，否则主线程会卡死好几秒。
     Worker 代码内联成 Blob，避免多一个需要随仓库分发的文件。 */
  function workerCode(id) {
    return [
      "self.onmessage = function (e) {",
      "  var d = e.data || {};",
      "  if (d.cmd !== 'run') return;",
      "  var res = { id: d.id, out: [], err: null };",
      "  function push(s) { res.out.push(String(s)); }",
      "  try {",
      "    var origLog = console.log;",
      "    console.log = function () {",
      "      push(Array.prototype.map.call(arguments, String).join(' '));",
      "    };",
      "    (function () {",
      "      try { eval(d.code); } catch (err) { res.err = String(err && err.message || err); }",
      "    })();",
      "    console.log = origLog;",
      "  } catch (err) { res.err = String(err && err.message || err); }",
      "  self.postMessage(res);",
      "};",
      "self.onerror = function (m) { self.postMessage({ id: null, err: String(m && m.message || m) }); };"
    ].join('\n');
  }

  function getWorker(id) {
    if (workers[id]) return workers[id];
    var blob = new Blob([workerCode(id)], { type: 'text/javascript' });
    var url = URL.createObjectURL(blob);
    var w = new Worker(url);
    workers[id] = w;
    return w;
  }

  /* 在 Worker 里跑一段代码，返回结果 */
  function runInWorker(id, code, timeout) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = getWorker(id); }
      catch (e) { reject(new Error('无法创建 Worker：' + e.message)); return; }
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        /* 超时只能杀掉 Worker —— 同步死循环无法从内部中断 */
        try { w.terminate(); } catch (e) { }
        delete workers[id];
        reject(new Error('执行超时，已终止'));
      }, timeout || 5000);
      w.onmessage = function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(e.data || {});
      };
      w.onerror = function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(e.message || 'Worker 执行出错'));
      };
      w.postMessage({ cmd: 'run', id: id, code: code });
    });
  }

  /* ---------- 清理 ---------- */
  function clearCache() {
    state = {}; jobs = {};
    return cache().then(function (c) {
      if (!c) return false;
      return Promise.all((manifest ? manifest.runtimes : []).map(function (rt) {
        var files = rt.files || [{ url: rt.url }];
        return Promise.all(files.map(function (f) { return c.delete(f.url); }));
      })).then(function () { return true; });
    }).catch(function () { return false; });
  }

  Code.runtime = {
    loadManifest: loadManifest,
    manifest: function () { return manifest; },
    ensure: ensure,
    status: status,
    runInWorker: runInWorker,
    clearCache: clearCache,
    CACHE_NAME: CACHE_NAME
  };
})(typeof window !== 'undefined' ? window : globalThis);
