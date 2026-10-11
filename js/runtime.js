/* runtime.js —— 运行时清单与缓存状态（只查，不下载）
 *
 * 重要：下载与执行不在这里。
 *   下载 + 执行 → js/runtimes.js（主线程侧） + js/rt-worker.js（Worker 侧）
 *   本模块     → 清单读取、体积查询、缓存状态、清理
 *
 * 为什么拆开：两套下载逻辑并存会互相打架（一边在下一边在读、进度各报各的）。
 * 之前这里自己实现过一套 ensure/runInWorker，与 rt-worker.js 重复，已删。
 *
 * 清单里的 SHA-256 取自 GitHub Release 资产的 digest 字段，不是人工抄写 ——
 * 人工抄哈希抄错一位就会让"校验通过"变成谎言。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var MANIFEST_URL = 'api/runtimes.json';
  var CACHE_NAME = 'code-runtimes-v1';
  var manifest = null;
  var state = {};           /* id -> { ready, progress, error, verified } */

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
    /* 没有 fetch（老浏览器或某些内嵌环境）就直接放弃，不能让异常中断启动流程 */
    if (typeof fetch !== 'function') {
      return Promise.reject(new Error('当前环境没有 fetch，无法读取运行时清单'));
    }
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

  /* 本模块不做下载，也不建 Worker —— 那是 runtimes.js + rt-worker.js 的活。
     这里只回答三个问题：有哪些运行时、每个多大、缓存里有没有。
     两套下载逻辑并存只会互相打架，所以只留一套。 */

  /* 缓存里是否已有某运行时的全部文件。用于界面显示"已下载 / 未下载"。 */
  function hasCached(id) {
    return loadManifest().then(function () {
      var rt = findRt(id);
      if (!rt || !rt.files || !rt.files.length) return false;
      return cache().then(function (c) {
        if (!c) return false;
        return Promise.all(rt.files.map(function (f) {
          return c.match(f.url).then(function (r) { return !!r; });
        })).then(function (rs) {
          return rs.every(function (x) { return x; });
        });
      }).catch(function () { return false; });
    });
  }

  function status(id) {
    if (!id) return null;
    return state[id] || null;
  }

  /* 页面启动时跑一次：把每个运行时的缓存状态探出来，供界面显示"已下载 / 未下载"。
     不做下载 —— 那是 runtimes.js 的活。这里只回答"缓存里有没有"。 */
  function refreshStatus() {
    /* 这是界面显示用的探测，绝不能因为它把启动流程打断 —— 包住同步抛错的路径 */
    try {
      return probe();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function probe() {
    return loadManifest().then(function (m) {
      var ids = (m.runtimes || []).map(function (rt) { return rt.id; });
      return Promise.all(ids.map(function (id) {
        return hasCached(id).then(function (ok) {
          var st = state[id] || (state[id] = {});
          st.ready = ok;
          st.error = null;
        });
      })).then(function () { return state; });
    }).catch(function () { return state; });
  }

  /* ---------- 清理 ----------
     删缓存里的文件。执行用的 Worker 由 runtimes.js 管理，这里不管。 */
  function clearCache(id) {
    state = {};
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
    findRt: findRt,
    hasCached: hasCached,
    refreshStatus: refreshStatus,
    status: status,
    clearCache: clearCache,
    totalSize: totalSize,
    CACHE_NAME: CACHE_NAME
  };
})(typeof window !== 'undefined' ? window : globalThis);
