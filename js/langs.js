/* langs.js —— 语言运行时注册表
 *
 * 解决一件事：把"这门语言能不能跑、怎么跑、谁来跑"集中到一个地方。
 * runner.js 不再自己判断扩展名，只问注册表要一个执行器。
 *
 * 三档能力（界面必须如实显示档位，不许含糊）：
 *   档1 内置自研 —— 纯 JS 实现，零依赖，离线可用，立刻能跑
 *   档2 按需下载 —— 真 WASM 运行时，首次需联网下载，之后缓存离线可用
 *   档3 仅着色   —— 没有运行时，明确提示"暂不支持运行"
 *
 * 另有一档混合态：内置自研 + 可升级（wasm.upgrade = true）
 *   Python 与 C/C++ 属于这类——自研子集立刻可用，下载真运行时后自动升到真的。
 *   两者不是替代关系是互补：用户始终有东西可用，下载只是"更好"。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var TIER = { BUILTIN: 1, DOWNLOAD: 2, NONE: 3 };

  var LANGS = [
    {
      id: 'javascript', name: 'JavaScript', exts: ['js', 'mjs', 'cjs'],
      tier: TIER.BUILTIN, runner: 'native',
      desc: '浏览器原生执行',
      wasm: { id: 'quickjs', optIn: true, desc: 'QuickJS 隔离沙箱：在独立堆里跑不可信代码，跑飞了也不影响页面' }
    },
    {
      id: 'html', name: 'HTML', exts: ['html', 'htm'],
      tier: TIER.BUILTIN, runner: 'iframe',
      desc: '在 sandbox 隔离框架里预览'
    },
    {
      id: 'python', name: 'Python', exts: ['py'],
      tier: TIER.BUILTIN, runner: 'pylite',
      desc: '自研子集解释器',
      /* 补实测发现的三条（S-057/058/059 已修，但边界要写明） */
      caveat: '不是 CPython，不支持 import 第三方库 / async / 生成器 / 装饰器；整数超过 2^53 走 BigInt（精确），元组不可变',
      /* upgrade=true：自研已够用，下载真 CPython 后自动切换 */
      wasm: { id: 'pyodide', upgrade: true, desc: '完整 CPython 编译到 WASM，含标准库，可用 micropip 装纯 Python 包' }
    },
    {
      id: 'cpp', name: 'C / C++', exts: ['c', 'h', 'cpp', 'hpp', 'cc', 'cxx'],
      tier: TIER.BUILTIN, runner: 'cpplite',
      desc: '自研教学级子集',
      /* ⚠ caveat 必须跟着实现走。
         原文写"不支持 struct / class"，而 struct 单层（S-074）与嵌套（S-127）都已支持 ——
         这份 caveat 同时喂给界面和 api/langs.json（对外承诺），
         说"不支持"会让集成方屏蔽一个其实能用的功能。 */
      caveat: '自研子集：不支持指针与地址运算、class、模板、标准 STL 容器、头文件与多文件；struct（含嵌套）可用',
      wasm: { id: 'cpp', upgrade: true, desc: '真 Clang + LLD，能在浏览器里编译运行完整 C/C++' }
    },
    {
      id: 'sql', name: 'SQL', exts: ['sql'],
      tier: TIER.DOWNLOAD, runner: 'sqlite',
      desc: 'SQLite 引擎',
      wasm: { id: 'sqlite', desc: '完整 SQLite：join / 子查询 / CTE / 窗口函数 / 全文搜索' }
    },
    {
      id: 'lua', name: 'Lua', exts: ['lua'],
      tier: TIER.DOWNLOAD, runner: 'lua',
      desc: 'Lua 5.4 引擎',
      /* Fengari 是纯 JS 的 Lua VM，没有 wasm 加载环节，链路最短最稳 */
      wasm: { id: 'lua', desc: 'Lua 5.4（Fengari，纯 JS VM，无需 wasm）' }
    },
    {
      id: 'ruby', name: 'Ruby', exts: ['rb'],
      tier: TIER.DOWNLOAD, runner: 'ruby',
      desc: 'Ruby 引擎',
      wasm: { id: 'ruby', desc: 'CRuby 3.3 编译到 WASM（官方 ruby.wasm）' }
    },
    {
      id: 'php', name: 'PHP', exts: ['php', 'phtml'],
      tier: TIER.DOWNLOAD, runner: 'php',
      desc: 'PHP 8.x 引擎',
      wasm: { id: 'php', desc: 'PHP 8.x（Zend 引擎编译到 WASM），含 gd / mbstring / sqlite 扩展' }
    },
    { id: 'json', name: 'JSON', exts: ['json'], tier: TIER.NONE, runner: null },
    { id: 'css', name: 'CSS', exts: ['css'], tier: TIER.NONE, runner: null },
    { id: 'markdown', name: 'Markdown', exts: ['md', 'markdown'], tier: TIER.NONE, runner: null },
    { id: 'yaml', name: 'YAML', exts: ['yml', 'yaml'], tier: TIER.NONE, runner: null },
    { id: 'shell', name: 'Shell', exts: ['sh', 'bash'], tier: TIER.NONE, runner: null },
    { id: 'text', name: '纯文本', exts: ['txt'], tier: TIER.NONE, runner: null }
  ];

  var byExt = {};
  LANGS.forEach(function (l) { l.exts.forEach(function (e) { byExt[e] = l; }); });

  function extOf(path) {
    var m = /\.([A-Za-z0-9_+#]+)$/.exec(String(path || ''));
    return m ? m[1].toLowerCase() : '';
  }
  function byPath(path) { return byExt[extOf(path)] || null; }
  function byId(id) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].id === id) return LANGS[i];
    return null;
  }

  function rtStatus(lang) {
    if (!lang || !lang.wasm) return null;
    return Code.runtime ? Code.runtime.status(lang.wasm.id) : null;
  }

  /* 界面显示名：带档位标注，不许让人误以为是完整实现 */
  function displayName(lang) {
    if (!lang) return '';
    var upgrade = lang.wasm && lang.wasm.upgrade && rtReady(lang);
    if (lang.id === 'python') return upgrade ? 'Python（CPython）' : 'Python 子集 · 自研';
    if (lang.id === 'cpp') return upgrade ? 'C/C++（Clang）' : 'C/C++ 子集 · 自研';
    return lang.name;
  }

  /* 是否已下载到本地缓存。由 runtime.js 的 refreshStatus() 在启动时探测后写入。
     这里只读状态，不发起请求 —— 同步读取才能用在渲染路径里。 */
  function rtReady(lang) {
    var st = rtStatus(lang);
    return !!(st && st.ready);
  }

  /* ================= 基础包 / 扩展包 =================
   *
   * 借用游戏的分包思路：
   *
   *   基础包（base） —— 装上就能跑，**零下载、零联网**。
   *     JS/HTML 由浏览器直接执行；Python 与 C++ 由本项目自研的解释器
   *     （pylite / cpplite）执行。它们随页面一起加载，永远可用。
   *
   *   扩展包（ext） —— 各语言的官方运行时，按需下载。
   *     pyodide（真 CPython）、clang（真 C/C++）、ruby、php、sqlite、lua …
   *
   * 为什么必须分清这层：
   *   基础包坏了 = 什么都跑不了（连"Hello world"都不行）；
   *   扩展包坏了 = 只是那一种语言退回自研解释器，其余照常。
   *   两者的严重程度差一个量级，界面上也就该分开呈现。
   *
   * 另一件必须说清的事：**扩展包一个都没跑通过**。
   * 所以真正托底的是基础包 —— 它的可用性不能靠"文件加载了"来推断，
   * 必须真跑一行代码验证（见 Code.runner.selfTestBase()）。
   */
  var PACK = { BASE: 'base', EXT: 'ext', NONE: 'none' };

  function packOf(lang) {
    if (!lang) return PACK.NONE;
    if (lang.tier === TIER.NONE) return PACK.NONE;
    /* 内置档属于基础包；但它上面的 wasm 升级档属于扩展包 ——
       同一个语言可以同时在两层里（Python / C++ 正是如此）。 */
    return lang.tier === TIER.BUILTIN ? PACK.BASE : PACK.EXT;
  }

  /** 基础包包含哪些语言（永远可运行，不需要任何下载） */
  function baseLangs() {
    return LANGS.filter(function (l) { return packOf(l) === PACK.BASE; });
  }

  /** 扩展包里有哪些运行时（都要下载） */
  function extRuntimes() {
    var seen = {}, out = [];
    LANGS.forEach(function (l) {
      var w = l.wasm;
      if (!w || !w.id) return;
      if (seen[w.id]) return;
      seen[w.id] = true;
      out.push({
        id: w.id,
        lang: l.id,
        langName: l.name,
        desc: w.desc || '',
        upgrade: !!w.upgrade,       /* 是"升级"还是"唯一途径" */
        size: rtSize(w.id),
        ready: rtReady(l)
      });
    });
    return out;
  }

  function canRun(lang) {
    if (!lang) return false;
    if (lang.tier === TIER.BUILTIN) return true;
    if (lang.tier === TIER.NONE) return false;
    return rtReady(lang);
  }

  /* 点运行会发生什么 —— 如实预告，不让用户干等 */
  function runHint(lang) {
    if (!lang) return '未知文件类型';
    if (lang.tier === TIER.NONE) return '暂不支持运行，仅提供语法着色、编辑与保存';
    if (lang.tier === TIER.BUILTIN) {
      var w = lang.wasm;
      if (w && w.upgrade) {
        if (rtReady(lang)) return '已升级为真运行时（本机缓存，离线可用）';
        return lang.desc + '：' + lang.caveat +
          '。可在扩展中心下载真运行时（' + fmtSize(rtSize(w.id)) + '）升级';
      }
      return lang.caveat ? (lang.desc + '；' + lang.caveat) : lang.desc;
    }
    if (rtReady(lang)) {
      /* 已缓存也不等于能用：这六种按需运行时端到端一次都没跑通过
         （开发环境访问 Release 下载被挡）。"已就绪"是真的下好了，
         但"下好了就能跑"是我们没验证过的推断 —— 而用户看到"已就绪"
         只会理解成后者。所以把未验证这件事说在前面。 */
      return '已下载到本机缓存（离线可用）。注意：该运行时的实际执行' +
        '尚未经端到端验证，首次运行如遇问题请反馈';
    }
    return '需要下载 ' + fmtSize(rtSize(lang.wasm && lang.wasm.id)) +
      '，首次需联网。注意：下载后能否正常运行尚未经端到端验证';
  }

  function rtSize(id) {
    if (!id) return 0;
    if (Code.runtime && Code.runtime.totalSize) {
      var n = Code.runtime.totalSize(id);
      if (n) return n;
    }
    return 0;
  }

  function fmtSize(n) {
    if (!n) return '未知大小';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* 是否要用真运行时替代自研子集 */
  function useWasm(lang) {
    return !!(lang && lang.wasm && lang.wasm.upgrade && rtReady(lang));
  }

  Code.langs = {
    TIER: TIER, PACK: PACK, all: LANGS,
    packOf: packOf, baseLangs: baseLangs, extRuntimes: extRuntimes,
    byPath: byPath, byId: byId, extOf: extOf,
    canRun: canRun, runHint: runHint, displayName: displayName,
    fmtSize: fmtSize, rtReady: rtReady, useWasm: useWasm,
    /* 需要下载才有运行时的语言，供扩展中心列清单 */
    downloadable: function () {
      return LANGS.filter(function (l) {
        return l.tier === TIER.DOWNLOAD || (l.wasm && l.wasm.upgrade);
      });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
