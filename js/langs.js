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
 * 为什么分档而不是二选一：
 *   真运行时（Pyodide 6-12MB）能力强但仓库装不下，违背"零依赖"。
 *   自研子集能力有限但立刻可用、还能中断死循环。
 *   两者不是替代关系，是互补——资源下载好了就自动升到真运行时，
 *   没下载就用自研的顶着。用户始终有东西可用。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  /* 档位常量 */
  var TIER = { BUILTIN: 1, DOWNLOAD: 2, NONE: 3 };

  /* 语言定义。
     wasm 段描述可选的真运行时；available 由 runtime.js 探测后回填，
     不在这里写死——资源可能还没发布到 Release。 */
  var LANGS = [
    {
      id: 'javascript', name: 'JavaScript', exts: ['js', 'mjs', 'cjs'],
      tier: TIER.BUILTIN, runner: 'native',
      desc: '浏览器原生执行',
      wasm: { id: 'quickjs', file: 'quickjs.wasm', size: 503134, license: 'MIT',
              desc: 'QuickJS 隔离沙箱，在独立堆里跑不可信代码',
              /* QuickJS 的价值是隔离，不是"多一门语言"，默认不启用 */
              optIn: true }
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
      caveat: '不是 CPython，不支持 import 第三方库 / async / 生成器 / 装饰器',
      wasm: { id: 'pyodide', files: ['pyodide.js', 'python_stdlib.zip'],
              size: 2341761 + 14767, license: 'MPL-2.0',
              desc: '完整 CPython 编译到 WASM，含标准库' }
    },
    {
      id: 'cpp', name: 'C / C++', exts: ['c', 'h', 'cpp', 'hpp', 'cc', 'cxx'],
      tier: TIER.BUILTIN, runner: 'cpplite',
      desc: '自研教学级子集',
      caveat: '不支持指针与地址运算、struct / class、模板、STL、头文件与多文件',
      /* C/C++ 真编译器要上百 MB（clang.wasm 43MB + lld 23MB + sysroot 29MB），
         按 runtimes.md 的建议不做，只做子集 + 明确提示 */
      wasm: null
    },
    {
      id: 'sql', name: 'SQL', exts: ['sql'],
      tier: TIER.DOWNLOAD, runner: 'sqlite',
      desc: '需下载 SQLite 引擎（约 660 KB）',
      wasm: { id: 'sqlite', files: ['sql-wasm.js', 'sql-wasm.wasm'],
              size: 48788 + 659806, license: 'MIT',
              desc: '完整 SQLite 引擎，支持 join / 子查询 / CTE / 窗口函数 / 全文搜索' }
    },
    {
      id: 'lua', name: 'Lua', exts: ['lua'],
      tier: TIER.DOWNLOAD, runner: 'lua',
      desc: '需下载 Lua 5.4 引擎（约 200 KB）',
      wasm: { id: 'lua', file: 'lua.wasm', size: 200000, license: 'MIT',
              desc: '官方 PUC-Rio Lua 5.4 编译到 WASM' }
    },
    {
      id: 'ruby', name: 'Ruby', exts: ['rb'],
      tier: TIER.DOWNLOAD, runner: null,
      desc: '需下载 Ruby 引擎（约 34 MB）',
      wasm: { id: 'ruby', file: 'ruby+stdlib.wasm', size: 35204534, license: 'MIT',
              desc: 'CRuby 3.3 编译到 WASM' }
    },
    { id: 'json', name: 'JSON', exts: ['json'], tier: TIER.NONE, runner: null },
    { id: 'css', name: 'CSS', exts: ['css'], tier: TIER.NONE, runner: null },
    { id: 'markdown', name: 'Markdown', exts: ['md', 'markdown'], tier: TIER.NONE, runner: null },
    { id: 'yaml', name: 'YAML', exts: ['yml', 'yaml'], tier: TIER.NONE, runner: null },
    { id: 'shell', name: 'Shell', exts: ['sh', 'bash'], tier: TIER.NONE, runner: null },
    { id: 'text', name: '纯文本', exts: ['txt'], tier: TIER.NONE, runner: null }
  ];

  var byExt = {};
  LANGS.forEach(function (l) {
    l.exts.forEach(function (e) { byExt[e] = l; });
  });

  function extOf(path) {
    var m = /\.([A-Za-z0-9_+#]+)$/.exec(String(path || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function byPath(path) { return byExt[extOf(path)] || null; }
  function byId(id) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].id === id) return LANGS[i];
    return null;
  }

  /* 界面上要显示的名称：带档位标注，不许让人误以为是完整实现 */
  function displayName(lang) {
    if (!lang) return '';
    if (lang.tier === TIER.BUILTIN && lang.runner === 'pylite') return 'Python 子集 · 自研';
    if (lang.tier === TIER.BUILTIN && lang.runner === 'cpplite') return 'C/C++ 子集 · 自研';
    return lang.name;
  }

  /* 能否运行。DOWNLOAD 档要看资源是否已就绪 */
  function canRun(lang) {
    if (!lang) return false;
    if (lang.tier === TIER.BUILTIN) return true;
    if (lang.tier === TIER.NONE) return false;
    var st = Code.runtime && Code.runtime.status(lang.wasm ? lang.wasm.id : null);
    return !!(st && st.ready);
  }

  /* 点击运行时会发生什么 —— 用于界面如实预告，不让用户干等 */
  function runHint(lang) {
    if (!lang) return '未知文件类型';
    if (lang.tier === TIER.BUILTIN) {
      return lang.caveat ? (lang.desc + '；' + lang.caveat) : lang.desc;
    }
    if (lang.tier === TIER.NONE) return '暂不支持运行，仅提供语法着色';
    var st = Code.runtime && Code.runtime.status(lang.wasm && lang.wasm.id);
    if (st && st.ready) return '已就绪（本地缓存，离线可用）';
    return '需要下载 ' + fmtSize(lang.wasm ? lang.wasm.size : 0) + '，首次需联网';
  }

  function fmtSize(n) {
    if (!n) return '未知大小';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  Code.langs = {
    TIER: TIER,
    all: LANGS,
    byPath: byPath,
    byId: byId,
    extOf: extOf,
    canRun: canRun,
    runHint: runHint,
    displayName: displayName,
    fmtSize: fmtSize
  };
})(typeof window !== 'undefined' ? window : globalThis);
