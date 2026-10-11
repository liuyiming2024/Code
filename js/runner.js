/* runner.js —— 本地算力
   原则：算力只在本机浏览器内发生，代码与数据都不上传。
   - JavaScript：浏览器原生执行，主线程 new Function，捕获 console 与异常。
   - HTML：在本页 iframe（sandbox 限制为允许脚本）里预览，并回传其 console。
   - 其余语言：交给 js/rt-worker.js 里的真实运行时（SQLite / Python / Lua /
     PHP / Ruby / C++），资源按需下载并缓存。
   - 下载与执行都在 Worker 里，主线程只显示进度。
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

  /* 这些有真实运行时，交给 Worker 执行。 */
  var HAS_RT = { sql: 1, python: 1, lua: 1, php: 1, ruby: 1, cpp: 1 };

  function run(path, code, lang) {
    count = 0; muted = false; t0 = (global.performance ? performance.now() : Date.now());
    clear();
    line('sys', '运行 ' + path + '（本机浏览器内执行，不联网）');
    if (lang === 'javascript') {
      runJS(code);
      return finish();
    }
    if (lang === 'html') {
      preview(path, code);
      line('sys', '已在编辑区右侧打开预览。');
      return finish();
    }
    if (HAS_RT[lang] && Code.runtimes) {
      return runRemote(lang, code);
    }
    line('warn', '该类型没有可执行运行时：' + (U.LANG_LABEL[lang] || lang) + '。可编辑、着色与保存。');
    return finish();
  }

  function finish() {
    var ms = ((global.performance ? performance.now() : Date.now()) - t0).toFixed(1);
    printSys('结束，用时 ' + ms + ' ms');
    return Promise.resolve();
  }

  /* 走 Worker 的运行时。进度条走 printSys，不静默。 */
  function runRemote(lang, code) {
    var label = Code.runtimes.label(lang);
    line('sys', '准备 ' + label + ' 运行时（约 ' + Code.runtimes.sizeHint(lang) +
      '，预计 ' + Code.runtimes.hint(lang) + '）…');
    line('sys', '首次需要联网下载，之后会缓存在本机，断网也能用。');
    return new Promise(function (resolve) {
      var lastPct = -1;
      Code.runtimes.run(lang, code, {
        progress: function (d) {
          if (d.pct === undefined) return;
          // 每 10% 报一次，别刷屏
          var p = Math.floor(d.pct / 10) * 10;
          if (p === lastPct) return;
          lastPct = p;
          printSys('下载中… ' + p + '%' + (d.file ? '（' + d.file + '）' : ''));
        },
        ready: function () { printSys('运行时就绪，开始执行。'); },
        done: function (d) {
          if (d.error) line('err', String(d.error));
          else if (d.text) d.text.split('\n').forEach(function (l) { print('out', l); });
          finish().then(resolve);
        },
        fail: function (d) {
          line('err', '运行时失败：' + (d.error || '未知原因'));
          finish().then(resolve);
        }
      });
    });
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
    hasRuntime: function (lang) {
      return lang === 'javascript' || lang === 'html' || !!HAS_RT[lang];
    }
  };
})(window);
