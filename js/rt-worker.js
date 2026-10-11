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

/* 文件名里有 + 的（ruby+stdlib.wasm）必须编码成 %2B —— Release 直链就是这么给的。
   不统一的话下载用一个 key、清理用另一个 key，缓存会对不上。 */
function urlOf(name) {
  return BASE + name.replace(/\+/g, '%2B');
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
  (NEED[k] || []).forEach(function (n) { KNOWN_NAMES[n] = urlOf(n); });
});

function cacheUrlFor(url) {
  if (url.indexOf(BASE) === 0) return url;
  var q = url.indexOf('?');
  var base = q < 0 ? url : url.slice(0, q);
  var name = base.slice(base.lastIndexOf('/') + 1);
  try { name = decodeURIComponent(name); } catch (e) { }
  /* 只认 GitHub 自己的域名，避免把别处的同名文件也劫走 */
  if (KNOWN_NAMES[name] && /^https?:\/\/[^/]*github/.test(url)) return KNOWN_NAMES[name];
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

/* 下载单个文件，带进度。已缓存则直接跳过（不产生流量）。 */
function grab(name, doneBytes, totalBytes) {
  var url = urlOf(name);
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
      return fromCache(urlOf(f)).then(function (hit) { return hit ? 0 : null; });
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
  importScripts(urlOf(name));
}

/* ESM 胶水（ruby-wasi.js）不能走 importScripts。
   classic worker 里可以用动态 import() 加载 ESM ——
   这正是它与 importScripts 的关键区别，别混为一谈。 */
function loadESM(name) {
  if (typeof import !== 'function') {
    return Promise.reject(new Error(
      '当前 Worker 不支持动态 import()，无法加载 ESM 胶水 ' + name +
      '。已知影响：Ruby 不可用，其余语言不受影响。'));
  }
  return import(urlOf(name));
}

/* ================= 各语言执行 ================= */

function runSQL(code) {
  load('sql-wasm.js');
  return Promise.resolve(self.initSqlJs({ locateFile: function (f) { return urlOf(f); } }))
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
      return fn(d.code, d);
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
