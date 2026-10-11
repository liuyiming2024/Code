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
 * ── 为什么用 Cache Storage 而不是自己塞 IndexedDB ──
 * Cache Storage 就是为 HTTP 响应设计的，存进去的是完整 Response。
 * Worker 里再用 caches.match(url) 取回来，不需要自己序列化 ArrayBuffer。
 *
 * ── 为什么 Worker 里要显式读缓存 ──
 * Worker 的 fetch 不自动查 Cache Storage（它不是 HTTP cache）。
 * 必须显式 caches.match，否则"缓存后离线可用"这句承诺兑现不了。
 *
 * ── classic 与 module 两种 Worker ──
 * 胶水代码分两代：老的是 UMD（importScripts 加载），新的是 ESM（动态 import）。
 * classic worker 里没有 import，module worker 里没有 importScripts，
 * 所以只能按类型生成两份 Worker 源码，不能混。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var MANIFEST_URL = 'api/runtimes.json';
  var CACHE_NAME = 'code-runtimes-v1';
  var manifest = null;
  var state = {};           /* id -> { ready, progress, error, verified } */
  var workers = {};         /* id -> Worker */
  var jobs = {};            /* id -> Promise，防止同一运行时被重复下载 */

  /* ---------- SHA-256 ---------- */
  function sha256(buf) {
    if (global.crypto && global.crypto.subtle && global.crypto.subtle.digest) {
      return global.crypto.subtle.digest('SHA-256', buf).then(function (d) {
        return Array.prototype.map.call(new Uint8Array(d), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      });
    }
    /* 没有 crypto.subtle 就跳过校验，但要如实记下来，不能假装校验过 */
    return Promise.resolve(null);
  }

  /* ---------- 清单 ---------- */
  function loadManifest() {
    if (manifest) return Promise.resolve(manifest);
    return fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('清单读取失败：HTTP ' + r.status + '（' + MANIFEST_URL + '）');
        return r.json();
      })
      .then(function (j) {
        manifest = j;
        (j.runtimes || []).forEach(function (rt) {
          if (!state[rt.id]) state[rt.id] = { ready: false, progress: 0, error: null, verified: false };
        });
        return manifest;
      });
  }

  function findRt(id) {
    if (!manifest || !manifest.runtimes) return null;
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
      return c.put(url, new Response(buf, { status: 200 }));
    }).catch(function () { return null; });
  }

  /* ---------- 带进度下载 ----------
     用 reader 逐块读才能报进度；一次性 arrayBuffer() 拿不到中间进度。 */
  function download(url, onProgress) {
    return fetch(url, { mode: 'cors' }).then(function (res) {
      if (!res.ok) throw new Error('下载失败：HTTP ' + res.status + '（' + url + '）');
      var ct = res.headers.get('Content-Type') || '';
      /* 拿到 HTML 说明地址指向网页而非文件。文件不到 1KB 却"成功"，最坑。 */
      if (/text\/html/i.test(ct)) {
        throw new Error('下载到的是网页不是文件（Content-Type: ' + ct + '）。清单地址必须是 Release 文件直链。');
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
          if (onProgress) onProgress(got);
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

  /* ---------- 确保运行时就绪 ---------- */
  function ensure(id, onProgress) {
    if (jobs[id]) return jobs[id];
    jobs[id] = loadManifest().then(function () {
      var rt = findRt(id);
      if (!rt) throw new Error('清单里没有这个运行时：' + id);
      var st = state[id] || (state[id] = { ready: false, progress: 0, error: null, verified: false });
      st.error = null; st.progress = 0;

      var files = rt.files || [];
      var total = 0;
      files.forEach(function (f) { total += f.size || 0; });
      var doneTotal = 0;
      var i = 0;

      return next();
      function next() {
        if (i >= files.length) { st.ready = true; st.progress = 1; return true; }
        var f = files[i];
        return cachedBuf(f.url).then(function (buf) {
          if (buf) { doneTotal += f.size || 0; return verify(f, buf, true); }
          return download(f.url, function (got) {
            st.progress = total ? (doneTotal + got) / total : 0;
            if (onProgress) onProgress(st.progress, f.name);
          }).then(function (b2) { return verify(f, b2, false); });
        }).then(function (buf) {
          doneTotal += f.size || 0;
          st.progress = total ? doneTotal / total : 1;
          i++;
          return next();
        });
      }

      function verify(f, buf, fromCache) {
        return sha256(buf).then(function (h) {
          if (h === null) {
            st.verified = false;
            st.note = '本机无法计算 SHA-256（缺少 crypto.subtle），已跳过校验';
          } else if (f.sha256 && f.sha256 !== h) {
            if (!fromCache) throw new Error('校验失败：' + f.name + ' 的 SHA-256 与清单不一致');
            /* 缓存里的坏了：删掉重下 */
            return cache().then(function (c) { return c ? c.delete(f.url) : null; })
              .then(function () { return download(f.url, onProgress); })
              .then(function (b3) { return verify(f, b3, true); });
          } else {
            st.verified = true;
          }
          if (!fromCache) return putCache(f.url, buf).then(function () { return buf; }, function () { return buf; });
          return buf;
        });
      }
    }).catch(function (e) {
      var st = state[id] || (state[id] = { ready: false, progress: 0, error: null, verified: false });
      st.error = e.message || String(e);
      st.ready = false;
      delete jobs[id];
      throw e;
    });
    return jobs[id];
  }

  function status(id) { return id ? (state[id] || null) : null; }

  /* ---------- Worker 源码 ----------
     按 workerType 生成两份。加载结果挂在 self.RT 上，
     胶水要的额外文件通过 self.asset(name) 拿 blob URL（离线也能给）。 */
  function workerSource(rt) {
    var map = {};
    (rt.files || []).forEach(function (f) { map[f.name] = f.url; });
    var mapJson = JSON.stringify(map);
    var entryUrl = (rt.files || []).filter(function (f) { return f.name === rt.entry; })[0];

    var prelude = [
      "var CACHE='" + CACHE_NAME + "';",
      "var MAP=" + mapJson + ";",
      "var OUT=[];",
      "function log(s){ OUT.push(String(s)); }",
      "/* 先查 Cache Storage —— Worker 的 fetch 不会自动查，不显式 match 就兑现不了离线承诺 */",
      "function file(url){",
      "  return caches.open(CACHE).then(function(c){ return c.match(url); }).then(function(r){",
      "    if(r) return r;",
      "    return fetch(url).then(function(f){",
      "      if(!f.ok) throw new Error('取不到 '+url+'：HTTP '+f.status);",
      "      return caches.open(CACHE).then(function(c2){ c2.put(url,f.clone()); return f; });",
      "    });",
      "  });",
      "}",
      "/* 关键补丁：让运行时内部发起的 fetch 也能命中 Cache Storage。",
      "   胶水（尤其 Pyodide）会按 indexURL 自己拼出 wasm 与 stdlib 的地址去 fetch，",
      "   那些地址正是我们缓存的直链 —— 不 patch 的话，离线时它们会全部落空。 */",
      "var _fetch = self.fetch ? self.fetch.bind(self) : null;",
      "if (_fetch) {",
      "  self.fetch = function(input, init){",
      "    var url = typeof input === 'string' ? input : ((input && input.url) || '');",
      "    if (!url) return _fetch(input, init);",
      "    return caches.open(CACHE).then(function(c){ return c.match(url); }).then(function(hit){",
      "      if (hit) return hit;",
      "      return _fetch(input, init);",
      "    }).catch(function(){ return _fetch(input, init); });",
      "  };",
      "}",
      "/* 把缓存里的二进制变成 blob URL 喂给胶水，这样离线也能拿到 wasm */",
      "function asset(name){",
      "  var url=MAP[name];",
      "  if(!url) return Promise.reject(new Error('清单里没有这个文件：'+name));",
      "  return file(url).then(function(r){ return r.arrayBuffer(); }).then(function(b){",
      "    return URL.createObjectURL(new Blob([b],{type:'application/wasm'}));",
      "  });",
      "}",
      "function text(name){",
      "  var url=MAP[name];",
      "  if(!url) return Promise.reject(new Error('清单里没有这个文件：'+name));",
      "  return file(url).then(function(r){ return r.text(); });",
      "}"
    ].join('\n');

    if (rt.workerType === 'module') {
      return {
        type: 'module',
        src: [
          prelude,
          "self.onmessage = async function(e){",
          "  var d = e.data || {};",
          "  OUT = [];",
          "  try {",
          "    var src = await text(" + JSON.stringify(rt.entry) + ");",
          "    var u = URL.createObjectURL(new Blob([src],{type:'text/javascript'}));",
          "    self.RT = await import(u);",
          "    var fn = new Function('log','asset','RT','USER', 'return (async()=>{' + d.body + '})()');",
          "    var r = await fn(log, asset, self.RT, d.code);",
          "    if (r !== undefined && r !== null) log(r);",
          "  } catch(err) {",
          "    self.postMessage({ out: OUT, err: String(err && err.message || err) });",
          "    return;",
          "  }",
          "  self.postMessage({ out: OUT, err: null });",
          "};",
          "self.onerror = function(m){ self.postMessage({ out: OUT, err: String(m && m.message || m) }); };"
        ].join('\n')
      };
    }

    /* classic：UMD 胶水用 importScripts 注入。
       入口若带 .mjs 说明是 ESM，classic worker 装不了 —— 直接报清楚，别让用户干等。 */
    if (/\.mjs$/.test(rt.entry || '')) {
      throw new Error('入口 ' + rt.entry + ' 是 ESM，但清单把它标成了 classic。请把 workerType 改成 module。');
    }
    return {
      type: 'classic',
      src: [
        prelude,
        "self.onmessage = function(e){",
        "  var d = e.data || {};",
        "  OUT = [];",
        "  (function(){",
        "    return text(" + JSON.stringify(rt.entry) + ").then(function(src){",
        "      var u = URL.createObjectURL(new Blob([src],{type:'text/javascript'}));",
        "      importScripts(u);",
        "      var fn = new Function('log','asset','RT','USER','return (async()=>{' + d.body + '})()');",
        "      return fn(log, asset, self, d.code);",
        "    }).then(function(r){",
        "      if (r !== undefined && r !== null) log(r);",
        "      self.postMessage({ out: OUT, err: null });",
        "    });",
        "  })().catch(function(err){",
        "    self.postMessage({ out: OUT, err: String(err && err.message || err) });",
        "  });",
        "};",
        "self.onerror = function(m){ self.postMessage({ out: OUT, err: String(m && m.message || m) }); };"
      ].join('\n')
    };
  }

  function getWorker(id) {
    if (workers[id]) return Promise.resolve(workers[id]);
    return loadManifest().then(function () {
      var rt = findRt(id);
      if (!rt) throw new Error('清单里没有这个运行时：' + id);
      var spec = workerSource(rt);
      var blob = new Blob([spec.src], { type: 'text/javascript' });
      var url = URL.createObjectURL(blob);
      var w = new Worker(url, { type: spec.type });
      workers[id] = w;
      return w;
    });
  }

  /* body：一段 JS 源码，在 Worker 里跑。可用变量：log / asset / RT / USER */
  function runInWorker(id, body, code, timeout) {
    return getWorker(id).then(function (w) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          /* 同步死循环打不断，只能杀 Worker */
          try { w.terminate(); } catch (e) { }
          delete workers[id];
          reject(new Error('执行超时（' + Math.round((timeout || 8000) / 1000) + ' 秒），已终止 Worker'));
        }, timeout || 8000);
        w.onmessage = function (e) {
          if (done) return;
          done = true; clearTimeout(timer);
          resolve(e.data || {});
        };
        w.onerror = function (e) {
          if (done) return;
          /* 加载失败常在这里冒出来，带上 readability 提示 */
          done = true; clearTimeout(timer);
          try { w.terminate(); } catch (x) { }
          delete workers[id];
          reject(new Error(e.message || 'Worker 执行出错'));
        };
        w.postMessage({ body: body, code: code });
      });
    });
  }

  /* ---------- 清理 ---------- */
  function clearCache(id) {
    Object.keys(workers).forEach(function (k) {
      try { workers[k].terminate(); } catch (e) { }
      delete workers[k];
    });
    if (id) delete state[id]; else state = {};
    jobs = {};
    return cache().then(function (c) {
      if (!c) return false;
      var urls = [];
      var list = manifest && manifest.runtimes ? manifest.runtimes : [];
      list.forEach(function (rt) {
        if (id && rt.id !== id) return;
        (rt.files || []).forEach(function (f) { urls.push(f.url); });
      });
      return Promise.all(urls.map(function (u) { return c.delete(u); })).then(function () { return true; });
    }).catch(function () { return false; });
  }

  function totalSize(id) {
    var rt = findRt(id);
    if (!rt) return 0;
    var n = 0;
    (rt.files || []).forEach(function (f) { n += f.size || 0; });
    return n;
  }

  Code.runtime = {
    loadManifest: loadManifest,
    manifest: function () { return manifest; },
    ensure: ensure,
    status: status,
    runInWorker: runInWorker,
    clearCache: clearCache,
    totalSize: totalSize,
    findRt: findRt,
    CACHE_NAME: CACHE_NAME
  };
})(typeof window !== 'undefined' ? window : globalThis);
