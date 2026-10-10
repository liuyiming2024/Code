/* ------------------------------------------------------------------
 * api.js —— 给「Code」项目提供的编程接口
 *
 * 两种用法：
 *
 * 1) 站内调用（在控制台或脚本里）
 *      Code.api.list()                  → 当前工程的文件列表
 *      Code.api.read('src/main.js')     → 读文件内容
 *      Code.api.write('a.txt', 'hi')    → 写文件
 *      Code.api.remove('a.txt')         → 删文件
 *      Code.api.project()               → 整个工程（可导出）
 *      Code.api.importProject(obj)      → 导入工程
 *      Code.api.on('change', fn)        → 订阅变更
 *
 * 2) 站外 HTTP 调用（静态 JSON 数据接口）
 *      GET https://liuyiming2024.github.io/Code/api/manifest.json
 *      → 返回本项目的元信息与可用接口清单
 *
 * ⚠ 关于「站外能不能读写你的文件」：
 *    不能，也不应该能。项目数据存在浏览器 IndexedDB 里，
 *    Pages 是纯静态托管，没有服务端可以代理这些请求。
 *    要跨设备读写必须自己接后端 —— 那会改变本项目
 *    「算力与数据都在本地」的定位，所以这里不做。
 *
 *    站外接口只提供**只读的元信息**，且内容是公开的静态文件。
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var listeners = {};

  function emit(name, payload) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { /* 订阅者的错误不该打断发布者 */ }
    });
  }

  var api = {
    /* ---- 文件读写 ---- */
    list: function () {
      return Code.fs.list().then(function (paths) {
        return paths.map(function (p) {
          return { path: p, lang: (Code.app && Code.app.langOf ? Code.app.langOf(p) : '') };
        });
      });
    },

    read: function (path) {
      return Code.fs.read(path);
    },

    write: function (path, text) {
      /* fs.write 只能写已存在的文件；不存在要先 create。
         不做这层判断的话，新建一个文件会静默失败。 */
      return Code.fs.exists(path).then(function (has) {
        var job = has ? Code.fs.write(path, text)
                      : Code.fs.create(path, 'file', text);
        return job.then(function () {
          emit('change', { type: has ? 'write' : 'create', path: path });
          return true;
        });
      });
    },

    remove: function (path) {
      return Code.fs.remove(path).then(function () {
        emit('change', { type: 'remove', path: path });
        return true;
      });
    },

    /* ---- 整个工程 ----
       直接复用 fs 自己的打包格式，避免引入第二套格式 ——
       两套格式意味着两套解析，迟早对不上。 */
    project: function () {
      return Code.fs.exportPack();
    },

    importProject: function (textOrObj) {
      var text = typeof textOrObj === 'string' ? textOrObj : JSON.stringify(textOrObj);
      return Code.fs.importPack(text).then(function (n) {
        emit('change', { type: 'import', count: n });
        return n;
      });
    },

    /* ---- 订阅 ---- */
    on: function (name, fn) {
      (listeners[name] || (listeners[name] = [])).push(fn);
      return function () {
        listeners[name] = (listeners[name] || []).filter(function (x) { return x !== fn; });
      };
    },

    /* ---- 元信息 ---- */
    manifest: function () {
      return {
        name: 'Code',
        version: '1.1.0',
        desc: '网页代码编辑器，算力与数据都在本地',
        storage: 'IndexedDB + localStorage（只在本机）',
        endpoints: [
          { path: 'api/manifest.json', method: 'GET', desc: '本项目元信息与接口清单' },
          { path: 'api/langs.json', method: 'GET', desc: '支持的着色语言与扩展名' }
        ],
        note: '站外接口为只读的静态 JSON。文件读写只在页面内可用 —— ' +
              'Pages 是静态托管，没有服务端可以代理，数据也不该离开这台设备。'
      };
    }
  };

  Code.api = api;
})(window);
