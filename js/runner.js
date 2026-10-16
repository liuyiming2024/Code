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
          /* E-040：以前一律 print() 到「输出」，于是「控制台」标签点开是空的，
             而输入框在所有标签下都常驻，更强化了"这里该显示东西"的预期。
             控制台会话（回显 + 求值结果）只进 #panel-console，
             运行程序的输出仍然进「输出」——两者是不同性质的东西。 */
          printConsole('echo', '> ' + v);
          evalExpr(v, true);
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

  /* 控制台会话：只写 #panel-console，不进「输出」面板。
     找不到容器就退回 print()（不能因为容器缺失就什么都不显示）。 */
  function printConsole(kind, text, iconId) {
    if (!cons) { print(kind, text, iconId); return; }
    line(kind, text, iconId, cons);
    cons.scrollTop = cons.scrollHeight;
  }

  /* 返回值前缀用图标，不用文本箭头。图标与文字同一行，基线对齐。 */
  /* 各输出类型的默认图标：err/warn 必须有图形，
     否则"这行是错误还是警告"只能靠颜色分辨 —— 色弱用户分不出来。 */
  var KIND_ICON = { err: 'i-close', warn: 'i-warn', sys: 'i-info', ret: 'i-return' };

  function line(kind, text, iconId, box) {
    var target = box || out;
    if (!target) return;
    var d = document.createElement('div');
    d.className = 'out ' + kind;
    if (!iconId) iconId = KIND_ICON[kind];
    if (iconId && U.svg) {
      var ic = U.svg(iconId, 11);
      ic.setAttribute('class', 'out-icon');
      d.appendChild(ic);
    }
    var t = document.createElement('span');
    t.textContent = text;
    d.appendChild(t);
    target.appendChild(d);
  }

  /* E-045：以前只清 #panel-output，于是按钮常驻却只在「输出」下有效 ——
     在「控制台」点它毫无反应，用户会以为工具坏了。
     现在按面板名清对应的容器；传 'console' 只清控制台会话。 */
  function clear(which) {
    if (which === 'console') { if (cons) cons.innerHTML = ''; return; }
    if (out) out.innerHTML = '';
    if (cons) cons.innerHTML = '';
    count = 0; muted = false; hist = []; hidx = -1;
  }
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

  function evalExpr(src, toConsole) {
    var fn;
    try { fn = new Function('return (' + src + ')'); }
    catch (e) { try { fn = new Function(src); } catch (e2) { line('err', '语法错误：' + e2.message); return; } }
    var r = capture(function () {
      try { return fn(); } catch (e) { line('err', (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))); }
    });
    if (r && typeof r.then === 'function') {
      var put = toConsole ? printConsole : print;
      r.then(function (v) { put('ret', fmt(v), 'i-return'); }, function (e) { put('err', String(e && e.message || e)); });
    } else if (r !== undefined) {
      (toConsole ? printConsole : print)('ret', fmt(r), 'i-return');
    }
  }

  /* 自研子集的如实说明。不是"不支持"，是"支持到什么程度"要说清楚。
   *
   * E-024：这里原来写死"需下载 Pyodide（约 2 MB，当前 Release 里暂缺）"，
   *   而 README 与 api/runtimes.json 都明列「Python 11.9 MB 可下载」——
   *   同一件事两个说法，体积还差近 6 倍。用户看到"暂缺"就不会去点了。
   *   所以改成从清单动态取：有没有、多大，都以 runtimes.json 为准，不手写。 */
  function pyUpgradeHint() {
    try {
      var rt = Code.runtime && Code.runtime.findRt ? Code.runtime.findRt('pyodide') : null;
      if (!rt) return '';
      if (rt.ready === false) return '';
      var bytes = 0;
      (rt.files || []).forEach(function (f) { bytes += f.size || 0; });
      var mb = bytes / 1048576;
      var size = mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
      var st = Code.runtime.status ? Code.runtime.status('pyodide') : null;
      if (st && st.ready) return '完整 CPython 已就绪：可用 json / sys 等标准库，也可用 open() 读写虚拟文件系统。';
      /* 说清"升级能带来什么" —— 只说"可以下载"用户不知道值不值得。
         这里的差异是**真跑对照**出来的，不是照抄文档：
           pylite（基础包）不支持 json / sys / open
           pyodide 0.26.2 实测：json.dumps ✓、sys.version 3.12.1 ✓、open() ✓ */
      return '装完整 CPython（约 ' + size + '）后可多出：json / sys 等标准库、'
           + 'open() 虚拟文件系统。首次需联网。';
    } catch (e) {
      return '要完整 CPython 见扩展中心。';
    }
  }

  var CAVEAT = {
    /* 完整 CPython 已真跑验证（0.26.2 / Python 3.12.1），
       但有一件事必须说清，否则用户会误以为自己在碰本地硬盘。 */
    pyodide: '完整 CPython 3.12（已验证）。注意：open() 读写的是 WASM 里的'
             + '**虚拟文件系统**，不是你电脑上的硬盘 —— 文件不会保存到本地，'
             + '刷新页面即消失。要留存请用编辑器本身的保存功能。',
    pylite: 'Python 子集（自研解释器）：不是 CPython，不支持 import 第三方库、async、生成器、装饰器。\n' +
            '够用场景：语法练习、算法题、日常小脚本。' + pyUpgradeHint(),
    cpplite: 'C/C++ 子集（自研教学级）：不支持指针与地址运算、struct / class、模板、STL、头文件与多文件。\n' +
             '#include 会被忽略。够用场景：语法练习与基础算法。'
  };

  /* 走自研解释器。返回 true 表示已处理。 */
  function runBuiltin(kind, code) {
    if (kind === 'pylite') {
      if (!Code.pylite) { line('warn', 'Python 子集解释器未加载'); return true; }
      /* E-042：input() 以前传的是 function () { return ''; } ——
         不弹框、不报错，变量静默变成空字符串，程序带着空值继续跑，
         用户会以为是自己代码写错了。而 pylite.js 开头自己立的规矩就是
         "绝不静默跑歪"。所以这里改成弹输入框取真值，取消则抛明确异常。 */
      var I = Code.pylite.create(function (s) { print('out', s); }, function (prompt) {
        var v = null;
        try { v = window.prompt(String(prompt == null ? '' : prompt)); } catch (e) { }
        if (v === null) throw new Error('已取消输入：本环境通过弹窗获取 input()，取消会中止程序');
        return v;
      });
      if (CAVEAT.pylite) printSys(CAVEAT.pylite);
      try {
        var r = I.run(code, { timeout: 5000 });
        var perf1 = Code.pylite.PERF;
        printSys('结束，' + r.steps.toLocaleString() + ' 步' +
          (perf1 ? '（≈ 真实 CPython ' + perf1.human(r.steps) + '）' : ''));
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
        /* 时间同步：把解释器的步数换算成"等效真实 C++ 耗时"。
           只报步数的话，用户看到的是解释器自己的量，
           跟真实 OJ 完全对不上 —— "跑了多少步"对他判断会不会超时毫无帮助。 */
        var perf2 = Code.cpplite.PERF;
        printSys('结束，' + r2.steps.toLocaleString() + ' 步' +
          (perf2 ? '（≈ 真实 C++ ' + perf2.human(r2.steps) + '）' : ''));
        if (perf2 && r2.steps > perf2.stepsPerIter * perf2.realOpsPerSec * 0.5) {
          /* 半秒以上就要提醒 —— 这正是"快到 TLE 边缘"的量级 */
          line('warn', '等效真实耗时已接近 1 秒。竞赛通常限时 1 秒，建议用「TLE 预测」按目标规模外推确认。');
        }
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
    }, path);
  }

  /* 注册表 id → runtimes.js 用的语言键。
     两套命名并存是历史原因：注册表按"运行时"命名（sqlite/pyodide），
     runtimes.js 按"语言"命名（sql/python）。在这里对齐，不让差异外溢。 */
  /* ⚠ 唯一定义（S-041）。ui.js:629 曾抄了第二份同样的表 ——
     运行时 id 与语言 id 的映射只有一处真相，抄两份就必然漂移；
     runner.js:252 的注释写着"不让差异外溢"，而抄表正是让差异外溢。
     ui.js 改为引用 Code.runner.RT_KEY。 */
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
  /* ⚠ 这里曾有一套与 rt-worker.js 并行的第二套执行实现（S-019）：
     GLUE / probeGlue / buildRuntimeScript 共约 110 行。
     它从未被调用（buildRuntimeScript 零调用），
     而它依赖的 asset() / RT / USER / log() 在 rt-worker.js 里根本不存在 ——
     就算接上也跑不了。更要命的是 GLUE.cpp 写着"执行链路尚未接线"，
     与 rt-worker.js 里完整实现的 runCpp **直接矛盾**：
     后来的人读到哪一句，就会对现状得出相反的结论。

     删掉。执行只保留 rt-worker.js 一条路径 ——
     两套实现并存的地方，坏的总是没人在用的那一套，
     而它提供的信息是错的。 */


  function run(path, code, lang) {
    count = 0; muted = false; t0 = (global.performance ? performance.now() : Date.now());
    clear();
    var L = Code.langs ? Code.langs.byPath(path) : null;
    line('sys', '运行 ' + path + '（本机浏览器内执行，不联网）');

    if (L) {
      /* 有真运行时且已就绪 → 优先用真的（Python / C++ 属这类） */
      if (Code.langs.useWasm(L)) {
        /* 用真运行时时，把它的注意事项一并显示。
           定义了 CAVEAT 却不用 = 等于没写 —— 这类"写了没接上"的失效
           本项目已经踩过好几次（S-044 那类）。 */
        var ck = CAVEAT[L.wasm && L.wasm.id];
        if (ck) printSys(ck);
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

  /* ================= 基础包自检 =================
   *
   * 为什么要真的跑一遍，而不是检查"文件加载了没有"：
   *   本项目反复踩过一类坑 —— 代码在、函数也在、界面看着正常，
   *   但**从没真正执行过一次**。检查"存在"永远返回 true，
   *   于是问题一直藏着，直到用户真去跑才暴露（还常被误判成用户代码的问题）。
   *
   *   六个官方运行时就是这么回事：清单上有、按钮也在，
   *   但至今一次都没跑通过。所以基础包不能再靠"看着有"来判定。
   *
   * 基础包坏了 = 什么都跑不了（连 Hello world 都不行），
   * 与"某个扩展包坏了"严重程度差一个量级 —— 值得单独立一个自检。
   *
   * 每项返回 { ok, detail }；ok 为 false 时 detail 说明到底哪一步失败。
   */
  var BASE_SELFTEST = [
    {
      id: 'javascript', name: 'JavaScript',
      probe: '1 + 1',
      expect: '2',
      run: function (code) {
        /* 用独立作用域跑，不污染页面。自检代码是我们自己的，不是用户输入。 */
        var fn = new Function('"use strict"; return (' + code + ');');
        return String(fn());
      }
    },
    {
      id: 'html', name: 'HTML（预览）',
      probe: '<b>ok</b>',
      expect: 'ok',
      /* 预览走 iframe，没法直接取回输出 ——
         退而验证"能否创建一个 iframe 并写入文档"，
         这正是预览功能真正依赖的能力。 */
      run: function (code) {
        var f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px';
        document.body.appendChild(f);
        try {
          var d = f.contentDocument;
          if (!d) return '';
          d.open(); d.write(code); d.close();
          var t = (d.body && d.body.textContent) || '';
          return t;
        } finally {
          try { f.remove(); } catch (e) { }
        }
      }
    },
    {
      id: 'python', name: 'Python（自研解释器）',
      probe: 'print(1 + 1)',
      expect: '2',
      run: function (code) {
        if (!Code.pylite) throw new Error('pylite 未加载');
        var out = [];
        var I = Code.pylite.create(function (s) { out.push(s); },
                                   function () { return ''; });
        I.run(code, { timeout: 5000 });
        return out.join('\n').trim();
      }
    },
    {
      id: 'cpp', name: 'C / C++（自研解释器）',
      probe: 'int main(){ cout << 1+1; }',
      expect: '2',
      run: function (code) {
        if (!Code.cpplite) throw new Error('cpplite 未加载');
        var out = [];
        var C = Code.cpplite.create(function (s) { out.push(s); },
                                    function () { return ''; });
        C.run(code, { timeout: 5000 });
        return out.join('\n').trim();
      }
    }
  ];

  function selfTestBase() {
    return BASE_SELFTEST.map(function (t) {
      var got = '';
      try {
        got = String(t.run(t.probe) || '');
      } catch (e) {
        return { id: t.id, name: t.name, ok: false,
                 detail: '执行抛错：' + String((e && e.message) || e) };
      }
      if (got !== t.expect) {
        return { id: t.id, name: t.name, ok: false,
                 detail: '输出不符：实得「' + got + '」，期望「' + t.expect + '」' };
      }
      return { id: t.id, name: t.name, ok: true, detail: '输出 ' + got };
    });
  }

  Code.runner = {
    RT_KEY: RT_KEY,
    selfTestBase: selfTestBase,
    BASE_SELFTEST: BASE_SELFTEST,
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
