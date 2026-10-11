/* rt-worker.js —— 运行时 Worker（classic 类型）
   ------------------------------------------------------------------
   所有 WASM 运行时都在这里加载并执行，主线程只管显示，不干重活。

   为什么必须用 Worker：
     clang.wasm 40 MB、ruby 33 MB，在主线程编译会白屏好几秒甚至十几秒。
     Worker 里卡住，页面照样能响应。

   为什么是 classic 而不是 module：
     importScripts 能吃 UMD（sql.js / pyodide / lua / clang 都是 UMD 或
     Emscripten 输出）。module worker 不支持 importScripts，而 ESM 版资源
     我们没抓 —— 所以走 classic，只用 UMD 资源。

   ⚠ 首次运行需要联网下载运行时；之后走 Cache Storage，断网也能用。
     这一点必须在界面上说清楚，静默失败是最差体验。
*/
'use strict';

var BASE = 'https://github.com/liuyiming2024/assets/releases/latest/download/';
var CACHE = 'code-runtimes-v1';

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
self.fetch = function (input, opts) {
  var url = typeof input === 'string' ? input : (input && input.url) || '';
  if (!origFetch || url.indexOf(BASE) !== 0) return origFetch(input, opts);
  return caches.open(CACHE).then(function (c) {
    return c.match(url);
  }).then(function (hit) {
    if (hit) return hit;
    return origFetch(input, opts).then(function (r) {
      return caches.open(CACHE).then(function (c) {
        try { c.put(url, r.clone()); } catch (e) { /* 配额满就算了 */ }
        return r;
      });
    });
  });
};

function fromCache(url) {
  return caches.open(CACHE).then(function (c) { return c.match(url); });
}

/* 下载单个文件，带进度。已缓存则直接跳过（不产生流量）。 */
function grab(name, doneBytes, totalBytes) {
  var url = BASE + name;
  return fromCache(url).then(function (hit) {
    if (hit) return { buf: null, cached: true };
    var resp;
    return origFetch(url).then(function (r) {
      if (!r.ok) throw new Error(name + ' 下载失败：HTTP ' + r.status);
      resp = r;
      var len = parseInt(r.headers.get('content-length') || '0', 10);
      if (!r.body || !len) return r.arrayBuffer().then(function (b) {
        return { buf: b, size: b.byteLength };
      });
      // 分片读取，边下边报进度 —— 大文件不报进度等于让用户干等
      var reader = r.body.getReader(), chunks = [], got = 0;
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) {
            var all = new Uint8Array(got), at = 0;
            for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], at); at += chunks[i].length; }
            return { buf: all.buffer, size: got };
          }
          chunks.push(x.value); got += x.value.length;
          say('progress', { file: name, loaded: doneBytes + got,
                            total: totalBytes || len,
                            pct: totalBytes ? Math.floor((doneBytes + got) / totalBytes * 100)
                                            : Math.floor(got / len * 100) });
          return pump();
        });
      }
      return pump();
    }).then(function (res) {
      if (res.buf) {
        return caches.open(CACHE).then(function (c) {
          try {
            c.put(url, new Response(res.buf, {
              headers: { 'content-type': 'application/octet-stream' }
            }));
          } catch (e) { /* 配额满就算了，下次重新下 */ }
          return { buf: res.buf, size: res.size };
        });
      }
      return res;
    });
  });
}

/* 预下载某语言需要的全部文件，逐个报进度。 */
function prepare(lang) {
  var files = NEED[lang] || [];
  var done = 0;
  // 先探一次总大小，好算总进度。缓存命中就不算进总量。
  return files.reduce(function (p, f) {
    return p.then(function () {
      return fromCache(BASE + f).then(function (hit) { return hit ? 0 : null; });
    }).then(function (skip) {
      if (skip === 0) return 0;
      return grab(f, done, 0).then(function (r) {
        done += r.size || 0;
        return r.size || 0;
      });
    });
  }, Promise.resolve(0)).then(function () {
    say('progress', { file: '', pct: 100 });
  });
}

function load(name) {
  // importScripts 是同步的，加载失败会抛 —— 直接冒泡出去
  importScripts(BASE + name);
}

/* ================= 各语言执行 ================= */

function runSQL(code) {
  load('sql-wasm.js');
  return Promise.resolve(self.initSqlJs({ locateFile: function (f) { return BASE + f; } }))
    .then(function (SQL) {
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
  return Promise.resolve(self.loadPyodide({
    indexURL: BASE,
    stdout: function (s) { buf += s + '\n'; }
  })).then(function (py) {
    try {
      var r = py.runPython(code);
      if (r !== undefined && r !== null) buf += String(r);
    } catch (e) {
      buf += '\n' + String(e && e.message || e);
    }
    return buf;
  });
}

function runLua(code) {
  // fengari-web.js 是 webpack 打包好的，fengari 核心已 bundle 在内
  load('fengari-web.js');
  return Promise.resolve().then(function () {
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
      var php = new PhpWeb({ locateFile: function (f) { return BASE + f; } });
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
  // ruby-wasi.js 是 ESM 构建，classic worker 的 importScripts 吃不下。
  // 先明确报出来，不要静默失败。
  return Promise.reject(new Error(
    'Ruby 运行时是 ESM 构建，classic Worker 无法 importScripts。' +
    '需要改用 module Worker 或抓 IIFE 版资源。'));
}

function runCpp(code) {
  load('cpp-index.js');
  load('clang.js');
  load('lld.js');
  load('wasi-shim.js');
  return Promise.resolve().then(function () {
    var compile = self.compile || (self.browsercc && self.browsercc.compile);
    if (!compile) throw new Error('browsercc 的 compile 未导出');
    return compile({ source: code, fileName: 'main.cpp', flags: [] });
  }).then(function (r) {
    var out = [];
    if (r.compileOutput) out.push(r.compileOutput);
    if (!r.module) return out.join('\n');
    var WASI = self.WASI || (self.browser_wasi_shim && self.browser_wasi_shim.WASI);
    if (!WASI) { out.push('（WASI shim 未加载，无法执行编译产物）'); return out.join('\n'); }
    var captured = '';
    var ConsoleStdout = self.ConsoleStdout ||
      (self.browser_wasi_shim && self.browser_wasi_shim.ConsoleStdout);
    var File = self.File || (self.browser_wasi_shim && self.browser_wasi_shim.File);
    var OpenFile = self.OpenFile || (self.browser_wasi_shim && self.browser_wasi_shim.OpenFile);
    var sink = function (d) { captured += new TextDecoder().decode(d); };
    var fds = [new OpenFile(new File([])),
               new ConsoleStdout(sink), new ConsoleStdout(sink)];
    var wasi = new WASI([], [], fds);
    return WebAssembly.instantiate(r.module, {
      wasi_snapshot_preview1: wasi.wasiImport
    }).then(function (inst) {
      try { wasi.start(inst); } catch (e) {
        // WASI 的 _start 结束后会抛一个退出信号，属正常
        if (!/exit|unreachable/i.test(String(e && e.message))) throw e;
      }
      out.push(captured);
      return out.join('\n');
    });
  });
}

var RUNNERS = {
  sql: runSQL, python: runPython, lua: runLua,
  php: runPHP, ruby: runRuby, cpp: runCpp
};

/* ================= 消息入口 ================= */

self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.cmd === 'prepare') {
    say('begin', { lang: d.lang, sizeHint: SIZE_HINT[d.lang] || 0 });
    prepare(d.lang).then(function () { say('ready', { lang: d.lang }); },
                         function (err) { say('fail', { lang: d.lang, error: String(err && err.message || err) }); });
    return;
  }
  if (d.cmd === 'run') {
    var fn = RUNNERS[d.lang];
    if (!fn) { say('done', { error: '没有 ' + d.lang + ' 的运行时' }); return; }
    say('begin', { lang: d.lang, sizeHint: SIZE_HINT[d.lang] || 0 });
    prepare(d.lang).then(function () {
      say('ready', { lang: d.lang });
      return fn(d.code);
    }).then(function (text) {
      say('done', { text: text || '' });
    }, function (err) {
      say('done', { error: String(err && err.message || err) });
    });
    return;
  }
  if (d.cmd === 'drop') {
    caches.open(CACHE).then(function (c) { return c.keys(); }).then(function (ks) {
      return Promise.all(ks.map(function (k) {
        return caches.open(CACHE).then(function (c) { return c.delete(k); });
      }));
    }).then(function () { say('cleared', {}); });
  }
});
