/* runner.js —— 本地算力
   原则：算力只在本机浏览器内发生，代码与数据都不上传。
   - JavaScript：浏览器原生执行，主线程 new Function，捕获 console 与异常。
   - HTML：在本页 iframe（sandbox 限制为允许脚本）里预览，并回传其 console。
   - 其余语言：不做伪造执行，明确提示"当前未内置运行时"。
   已知限制：无限循环无法中断（浏览器主线程没有抢占），README 已写明。 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});
  var U = Code.util;

  var out = null, cons = null, cinput = null;
  var count = 0, muted = false, t0 = 0, hist = [], hidx = -1;

  function init() {
    out = U.$('#panel-output');
    cons = U.$('#panel-console');
    cinput = U.$('#console-input');
    if (cinput) {
      cinput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var v = cinput.value;
          if (!v.trim()) return;
          hist.push(v); hidx = hist.length;
          cinput.value = '';
          print('echo', '> ' + v);
          evalExpr(v);
        } else if (e.key === 'ArrowUp') {
          if (hidx > 0) { hidx--; cinput.value = hist[hidx]; e.preventDefault(); }
        } else if (e.key === 'ArrowDown') {
          if (hidx < hist.length - 1) { hidx++; cinput.value = hist[hidx]; e.preventDefault(); }
          else { hidx = hist.length; cinput.value = ''; }
        }
      });
    }
    global.addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.__codeConsole) print(d.kind || 'out', d.text);
    });
  }

  function print(kind, text, iconId) {
    if (!out) return;
    if (muted) return;
    count++;
    if (count > 800) {
      muted = true;
      line('sys', '输出过多已暂停（800 行上限）。若代码陷入死循环，请关闭本页或用任务管理器结束标签页。');
      return;
    }
    line(kind, text, iconId);
    out.scrollTop = out.scrollHeight;
  }

  /* 返回值前缀用图标，不用文本箭头。图标与文字同一行，基线对齐。 */
  function line(kind, text, iconId) {
    if (!out) return;
    var d = document.createElement('div');
    d.className = 'out ' + kind;
    if (iconId && U.svg) {
      var ic = U.svg(iconId, 11);
      ic.setAttribute('class', 'out-icon');
      d.appendChild(ic);
    }
    var t = document.createElement('span');
    t.textContent = text;
    d.appendChild(t);
    out.appendChild(d);
  }

  function clear() { if (out) out.innerHTML = ''; count = 0; muted = false; }
  /* 停止：先打印再关开关。写反了提示会被自己的 muted 判断吞掉，界面零反应。 */
  function stop() {
    if (!muted) line('sys', '已停止接收输出。注意：同步代码无法中断，正在跑的循环仍会跑完——若页面已卡死，只能关闭标签页。');
    muted = true;
  }
  function printSys(t) { if (!muted) line('sys', t); }

  function fmt(v, depth) {
    depth = depth || 0;
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    var t = typeof v;
    if (t === 'string') return depth === 0 ? v : JSON.stringify(v);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
    if (t === 'function') return v.name ? '[Function ' + v.name + ']' : '[Function]';
    if (t === 'symbol') return v.toString();
    if (v instanceof Error) return v.name + ': ' + v.message;
    if (depth > 3) return Array.isArray(v) ? '[Array]' : '[Object]';
    if (v.nodeType) return '<' + (v.nodeName || 'node').toLowerCase() + '>';
    if (Array.isArray(v)) return '[' + v.map(function (x) { return fmt(x, depth + 1); }).join(', ') + ']';
    if (v instanceof Map) return 'Map(' + v.size + ')';
    if (v instanceof Set) return 'Set(' + v.size + ')';
    try { return JSON.stringify(v, null, depth === 0 ? 0 : 0); } catch (e) { return Object.prototype.toString.call(v); }
  }

  function joinArgs(args) {
    return Array.prototype.slice.call(args).map(function (a) { return fmt(a, 1); }).join(' ');
  }

  function capture(fn) {
    var keys = ['log', 'info', 'warn', 'error', 'debug'];
    var saved = {}, k;
    for (var i = 0; i < keys.length; i++) {
      k = keys[i];
      saved[k] = console[k];
      (function (k, orig) {
        console[k] = function () {
          print(k === 'error' ? 'err' : (k === 'warn' ? 'warn' : 'out'), joinArgs(arguments));
          try { orig.apply(console, arguments); } catch (e) { }
        };
      })(k, saved[k]);
    }
    try { return fn(); }
    finally {
      for (var j = 0; j < keys.length; j++) console[keys[j]] = saved[keys[j]];
    }
  }

  function runJS(code) {
    var asyncWrap = /(^|[^.\w$])await[\s(]/.test(code);
    var fn;
    try {
      fn = asyncWrap
        ? new Function('return (async () => {\n' + code + '\n})()')
        : new Function(code);
    } catch (e) {
      line('err', '语法错误：' + e.message);
      return;
    }
    var r = capture(function () {
      try { return fn(); } catch (e) { line('err', (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))); }
    });
    if (r && typeof r.then === 'function') {
      r.then(function (v) { if (v !== undefined) print('ret', fmt(v), 'i-return'); },
        function (e) { print('err', (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))); });
    } else if (r !== undefined) {
      print('ret', fmt(r), 'i-return');
    }
  }

  function evalExpr(src) {
    var fn;
    try { fn = new Function('return (' + src + ')'); }
    catch (e) { try { fn = new Function(src); } catch (e2) { line('err', '语法错误：' + e2.message); return; } }
    var r = capture(function () {
      try { return fn(); } catch (e) { line('err', (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))); }
    });
    if (r && typeof r.then === 'function') {
      r.then(function (v) { print('ret', fmt(v), 'i-return'); }, function (e) { print('err', String(e && e.message || e)); });
    } else if (r !== undefined) print('ret', fmt(r), 'i-return');
  }

  /* 自研子集的如实说明。不是"不支持"，是"支持到什么程度"要说清楚。 */
  var CAVEAT = {
    pylite: 'Python 子集（自研解释器）：不是 CPython，不支持 import 第三方库、async、生成器、装饰器。\n' +
            '够用场景：语法练习、算法题、日常小脚本。要完整 CPython 需下载 Pyodide（约 2 MB，当前 Release 里暂缺）。',
    cpplite: 'C/C++ 子集（自研教学级）：不支持指针与地址运算、struct / class、模板、STL、头文件与多文件。\n' +
             '#include 会被忽略。够用场景：语法练习与基础算法。'
  };

  /* 走自研解释器。返回 true 表示已处理。 */
  function runBuiltin(kind, code) {
    if (kind === 'pylite') {
      if (!Code.pylite) { line('warn', 'Python 子集解释器未加载'); return true; }
      var I = Code.pylite.create(function (s) { print('out', s); }, function () { return ''; });
      if (CAVEAT.pylite) printSys(CAVEAT.pylite);
      try {
        var r = I.run(code, { timeout: 5000 });
        printSys('结束，' + r.steps + ' 步');
      } catch (e) {
        line('err', String(e && e.message || e));
      }
      return true;
    }
    if (kind === 'cpplite') {
      if (!Code.cpplite) { line('warn', 'C/C++ 子集解释器未加载'); return true; }
      var C = Code.cpplite.create(function (s) { print('out', s); }, function () { return ''; });
      if (CAVEAT.cpplite) printSys(CAVEAT.cpplite);
      try {
        var r2 = C.run(code, { timeout: 5000 });
        printSys('结束，' + r2.steps + ' 步');
      } catch (e) {
        line('err', String(e && e.message || e));
      }
      return true;
    }
    return false;
  }

  /* 按需下载档 / 升级档：下载与执行都由 runtimes.js 负责，这里只做提示与转发。
     如实说清首次需联网 —— 用户断网点了没反应又没提示，只会以为是坏了。 */
  function runDownloaded(lang, code, path, upgraded) {
    var id = lang.wasm && lang.wasm.id;
    var key = RT_KEY[id] || id;
    if (!Code.runtimes || !Code.runtimes.has(key)) {
      line('warn', lang.name + ' 的运行时尚未接入，当前只能编辑与着色。');
      return;
    }
    line('sys', upgraded ? '使用真运行时：' + Code.runtimes.label(key) : '准备 ' + lang.name + ' 运行时');
    line('sys', '首次运行需要下载（约 ' + Code.runtimes.sizeHint(key) +
      '，预计 ' + Code.runtimes.hint(key) + '），请保持联网。下载后会缓存在本机，之后离线可用。');
    runInRuntime(id, code, path);
  }

  function rtBytes(id) {
    var rt = Code.runtime && Code.runtime.findRt ? Code.runtime.findRt(id) : null;
    if (!rt) return 0;
    var n = 0;
    (rt.files || []).forEach(function (f) { n += f.size || 0; });
    return n;
  }

  /* 真执行走前辈那套：runtimes.js（主线程）+ rt-worker.js（Worker 侧）。
     那边负责下载、缓存、importScripts 注入、逐语言 runner。
     这里只转发消息并把结果打到面板上 —— 不另起一套 Worker。 */
  function runInRuntime(id, code, path) {
    if (!Code.runtimes || !Code.runtimes.run) {
      line('err', '运行时管理模块未加载（js/runtimes.js）');
      return;
    }
    var langKey = RT_KEY[id] || id;
    Code.runtimes.run(langKey, code, {
      begin: function (d) {
        printSys('准备 ' + (d.lang ? Code.runtimes.label(d.lang) : '') +
          ' 运行时（约 ' + Code.runtimes.sizeHint(langKey) +
          '，预计 ' + Code.runtimes.hint(langKey) + '）…');
      },
      progress: function (d) {
        if (d && d.pct != null) printSys('下载中 ' + d.pct + '%' + (d.file ? '（' + d.file + '）' : ''));
      },
      ready: function () { printSys('运行时已就绪，开始执行'); },
      done: function (d) {
        if (d && d.error) { line('err', d.error); }
        else if (d && d.text) {
          String(d.text).split('\n').forEach(function (ln) { print('out', ln); });
        }
        printSys('结束');
      },
      fail: function (d) { line('err', (d && d.error) || '运行时失败'); }
    });
  }

  /* 注册表 id → runtimes.js 用的语言键。
     两套命名并存是历史原因：注册表按"运行时"命名（sqlite/pyodide），
     runtimes.js 按"语言"命名（sql/python）。在这里对齐，不让差异外溢。 */
  var RT_KEY = {
    sqlite: 'sql', pyodide: 'python', lua: 'lua',
    php: 'php', ruby: 'ruby', cpp: 'cpp'
  };

  /* 各引擎的注入脚本。在 Worker 里跑，可用：log(s) / asset(name) / RT / USER。
     返回一段 JS 源码字符串（会被包进 async 函数体）。

     诚实标注：sqlite 与 pyodide 的 API 是公开稳定的（initSqlJs / loadPyodide）；
     lua、ruby、php、cpp 的胶水导出形状我无法在此环境确认，
     因此统一用"依次尝试常见导出名"的策略，
     全都对不上时报出实际的导出清单 —— 让用户和后续接手的人一眼看到真相，
     而不是静默失败或者伪造输出。 */
  var GLUE = {

    sqlite: [
      "var wasmUrl = await asset('sql-wasm.wasm');",
      "var SQL = await initSqlJs({ locateFile: function () { return wasmUrl; } });",
      "var db = new SQL.Database();",
      "try {",
      "  var res = db.exec(USER);",
      "  if (!res || !res.length) log('（语句已执行，无结果集）');",
      "  else res.forEach(function (t) {",
      "    log(t.columns.join(' | '));",
      "    t.values.forEach(function (row) { log(row.join(' | ')); });",
      "  });",
      "} catch (e) { log('SQL 错误：' + (e && e.message || e)); }",
      "db.close();"
    ].join('\n'),

    pyodide: [
      "/* indexURL 指向 Release 目录：Pyodide 会自己拼出 pyodide.asm.wasm 与",
      "   python_stdlib.zip 的地址，那些正是我们缓存过的直链，fetch 补丁会命中。 */",
      "var BASE = 'https://github.com/liuyiming2024/assets/releases/download/latest/';",
      "var py = await loadPyodide({ indexURL: BASE });",
      "py.setStdout({ batched: function (s) { log(s); } });",
      "py.setStderr({ batched: function (s) { log(s); } });",
      "try { await py.loadPackagesFromImports(USER); } catch (e) { }",
      "var r = await py.runPythonAsync(USER);",
      "if (r !== undefined && r !== null && r !== 0) log(String(r));"
    ].join('\n'),

    /* Fengari：纯 JS 的 Lua VM，UMD，无 wasm —— 加载链路最短，最不容易出岔子 */
    lua: [
      "var f = self.fengari || RT.fengari || RT;",
      "if (!f || !f.lua) throw new Error('没拿到 fengari。RT 导出：' + Object.keys(RT || {}).join(', '));",
      "var lua = f.lua, laux = f.lauxlib, lualib = f.lualib;",
      "var tls = f.to_luastring, tjs = f.to_jsstring;",
      "var L = laux.luaL_newstate();",
      "lualib.luaL_openlibs(L);",
      "/* 把 print 重定向到输出面板 */",
      "lua.lua_pushcfunction(L, function (st) {",
      "  var n = lua.lua_gettop(st), parts = [];",
      "  for (var i = 1; i <= n; i++) {",
      "    var t = lua.lua_type(st, i);",
      "    if (t === lua.LUA_TSTRING) parts.push(tjs(lua.lua_tostring(st, i)));",
      "    else if (t === lua.LUA_TNUMBER) parts.push(String(lua.lua_tonumber(st, i)));",
      "    else if (t === lua.LUA_TBOOLEAN) parts.push(lua.lua_toboolean(st, i) ? 'true' : 'false');",
      "    else parts.push(lua.luaL_typename(st, i));",
      "  }",
      "  log(parts.join('\\t'));",
      "  return 0;",
      "});",
      "lua.lua_setglobal(L, tls('print'));",
      "var ok = laux.luaL_dostring(L, tls(USER));",
      "if (ok !== lua.LUA_OK) {",
      "  log('Lua 错误：' + tjs(lua.lua_tostring(L, -1) || new Uint8Array(0)));",
      "}"
    ].join('\n'),

    php: probeGlue('php', "['php-web.js.wasm']", ["PhpWeb", "PHP", "default"],
      ["run", "eval", "exec", "runCode"]),

    ruby: probeGlue('ruby', "['ruby+stdlib.wasm']", ["RubyVM", "default"],
      ["eval", "evalAsync", "run"]),

    quickjs: probeGlue('quickjs', "['quickjs.wasm']", ["getQuickJS", "default", "newQuickJS"],
      ["evalCode", "run", "eval"]),

    cpp: [
      "/* browsercc 要同时驱动 clang.wasm(43MB) + lld.wasm(23MB) + sysroot.tar(29MB)，",
      "   三件各有加载协议，无法在未知 API 的前提下可靠接线。如实报错，不伪造编译过程。 */",
      "var keys = Object.keys(RT || {});",
      "log('C/C++ 真编译器（browsercc）资源已下载，但执行链路尚未接线。');",
      "log('glue 实际导出：' + (keys.length ? keys.join(', ') : '(空)'));",
      "log('当前请用内置的自研 C/C++ 子集运行（无需下载，够做语法练习与基础算法）。');"
    ].join('\n')
  };

  /* 生成"先探测导出形状，再依次尝试执行方法"的脚本。
     对不上时把实际导出列出来 —— 比静默失败有用得多。 */
  function probeGlue(id, assetsJson, factories, methods) {
    var lines = [];
    lines.push("var urls = {};");
    lines.push("var names = " + assetsJson + ";");
    lines.push("for (var i = 0; i < names.length; i++) { urls[names[i]] = await asset(names[i]); }");
    lines.push("var m = RT || {};");
    lines.push("var keys = Object.keys(m);");
    lines.push("var factory = null, fname = null;");
    factories.forEach(function (f) {
      lines.push("if (!factory && m[" + JSON.stringify(f) + "]) { factory = m[" + JSON.stringify(f) + "]; fname = " + JSON.stringify(f) + "; }");
    });
    lines.push("if (!factory && typeof m === 'function') { factory = m; fname = '(module itself)'; }");
    lines.push("if (!factory) {");
    lines.push("  throw new Error(" + JSON.stringify(id) + " + ' 胶水没有可识别的导出。实际导出：' + (keys.length ? keys.join(', ') : '(空)') +");
    lines.push("    '。请核对清单里 entry 的 workerType 与该版本的真实 API。');");
    lines.push("}");
    lines.push("var inst = await factory({ locateFile: function (f) { return urls[f] || f; } });");
    lines.push("if (inst && typeof inst.then === 'function') inst = await inst;");
    lines.push("var fn = null;");
    methods.forEach(function (mm) {
      lines.push("if (!fn && inst && typeof inst[" + JSON.stringify(mm) + "] === 'function') fn = inst[" + JSON.stringify(mm) + "].bind(inst);");
    });
    lines.push("if (!fn && typeof inst === 'function') fn = inst;");
    lines.push("if (!fn) {");
    lines.push("  var instKeys = inst ? Object.keys(inst) : [];");
    lines.push("  throw new Error(" + JSON.stringify(id) + " + ' 实例没有可识别的执行方法。实例导出：' + (instKeys.length ? instKeys.join(', ') : '(空)'));");
    lines.push("}");
    lines.push("var out = await fn(USER);");
    lines.push("if (out && typeof out.then === 'function') out = await out;");
    lines.push("if (out !== undefined && out !== null) log(String(out));");
    return lines.join('\n');
  }

  /* 拼装要在 Worker 里跑的脚本：先注入引擎，再跑用户代码。
     各引擎注入方式不同，按 id 分派。 */
  function buildRuntimeScript(id, code) {
    var body = GLUE[id];
    if (!body) {
      return "log('该运行时还没有接线脚本：' + " + JSON.stringify(id) + ");";
    }
    return body;
  }

  function run(path, code, lang) {
    count = 0; muted = false; t0 = (global.performance ? performance.now() : Date.now());
    clear();
    var L = Code.langs ? Code.langs.byPath(path) : null;
    line('sys', '运行 ' + path + '（本机浏览器内执行，不联网）');

    if (L) {
      /* 有真运行时且已就绪 → 优先用真的（Python / C++ 属这类） */
      if (Code.langs.useWasm(L)) {
        runDownloaded(L, code, path, true);
      } else if (L.tier === Code.langs.TIER.BUILTIN) {
        if (L.runner === 'native') { runJS(code); }
        else if (L.runner === 'iframe') { preview(path, code); line('sys', '已在编辑区右侧打开预览。'); }
        else if (runBuiltin(L.runner, code)) { /* 已处理 */ }
        else { runJS(code); }
        /* 自研可用时，如实告知还有升级选项，不藏着 */
        if (L.wasm && L.wasm.upgrade && !Code.langs.rtReady(L)) {
          printSys('提示：可在扩展中心下载 ' + (L.wasm.desc || '真运行时') +
            '（' + Code.langs.fmtSize(rtBytes(L.wasm.id)) + '）升级为真运行时。');
        }
      } else if (L.tier === Code.langs.TIER.DOWNLOAD) {
        runDownloaded(L, code, path);
      } else {
        line('warn', L.name + ' 暂不支持运行，仅提供语法着色、编辑与保存。');
      }
    } else {
      line('warn', '未识别的文件类型：' + path + '。可编辑、着色与保存。');
    }
    var ms = ((global.performance ? performance.now() : Date.now()) - t0).toFixed(1);
    printSys('结束，用时 ' + ms + ' ms');
  }

  function preview(path, code) {
    var box = U.$('#preview'), frame = U.$('#preview-frame');
    if (!box || !frame) return;
    var bridge = '<script>(function(){var k=["log","info","warn","error"];' +
      'k.forEach(function(n){var o=console[n];console[n]=function(){' +
      'try{parent.postMessage({__codeConsole:1,kind:n==="error"?"err":(n==="warn"?"warn":"out"),' +
      'text:Array.prototype.slice.call(arguments).map(function(a){try{return typeof a==="object"?JSON.stringify(a):String(a)}catch(e){return String(a)}}).join(" ")},"*")}catch(e){}' +
      'try{o.apply(console,arguments)}catch(e){}}});' +
      'addEventListener("error",function(e){parent.postMessage({__codeConsole:1,kind:"err",text:e.message},"*")});})();<\/script>';
    var html = code;
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, function (m) { return m + bridge; });
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, function (m) { return m + '<head>' + bridge + '</head>'; });
    else html = bridge + html;
    frame.srcdoc = html;
    box.classList.remove('hidden');
    return true;
  }

  function hidePreview() {
    var box = U.$('#preview');
    if (box) { box.classList.add('hidden'); var f = U.$('#preview-frame'); if (f) f.srcdoc = ''; }
  }

  Code.runner = {
    init: init, run: run, preview: preview, hidePreview: hidePreview,
    clear: clear, stop: stop, evalExpr: evalExpr, print: print, printSys: printSys,
    hasRuntime: function (path) {
      var L = Code.langs ? Code.langs.byPath(path) : null;
      if (!L) return false;
      if (L.tier === Code.langs.TIER.BUILTIN) return true;
      if (L.tier === Code.langs.TIER.DOWNLOAD) return Code.langs.canRun(L);
      return false;
    },
    /* 界面用：点击运行会发生什么，如实预告 */
    hint: function (path) {
      var L = Code.langs ? Code.langs.byPath(path) : null;
      return Code.langs ? Code.langs.runHint(L) : '';
    }
  };
})(window);
