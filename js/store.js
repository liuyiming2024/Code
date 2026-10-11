/* store.js —— 偏好设置与本地键值存储
   设置落 localStorage，文件正文落 IndexedDB（见 fs.js）。
   本地与线上使用同一套存储实现，不做两套。 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});
  var KEY = 'code.prefs.v1';

  var DEFAULTS = {
    theme: 'dark',            // dark | light
    fontSize: 14,
    wordWrap: false,
    tabSize: 4,
    indentMode: 'smart',      // smart | space | tab
    showWS: false,            // 标出行尾多余空格
    panelHeight: 190,
    panelOpen: true,
    sideWidth: 250,
    sideView: 'files',        // files | search | run | settings
    autorun: false,
    syncEnabled: false,       // 可选：把工程同步到外部数据库，默认关闭
    syncUrl: '',
    syncKey: '',
    snippets: true,          // Tab 展开代码片段
    /* E-039：标签列表以前只在内存里，刷新后只剩最后打开的那一个。
       开着 5 个文件改 bug 刷新一下全丢，而 PWA 装到桌面后重开是常态场景。
       E-056：文件树展开状态同理，刷新后全部合上。
       两者都是"工作状态"，不存就每次重来。 */
    openTabs: [],            // 已打开的文件路径
    activeTab: '',           // 当前激活的那个
    treeExpanded: []         // 文件树里展开的目录路径
  };

  var prefs = Object.assign({}, DEFAULTS);

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) prefs = Object.assign(prefs, JSON.parse(raw));
    } catch (e) { /* 存储不可用时用默认值，不阻断启动 */ }
    return prefs;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  /* ---------- IndexedDB 薄封装（无第三方依赖） ---------- */
  var dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var req = indexedDB.open('code-workspace', 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var out = fn(s);
        t.oncomplete = function () { res(out && out.__req ? out.__req.result : out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }

  Code.store = {
    get prefs() { return prefs; },
    load: load,
    save: save,
    set: function (k, v) { prefs[k] = v; save(); },
    reset: function () { prefs = Object.assign({}, DEFAULTS); save(); },
    /* IndexedDB */
    idb: {
      put: function (store, val) { return tx(store, 'readwrite', function (s) { s.put(val); }); },
      del: function (store, key) { return tx(store, 'readwrite', function (s) { s.delete(key); }); },
      get: function (store, key) { return tx(store, 'readonly', function (s) { return { __req: s.get(key) }; }); },
      all: function (store) { return tx(store, 'readonly', function (s) { return { __req: s.getAll() }; }); },
      clear: function (store) { return tx(store, 'readwrite', function (s) { s.clear(); }); }
    }
  };
})(window);
