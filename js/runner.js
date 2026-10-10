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

  function print(kind, text) {
    if (!out) return;
    if (muted) return;
    count++;
    if (count > 800) {
      muted = true;
      line('sys', '输出过多已暂停（800 行上限）。若代码陷入死循环，请关闭本页或用任务管理器结束标签页。');
      return;
    }
    line(kind, text);
    out.scrollTop = out.scrollHeight;
  }

  function line(kind, text) {
    if (!out) return;
    var d = document.createElement('div');
    d.className = 'out ' + kind;
    d.textContent = text;
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
      r.then(function (v) { if (v !== undefined) print('ret', '← ' + fmt(v)); },
        function (e) { print('err', (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))); });
    } else if (r !== undefined) {
      print('ret', '← ' + fmt(r));
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
      r.then(function (v) { print('ret', '← ' + fmt(v)); }, function (e) { print('err', String(e && e.message || e)); });
    } else if (r !== undefined) print('ret', '← ' + fmt(r));
  }

  var NO_RUNTIME = {
    python: '当前环境未内置 Python 运行时。引入外部解释器会引入第三方分发物并显著增大体积，\n本项目暂不内置；.py 文件可正常编辑、着色与保存，但不会执行。',
    cpp: '当前环境未内置 C++ 编译器。浏览器内编译需要引入外部工具链，本项目暂不内置；\n.cpp / .c / .h 文件可正常编辑、着色与保存，但不会执行。'
  };

  function run(path, code, lang) {
    count = 0; muted = false; t0 = (global.performance ? performance.now() : Date.now());
    clear();
    line('sys', '运行 ' + path + '（本机浏览器内执行，不联网）');
    if (lang === 'javascript') {
      runJS(code);
    } else if (lang === 'html') {
      preview(path, code);
      line('sys', '已在编辑区右侧打开预览。');
    } else if (NO_RUNTIME[lang]) {
      line('warn', NO_RUNTIME[lang]);
    } else {
      line('warn', '该类型没有可执行运行时：' + (U.LANG_LABEL[lang] || lang) + '。可编辑、着色与保存。');
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
    hasRuntime: function (lang) { return lang === 'javascript' || lang === 'html'; }
  };
})(window);
