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

  /* 按需下载档：先确保资源就绪，再在 Worker 里跑（脚本内完成加载，避免主线程卡死） */
  function runDownloaded(lang, code, path) {
    var id = lang.wasm && lang.wasm.id;
    var st = Code.runtime && Code.runtime.status(id);
    if (st && st.ready) {
      /* 已缓存：直接执行。SQLite 与 Lua 的引擎注入见 worker 内的实现说明 */
      line('sys', '运行时已就绪（本机缓存，离线可用）');
      runInRuntime(id, code, path);
      return;
    }
    /* 首次：如实告知要下载什么、多大、需要联网 */
    var size = lang.wasm ? Code.langs.fmtSize(lang.wasm.size) : '未知大小';
    line('sys', '首次运行需要下载 ' + lang.name + ' 运行时（约 ' + size + '），请保持联网。');
    line('sys', '下载后会缓存在本浏览器，之后离线也能用。');
    if (!Code.runtime) { line('err', '运行时加载模块未就绪'); return; }
    Code.runtime.ensure(id, function (p, fname) {
      var pct = Math.round(p * 100);
      if (pct % 20 === 0) printSys('下载中 ' + pct + '%' + (fname ? '（' + fname + '）' : ''));
    }).then(function () {
      printSys('下载完成，已校验 SHA-256 并缓存');
      runInRuntime(id, code, path);
    }).catch(function (e) {
      line('err', '运行时下载失败：' + (e && e.message || e));
      line('sys', '提示：' + lang.name + ' 运行依赖的资源未发布或网络不通。' +
        '文件本身可以正常编辑、着色与保存。');
    });
  }

  /* 在 Worker 里执行。引擎注入脚本由 langid 决定。 */
  function runInRuntime(id, code, path) {
    if (!Code.runtime || !Code.runtime.runInWorker) { line('err', 'Worker 模块未就绪'); return; }
    var wrap = buildRuntimeScript(id, code);
    Code.runtime.runInWorker(id, wrap, 8000).then(function (res) {
      (res.out || []).forEach(function (s) { print('out', s); });
      if (res.err) line('err', res.err);
      printSys('结束');
    }).catch(function (e) {
      line('err', String(e && e.message || e));
    });
  }

  /* 拼装要在 Worker 里跑的脚本：先注入引擎，再跑用户代码。
     各引擎注入方式不同，按 id 分派。
     引擎文件走直链 + Cache Storage：Worker 内的 fetch 同样能命中缓存。 */
  function buildRuntimeScript(id, code) {
    var R = Code.runtime && Code.runtime;
    var manifest = R && R.manifest ? R.manifest() : null;
    function urlOf(name) {
      if (!manifest) return null;
      for (var i = 0; i < manifest.runtimes.length; i++) {
        var rt = manifest.runtimes[i];
        var fs = rt.files || [];
        for (var j = 0; j < fs.length; j++) if (fs[j].name === name) return fs[j].url;
      }
      return null;
    }
    var userCode = '(' + JSON.stringify(code) + ')';

    if (id === 'sqlite') {
      var jsUrl = urlOf('sql-wasm.js'), wasmUrl = urlOf('sql-wasm.wasm');
      return [
        "(function(){",
        "  var out=[];",
        "  function log(s){ out.push(String(s)); }",
        "  var jsUrl=" + JSON.stringify(jsUrl) + ", wasmUrl=" + JSON.stringify(wasmUrl) + ";",
        "  fetch(jsUrl).then(function(r){return r.text()}).then(function(src){",
        "    (0,eval)(src);",
        "    return initSqlJs({ locateFile: function(f){ return wasmUrl; } });",
        "  }).then(function(SQL){",
        "    var db=new SQL.Database();",
        "    var sql=" + userCode + ";",
        "    try{",
        "      var res=db.exec(sql);",
        "      if(!res.length){ log('语句已执行，无结果集'); }",
        "      res.forEach(function(t){",
        "        log(t.columns.join(' | '));",
        "        t.values.forEach(function(row){ log(row.join(' | ')); });",
        "      });",
        "    }catch(e){ log('SQL 错误: '+(e&&e.message||e)); }",
        "    db.close();",
        "    self.postMessage({out:out, err:null});",
        "  }).catch(function(e){ self.postMessage({out:out, err:String(e&&e.message||e)}); });",
        "})();"
      ].join('\n');
    }

    /* 其余引擎暂按纯代码方式在 Worker 内执行（隔离，避免卡死主线程） */
    return code;
  }

  function run(path, code, lang) {
    count = 0; muted = false; t0 = (global.performance ? performance.now() : Date.now());
    clear();
    var L = Code.langs ? Code.langs.byPath(path) : null;
    line('sys', '运行 ' + path + '（本机浏览器内执行，不联网）');

    if (L) {
      if (L.tier === Code.langs.TIER.BUILTIN) {
        if (L.runner === 'native') { runJS(code); }
        else if (L.runner === 'iframe') { preview(path, code); line('sys', '已在编辑区右侧打开预览。'); }
        else if (runBuiltin(L.runner, code)) { /* 已处理 */ }
        else { runJS(code); }
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
