/* runtimes.js —— 运行时管理器（主线程侧）
   ------------------------------------------------------------------
   负责：起 Worker、转发消息、显示下载进度、缓存清理。
   真正的加载与执行都在 js/rt-worker.js 里。

   三条不能省的原则（写在这里是因为改代码的人一定会看到）：
     1. 运行时只在 Worker 里跑 —— 大 WASM 在主线程编译会白屏。
     2. 必须显示下载进度 —— 用户主动点了运行，就得知道在下什么。
     3. 首次需要联网 —— 之后走 Cache Storage。别装作没这一步。
*/
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var WORKER = 'js/rt-worker.js';

  /* 语言 → 运行时标签。用于提示文案。 */
  var LABEL = {
    sql: 'SQLite', python: 'Python (Pyodide)', lua: 'Lua (Fengari)',
    php: 'PHP', ruby: 'Ruby', cpp: 'C/C++ (Clang)'
  };

  var worker = null;
  var pending = null;      // 当前等待的请求
  var supported = null;    // 是否支持 Worker（file:// 下会失败）
  var lastWorkerError = null;

  /* 判断是不是 file:// 打开。这种情况 Worker 一定被拒，
     提示必须直说原因和解决办法，不能只说"创建失败"。 */
  function isFileProtocol() {
    try { return (location.protocol || '') === 'file:'; }
    catch (e) { return false; }
  }

  function ensure() {
    if (worker) return worker;
    if (supported === false) return null;
    try {
      worker = new Worker(WORKER);
    } catch (e) {
      supported = false;
      lastWorkerError = (e && e.message) || String(e);
      return null;
    }
    worker.addEventListener('message', function (e) {
      var d = e.data || {};
      if (pending && pending.on && pending.on[d.type]) pending.on[d.type](d);
    });
    worker.addEventListener('error', function (e) {
      if (pending && pending.on && pending.on.fail) {
        pending.on.fail({ error: 'Worker 错误：' + (e.message || '未知') });
      }
    });
    supported = true;
    return worker;
  }

  function call(msg, on, timeoutMs) {
    var w = ensure();
    if (!w) {
      on.fail && on.fail({
        error: isFileProtocol()
          ? '无法创建 Worker：当前是用 file:// 直接打开的，浏览器会以"来源为空"处理并拒绝 Worker。\n' +
            '请在本仓库目录执行 python3 server.py，然后访问 http://localhost:8000/\n' +
            '或直接访问在线版 https://liuyiming2024.github.io/Code/'
          : '无法创建 Worker：' + (lastWorkerError || '浏览器不允许。请检查是否启用了脚本隔离限制。')
      });
      return;
    }
    pending = { on: on };
    var timer = null;
    if (timeoutMs) {
      timer = setTimeout(function () {
        if (!pending) return;
        pending = null;
        on.fail && on.fail({ error: '运行时超时（' + Math.round(timeoutMs / 1000) + ' 秒）。' +
          'C/C++ 首次编译需要下载约 90 MB，请耐心等待或稍后重试。' });
      }, timeoutMs);
    }
    var wrapped = {};
    ['begin', 'progress', 'ready', 'done', 'fail'].forEach(function (k) {
      wrapped[k] = function (d) {
        if (!pending) return;
        if (k === 'done' || k === 'fail') {
          if (timer) clearTimeout(timer);
          pending = null;
        }
        on[k] && on[k](d);
      };
    });
    pending.on = wrapped;
    w.postMessage(msg);
  }

  /* 估算等待时长，用于在开始前给用户一个心理预期。 */
  function hint(lang) {
    var s = { sql: 1, lua: 1, python: 15, php: 20, ruby: 40, cpp: 120 }[lang] || 10;
    return s < 60 ? (s + ' 秒') : (Math.round(s / 60) + ' 分钟');
  }

  function sizeHint(lang) {
    return { sql: '0.7 MB', lua: '0.5 MB', python: '12 MB',
             php: '16.5 MB', ruby: '34 MB', cpp: '90 MB' }[lang] || '若干 MB';
  }

  /* fileName 决定编译器按哪种语言处理（.c 与 .cpp 的 flags 不同），
     有就传下去；没有就让 Worker 侧用默认值。 */
  function run(lang, code, hooks, fileName) {
    call({ cmd: 'run', lang: lang, code: code, fileName: fileName || '' },
         hooks || {}, 10 * 60 * 1000);
  }

  /* 只下载不执行。扩展中心的"下载"按钮用这个 ——
     rt-worker.js 里已有 prepare 分支，这里补上主线程侧的入口。 */
  function prepare(lang, hooks) {
    call({ cmd: 'prepare', lang: lang }, hooks || {}, 10 * 60 * 1000);
  }

  function clearCache(onDone) {
    call({ cmd: 'drop' }, {
      cleared: function () { onDone && onDone(); },
      fail: function (d) { onDone && onDone(d && d.error); }
    }, 30000);
  }

  Code.runtimes = {
    run: run,
    prepare: prepare,
    clearCache: clearCache,
    has: function (lang) { return !!({ sql: 1, python: 1, lua: 1, php: 1, ruby: 1, cpp: 1 })[lang]; },
    label: function (lang) { return LABEL[lang] || lang; },
    hint: hint,
    sizeHint: sizeHint
  };
})(window);
