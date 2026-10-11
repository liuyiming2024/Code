/* fs.js —— 浏览器内虚拟文件系统
   全部数据落在 IndexedDB，不上传任何服务器。
   导入/导出用的 ZIP 读写为本文件自己实现（store 模式），不依赖第三方库。 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});
  var U = Code.util;
  var idb = Code.store.idb;
  var STORE = 'files';

  var listeners = [];
  var cache = {};   // path -> {path, type, content, size, mtime}

  function emit(kind, path) { listeners.forEach(function (f) { f(kind, path); }); }
  function onChange(f) { listeners.push(f); }

  function safePath(p) {
    p = U.normPath(String(p || ''));
    if (!p || p.indexOf('..') === 0 || /(^|\/)(\.\.)\//.test(p)) throw new Error('路径不合法：' + p);
    return p;
  }

  /* ---------- 基础读写 ---------- */
  function init() {
    return idb.all(STORE).then(function (rows) {
      cache = {};
      rows.forEach(function (r) { cache[r.path] = r; });
      if (!rows.length) return seed();
    });
  }

  function seed() {
    var SAMPLES = [
      /* 同样过时：这里只说"可以运行 JavaScript"，而 Python 与 C/C++ 子集现在也能跑 */
      ['README.md', '# 我的代码空间\n\n这是一个在浏览器里运行的在线代码编辑器。\n\n- 左侧是文件树，可以把整个工程导出成 zip\n- 中间是编辑器，支持多标签与语法高亮\n- 底部面板可以运行 JavaScript、Python 子集、C/C++ 子集\n- 更多语言（SQLite / Lua / Ruby / PHP / 完整 CPython）在「扩展中心」按需下载\n\n所有内容都保存在这台设备的浏览器里。\n'],
      ['hello.js', '// 点「运行」或按 Ctrl+Enter 执行\nfunction greet(name) {\n  return "你好，" + name + "！";\n}\n\nfor (var i = 1; i <= 3; i++) {\n  console.log(i, greet("第 " + i + " 位访客"));\n}\n\nconsole.log("当前时间：", new Date().toLocaleString());\n'],
      ['index.html', '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>示例页面</title>\n<style>\n  body { font-family: system-ui, sans-serif; padding: 40px; }\n  h1 { color: #1f6feb; }\n</style>\n</head>\n<body>\n  <h1>HTML 预览示例</h1>\n  <p>切到编辑区上方的「预览」即可看到结果。</p>\n  <button onclick="alert(\'预览里的脚本也能跑\')">点我</button>\n</body>\n</html>\n'],
      ['notes/todo.md', '# 待办\n\n- [x] 搭好文件树\n- [ ] 把自己的工程导进来\n- [ ] 试试控制台\n'],
      /* E-023：这段文案写过时了。Python 现在已是内置自研解释器（langs.js 里
         runner: 'pylite'），print 真的会输出 hello —— 而这里还在教用户"不会有任何输出"。
         用户第一次打开看到的第一个 .py 文件，说的却是错的事。 */
      ['notes/python-note.py', '# Python 子集（自研解释器）：能跑 print 与基础语法。\n' +
        '# 不支持 import 第三方库、async、生成器、装饰器。\n' +
        '# 要完整的 CPython（含标准库）见「扩展中心」。\nprint("hello")\n']
    ];
    var chain = Promise.resolve();
    SAMPLES.forEach(function (s) { chain = chain.then(function () { return create(s[0], 'file', s[1]); }); });
    return chain.then(function () { emit('seed'); });
  }

  function mkdirp(path) {
    var parts = path.split('/');
    if (parts.length > 1) parts.pop();
    var chain = Promise.resolve(), cur = '';
    parts.forEach(function (p) {
      cur = cur ? cur + '/' + p : p;
      var d = cur;
      chain = chain.then(function () {
        if (cache[d]) return;
        return idb.put(STORE, { path: d, type: 'dir', mtime: Date.now() }).then(function () {
          cache[d] = { path: d, type: 'dir', mtime: Date.now() };
        });
      });
    });
    return chain;
  }

  function create(path, type, content) {
    path = safePath(path);
    if (cache[path]) throw new Error('已存在：' + path);
    return mkdirp(path).then(function () {
      var rec = { path: path, type: type || 'file', content: content == null ? '' : content, mtime: Date.now() };
      return idb.put(STORE, rec);
    }).then(function () {
      var rec = { path: path, type: type || 'file', content: content == null ? '' : content, mtime: Date.now() };
      cache[path] = rec;
      emit('create', path);
      return rec;
    });
  }

  function write(path, content) {
    path = safePath(path);
    var rec = cache[path];
    if (!rec) return create(path, 'file', content);
    rec.content = content; rec.mtime = Date.now();
    return idb.put(STORE, rec).then(function () { emit('write', path); return rec; });
  }

  function read(path) { return cache[path] ? cache[path].content || '' : null; }
  function stat(path) { return cache[path] || null; }
  function exists(path) { return !!cache[path]; }

  function remove(path) {
    path = safePath(path);
    var doomed = [path];
    var prefix = path + '/';
    Object.keys(cache).forEach(function (p) {
      if (p.indexOf(prefix) === 0) doomed.push(p);
    });
    var chain = Promise.resolve();
    doomed.forEach(function (p) {
      chain = chain.then(function () { return idb.del(STORE, p); })
        .then(function () { delete cache[p]; });
    });
    return chain.then(function () { emit('remove', path); });
  }

  /* 移动 / 重命名：文件与目录（目录需整体搬移） */
  function move(from, to) {
    from = safePath(from); to = safePath(to);
    if (from === to) return Promise.resolve();
    if (cache[to]) throw new Error('目标已存在：' + to);
    var jobs = [];
    if (cache[from] && cache[from].type === 'dir') {
      var prefix = from + '/';
      Object.keys(cache).forEach(function (p) {
        if (p === from || p.indexOf(prefix) === 0) jobs.push([p, to + p.slice(from.length)]);
      });
    } else {
      jobs.push([from, to]);
    }
    var chain = Promise.resolve();
    jobs.forEach(function (j) {
      chain = chain.then(function () {
        var rec = Object.assign({}, cache[j[0]]);
        return idb.del(STORE, j[0]).then(function () {
          rec.path = j[1];
          return idb.put(STORE, rec);
        }).then(function () {
          delete cache[j[0]];
          cache[j[1]] = rec;
        });
      });
    });
    return chain.then(function () { mkdirp(to); emit('move', to); });
  }

  function list() {
    return Object.keys(cache).map(function (k) { return cache[k]; });
  }

  /* 按目录分组，供文件树渲染 */
  function childrenOf(dir) {
    var out = [];
    var seen = {};
    Object.keys(cache).forEach(function (p) {
      var d = U.dirname(p);
      var name = dir ? (p.indexOf(dir + '/') === 0 ? p.slice(dir.length + 1) : null) : p;
      if (name == null) return;
      var slash = name.indexOf('/');
      if (slash >= 0) name = name.slice(0, slash);
      if (seen[name]) return;
      seen[name] = true;
      out.push({ name: name, path: dir ? dir + '/' + name : name, type: slash >= 0 ? 'dir' : cache[p].type });
    });
    out.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return out;
  }

  function clearAll() {
    return idb.clear(STORE).then(function () { cache = {}; emit('clear'); });
  }

  /* ---------- ZIP：导出（store，无压缩） ---------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256), c, k, j;
    for (k = 0; k < 256; k++) {
      c = k;
      for (j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[k] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF, i;
    for (i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipBuild(files) {
    // files: [{name, data:Uint8Array}]
    var parts = [], central = [], offset = 0;
    var enc = new TextEncoder();
    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name);
      var crc = crc32(f.data);
      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);      // UTF-8 文件名
      dv.setUint16(8, 0, true);           // store
      dv.setUint16(10, 0, true); dv.setUint16(12, 0x2821, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, f.data.length, true);
      dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      parts.push(lh, f.data);

      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0x2821, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, f.data.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      central.push(ch);

      offset += lh.length + f.data.length;
    });
    var cdSize = central.reduce(function (n, c) { return n + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  }

  function exportZip() {
    var enc = new TextEncoder();
    var files = [];
    Object.keys(cache).forEach(function (p) {
      var r = cache[p];
      if (r.type === 'dir') files.push({ name: p + '/', data: new Uint8Array(0) });
      else files.push({ name: p, data: enc.encode(r.content || '') });
    });
    return zipBuild(files);
  }

  /* ---------- ZIP：导入（store + deflate） ---------- */
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('当前浏览器不支持解压该压缩包'));
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function zipRead(buf) {
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var dec = new TextDecoder();
    // 从尾部找 EOCD
    var eocd = -1;
    for (var i = u8.length - 22; i >= 0 && i >= u8.length - 65558; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip 文件');
    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var out = [], p = cdOff, k;
    for (k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('压缩包目录损坏');
      var method = dv.getUint16(p + 10, true);
      var flag = dv.getUint16(p + 8, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nlen = dv.getUint16(p + 28, true);
      var elen = dv.getUint16(p + 30, true);
      var clen = dv.getUint16(p + 32, true);
      var lhOff = dv.getUint32(p + 42, true);
      var name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      var lhlen = dv.getUint16(lhOff + 26, true);
      var lelen = dv.getUint16(lhOff + 28, true);
      var dataOff = lhOff + 30 + lhlen + lelen;
      out.push({
        name: name, method: method, flag: flag,
        data: u8.subarray(dataOff, dataOff + csize), usize: usize
      });
      p += 46 + nlen + elen + clen;
    }
    return out;
  }

  function importZip(buf) {
    var entries = zipRead(buf);
    var chain = Promise.resolve();
    var n = 0;
    /* E-036：单文件失败以前直接 throw，整个 chain reject，
       而失败【之前】的文件已经真实写进去了 —— 提示却只有"导入失败"。
       错误提示把"部分成功"说成了"整体失败"，用户会再导一次，
       于是前面那批被覆盖第二次，而失败的依然失败。
       所以改成收集失败明细，成功继续，最后一起如实汇报。 */
    var failed = [];
    entries.forEach(function (e) {
      chain = chain.then(function () {
        var name = U.normPath(e.name.replace(/^\/+/, ''));
        if (!name) return;
        if (/\/$/.test(e.name) || e.usize === 0) {
          if (!cache[name]) return create(name, 'dir', '').catch(function () {});
          return;
        }
        var get = e.method === 0 ? Promise.resolve(e.data)
          : e.method === 8 ? inflateRaw(e.data)
            : Promise.reject(new Error('不支持的压缩方式：' + e.method));
        return get.then(function (u) {
          var text = new TextDecoder().decode(u);
          n++;
          if (cache[name]) return write(name, text);
          return create(name, 'file', text);
        }).catch(function (err) {
          failed.push({ name: name, err: String((err && err.message) || err) });
        });
      });
    });
    return chain.then(function () {
      emit('import');
      var out = { imported: n };
      if (failed.length) out.failed = failed;
      return out;
    });
  }

  /* 只看压缩包里有哪些文件，不解压内容、不写入任何东西。
     用途：导入前先告诉用户"哪些会被覆盖"，这必须在动手之前算出来。 */
  function peekZip(buf) {
    var entries;
    try { entries = zipRead(buf); }
    catch (e) { return Promise.reject(e); }
    var names = [];
    entries.forEach(function (e) {
      var name = U.normPath(e.name.replace(/^\/+/, ''));
      if (!name) return;
      if (/\/$/.test(e.name) || e.usize === 0) return;   /* 目录项不算文件 */
      names.push(name);
    });
    return Promise.resolve(names);
  }

  /* ---------- 导入快照与撤销 ----------
   * 导入会覆盖同名文件，而写进去就回不来了。所以要能在事后整体还原。
   *
   * 快照记两类：
   *   - 原本就有的：记住旧内容，撤销时写回
   *   - 原本没有的：记成 null，撤销时删掉
   * 目录只记"原本不存在"，撤销时删掉（目录里若还有别的文件就不删，
   *   所以删除前会再查一次是不是空的）。
   *
   * 快照只活在内存里：撤销"本次导入"是会话内的动作，
   * 刷新之后再说撤销没有意义，也不该占用户的持久化空间。 */
  var importSnap = null;

  function takeImportSnapshot(paths) {
    var snap = { at: Date.now(), files: [], dirs: [] };
    paths.forEach(function (p) {
      if (exists(p)) {
        var st = stat(p);
        if (st && st.type === 'dir') { snap.dirs.push(p); return; }
        snap.files.push({ path: p, prev: read(p) });
      } else {
        snap.files.push({ path: p, prev: null });
      }
    });
    importSnap = snap;
    return snap;
  }

  function hasImportSnapshot() { return !!importSnap; }

  function rollbackImport() {
    if (!importSnap) return Promise.resolve(0);
    var snap = importSnap;
    importSnap = null;
    var chain = Promise.resolve();
    var n = 0;
    /* 文件：有旧内容就写回，原本没有就删掉 */
    snap.files.forEach(function (f) {
      chain = chain.then(function () {
        if (f.prev === null) {
          if (!exists(f.path)) return;
          return remove(f.path).then(function () { n++; }, function () { });
        }
        return write(f.path, f.prev).then(function () { n++; }, function () { });
      });
    });
    /* 目录：只有仍然为空才删，避免误删用户后来放进去的东西 */
    snap.dirs.forEach(function (d) {
      chain = chain.then(function () {
        if (!exists(d)) return;
        var st = stat(d);
        if (!st || st.type !== 'dir') return;
        try {
          var kids = childrenOf ? childrenOf(d) : [];
          if (kids && kids.length) return;
        } catch (e) { return; }
        return remove(d).then(function () { n++; }, function () { });
      });
    });
    return chain.then(function () { emit('rollback'); return n; });
  }

  /* ---------- 导入本地文件 / 文件夹 ---------- */
  /* files: File[]（webkitRelativePath 存在时按目录还原） */
  function importFiles(files) {
    var chain = Promise.resolve(), n = 0;
    Array.prototype.slice.call(files).forEach(function (f) {
      chain = chain.then(function () {
        var rel = U.normPath((f.webkitRelativePath || f.name).replace(/^\/+/, ''));
        if (!rel) return;
        return U.readFileAsText(f).then(function (text) {
          n++;
          if (cache[rel]) return write(rel, text);
          return create(rel, 'file', text);
        }).catch(function () { /* 二进制文件跳过 */ });
      });
    });
    return chain.then(function () { emit('import'); return n; });
  }

  function exportPack() {
    // 导出当前工程为 JSON，用于跨设备迁移（不依赖 zip）
    return JSON.stringify({ v: 1, exported: Date.now(), files: list() }, null, 2);
  }

  /* 只读预览：这个工程包里有哪些文件，不写入任何东西 */
  function peekPack(text) {
    var data;
    try { data = JSON.parse(text); }
    catch (e) { return Promise.reject(new Error('不是本工具导出的工程文件')); }
    if (!data || !data.files) return Promise.reject(new Error('不是本工具导出的工程文件'));
    var names = [];
    data.files.forEach(function (r) {
      var p = U.normPath(r.path);
      if (p) names.push(p);
    });
    return Promise.resolve(names);
  }

  function importPack(text) {
    var data = JSON.parse(text);
    if (!data || !data.files) throw new Error('不是本工具导出的工程文件');
    var chain = Promise.resolve();
    data.files.forEach(function (r) {
      chain = chain.then(function () {
        var p = U.normPath(r.path);
        if (!p) return;
        if (cache[p]) return write(p, r.content || '');
        return create(p, r.type || 'file', r.content || '');
      });
    });
    return chain.then(function () { emit('import'); return data.files.length; });
  }

  Code.fs = {
    init: init, onChange: onChange,
    list: list, read: read, stat: stat, exists: exists,
    create: create, write: write, remove: remove, move: move,
    childrenOf: childrenOf, clearAll: clearAll,
    exportZip: exportZip, importZip: importZip,
    importFiles: importFiles, exportPack: exportPack, importPack: importPack,
    peekZip: peekZip, peekPack: peekPack,
    takeImportSnapshot: takeImportSnapshot,
    hasImportSnapshot: hasImportSnapshot,
    rollbackImport: rollbackImport
  };
})(window);
