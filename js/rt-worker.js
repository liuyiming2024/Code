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
    caches.open(CACHE).then(function (c) { return c.keys(); }).then(function (ks) {
      return Promise.all(ks.map(function (k) {
        return caches.open(CACHE).then(function (c) { return c.delete(k); });
      }));
    }).then(function () { say('cleared', {}); });
  }
});
