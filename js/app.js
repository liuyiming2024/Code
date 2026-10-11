/* app.js —— 启动与装配
   把 util / store / fs / highlight / editor / runner / tree / ui 接到一起。
   启动顺序固定：读设置 → 初始化文件系统 → 渲染文件树 → 初始化编辑器与运行器 →
   初始化界面 → 绑定交互 → 打开上次文件或默认文件。
   本地与线上走的是同一段启动代码，不因部署位置分叉。 */
(function (global) {
  'use strict';
  var Code = global.Code;
  var U = Code.util, store = Code.store, fs = Code.fs,
    ed = Code.editor, runner = Code.runner, tree = Code.tree, UI = Code.ui;

  var dirty = {};          // path -> true，未保存标记
  var booted = false;

  /* ================= 语言识别 ================= */
  var EXT_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json',
    py: 'python', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'cpp', h: 'cpp', hpp: 'cpp',
    html: 'html', htm: 'html', css: 'css',
    md: 'markdown', markdown: 'markdown',
    yml: 'yaml', yaml: 'yaml', sql: 'sql',
    sh: 'shell', bash: 'shell', txt: 'text',
    lua: 'lua', rb: 'ruby', php: 'php'
  };
  var LANG_NAME = {
    javascript: 'JavaScript', python: 'Python', cpp: 'C++', html: 'HTML', css: 'CSS',
    json: 'JSON', markdown: 'Markdown', yaml: 'YAML', sql: 'SQL', shell: 'Shell',
    lua: 'Lua', ruby: 'Ruby', php: 'PHP', text: '纯文本'
  };
  function langOf(path) {
    var ext = (path.split('.').pop() || '').toLowerCase();
    return EXT_LANG[ext] || 'text';
  }

  /* ================= 启动 ================= */
  function boot() {
    var prefs = store.load();
    UI.applyPrefs(prefs);

    fs.init().then(function () {
      fs.onChange(function () { refreshTree(); refreshTargets(); });
      tree.init({ open: openPath, rename: askRename, remove: askRemove, jump: jumpTo });
      ed.init(elWrap());
      runner.init();
      /* 探一次各运行时的缓存状态，扩展中心才知道谁已下载。
         失败不影响启动 —— 这只是界面显示用的探测。 */
      if (Code.runtime && Code.runtime.refreshStatus) {
        try { Code.runtime.refreshStatus().catch(function () { }); }
        catch (e) { /* 探测失败只影响扩展中心的显示，不影响编辑器 */ }
      }
      UI.init({
        open: openPath,
        select: openPath,
        close: closePath,
        closeOthers: function (p) { refreshTabs(); },
        cmd: command
      });
      bind();
      /* 启动时探一次云盘状态。失败不能影响编辑器 ——
         没登录是常态，不能因为云端连不上就拦着人写代码。 */
      try { if (UI.refreshCloud) UI.refreshCloud(); } catch (e) { }
      ed.on('change', onChange);
      ed.on('cursor', onCursor);
      ed.on('save', onSaved);
      UI.setView(prefs.sideView || 'files');
      /* E-043：manifest.json 的快捷方式带 ?action=new / ?action=extensions，
         但以前没有任何代码读它 —— 装到桌面后右键点这两个入口，只是原样打开，
         用户会以为自己点错了。启动后解析一次，执行完清掉参数避免刷新重复触发。 */
      runPwaAction();
      /* 移动端布局：窄屏默认收起侧栏与面板。
         必须在 setView 之后 —— 否则它设置的视图会被后面的逻辑改回去。 */
      try { if (UI.initMobileLayout) UI.initMobileLayout(); } catch (e) { }
      refreshTree();
      refreshTargets();
      applySettingsToUI(prefs);

      var last = prefs.lastPath;
      var files = fs.list().filter(function (r) { return r.type === 'file'; });
      var paths = files.map(function (r) { return r.path; });

      /* E-039：先试着恢复上次的一整排标签，恢复不出再退回单个 lastPath。
         开着 5 个文件刷新只剩 1 个，与"多标签正是他的工作方式"直接冲突。 */
      var restored = null;
      try { if (UI.tabs.restore) restored = UI.tabs.restore(paths); } catch (e) { }

      if (restored) {
        openPath(restored).then(function () {
          /* 其余标签只入栏不逐个打开 —— 打开 5 个文件要读 5 次 IndexedDB，
             启动会明显变慢，而用户只需要看到最后那个。 */
          UI.tabs.persist && UI.tabs.persist();
          refreshTabs();
        });
      } else {
        var start = (last && fs.exists(last)) ? last
          : (files.length ? files[0].path : null);
        if (start) openPath(start);
        else UI.status({ left: '空工程 —— 用左侧「新建文件」开始' });
      }

      booted = true;
      runner.printSys('Code 已就绪。文件存在本机浏览器，代码在本机执行。');
    }).catch(function (err) {
      booted = true;
      U.toast('初始化失败：' + err.message, 'err');
      U.$('#st-left').textContent = '初始化失败：' + err.message;
    });

    /* 移动端辅助键条。手机输入法没有 Tab / Ctrl / 方向键，
       不补这些键根本写不了代码。非触摸设备会自动跳过。 */
    /* 内置键盘：上次开过就还是开着。放在 editor 就绪之后 ——
       键盘的所有输入都走 editor 接口，编辑器没好就没法插入。 */
    try {
      if (Code.vkb) {
        if (Code.vkb.loadOn && Code.vkb.loadOn()) Code.vkb.setOn(true);
        else if (Code.vkb.maybeOffer) setTimeout(Code.vkb.maybeOffer, 1200);
      }
    } catch (e) { }

    try { if (Code.mobileBar) Code.mobileBar.init(); } catch (e) { }

    /* 注册离线缓存。就算失败也只是没有"断网可用"和"装到桌面"，
       编辑器本身照常工作 —— 所以必须在 fs.init 之外，不受其成败影响。 */
    try { if (Code.pwa) Code.pwa.register(); } catch (e) { }
  }

  function elWrap() {
    return {
      scroll: U.$('#editor-scroll'),
      ta: U.$('#editor'),
      hl: U.$('#highlight'),
      gutter: U.$('#gutter'),
      crumb: U.$('#breadcrumb')
    };
  }

  /* ================= 文件操作 ================= */
  function openPath(path) {
    if (!path || !fs.exists(path)) return Promise.resolve();
    flushDirty();
    return ed.open(path).then(function () {
      UI.tabs.add(path);
      refreshTabs();
      tree.select(path);
      tree.reveal(path);
      store.set('lastPath', path);
      var lang = langOf(path);
      U.$('#run-target').value = path;
      var sel = U.$('#run-lang');
      if (sel) sel.value = lang;
      updateRunHint(path);
      UI.status({ lang: LANG_NAME[lang] || lang, left: path });
      ed.focus();
    }).catch(function (e) { U.toast('打不开：' + e.message, 'err'); });
  }

  function closePath(path) {
    flushDirty();
    UI.tabs.close(path);
    ed.close(path);
    refreshTabs();
    var cur = UI.tabs.current();
    if (cur) openPath(cur);
    else UI.status({ left: '没有打开的文件', lang: '—', pos: '—', size: '—' });
  }

  /* E-037：langs.js 自己立的规矩是"界面必须如实显示档位，不许含糊"，
     runHint() 也写好了，但以前全仓零调用 —— 用户点开 .sql 按运行才知道要下载
     0.7 MB，点开 .rb 才知道是 33.6 MB。运行前完全没有预告。
     所以把预告挂到运行按钮的 title 上，并在状态栏右侧常驻一句。 */
  function updateRunHint(path) {
    try {
      var txt = (Code.runner && Code.runner.hint) ? Code.runner.hint(path || '') : '';
      if (!txt) return;
      ['#btn-run', '#btn-run2'].forEach(function (id) {
        var b = U.$(id);
        if (b) b.title = '运行（Ctrl+Enter）\n' + txt;
      });
      var slot = U.$('#st-hint');
      if (slot) slot.textContent = txt;
    } catch (e) { }
  }

  function refreshTabs() {
    UI.tabs.render();
    document.querySelectorAll('#tabsbar .tab').forEach(function (t) {
      t.classList.toggle('dirty', !!dirty[t.dataset.path]);
    });
  }

  function onChange(path, text) {
    dirty[path] = true;
    refreshTabs();
    scheduleSave(path);
  }

  var saveTimer = null;
  function scheduleSave(path) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { flushDirty(); }, 700);
  }
  /* 保存失败的告警只有这一处实现，手动保存（Ctrl+S）与自动保存都走它。
     以前是自动保存修好了、Ctrl+S 那条没跟上 —— 同一份内容先报成功再报失败。
     抽成函数就是为了让"两条路必须一致"这件事在代码里看得出来。 */
  function onSaveFail(err) {
    U.toast('保存失败：' + (err && err.message || err), 'err');
    UI.status({ left: '保存失败 —— 请立刻导出 ZIP 备份' });
    U.modal({
      title: '保存失败',
      body: '<p class="about-p">写入浏览器存储时出错：<b>' + U.esc(String(err && err.message || err)) + '</b></p>' +
            '<p class="about-p">可能是存储空间已满，或浏览器禁用了本站存储。' +
            '未保存的内容还在编辑区里，但<b>刷新页面就会丢失</b>。</p>' +
            '<p class="about-p">建议现在就点「导出 ZIP 备份」把文件存到磁盘。</p>',
      actions: [
        { label: '知道了' },
        { label: '立刻导出备份', primary: true, onClick: function () { setTimeout(doExport, 0); } }
      ]
    });
  }

  function flushDirty() {
    clearTimeout(saveTimer);
    var p = ed.current();
    if (!p) return;
    /* ed.save() 在没有当前文件时会返回 undefined（flushSave 里 cur 为空直接 return）。
       直接 .then 会抛 TypeError —— 这个崩在打开文件的路径上，会让文件打不开。
       所以先包成 Promise。 */
    Promise.resolve().then(function () { return ed.save(); }).catch(onSaveFail);
  }

  function onSaved(path) {
    delete dirty[path];
    refreshTabs();
    UI.status({ left: '已保存到本机浏览器 · ' + path });
  }

  function onCursor(c) {
    UI.status({
      pos: '行 ' + c.line + '，列 ' + c.col + (c.sel ? '（选中 ' + c.sel + ' 字符）' : ''),
      size: c.bytes + ' 字节 / ' + c.total + ' 行'
    });
  }

  function flushAll() {
    var p = ed.current();
    if (p) ed.save();
  }

  function newFile() {
    U.modal({
      title: '新建文件',
      inputs: [{ name: 'name', label: '路径（可含目录，如 src/main.js）', placeholder: 'hello.js' }],
      actions: [
        { label: '取消' },
        {
          label: '创建', primary: true, onClick: function (close, v) {
            var p = U.normPath((v.name || '').trim());
            if (!p) { U.toast('路径不能为空', 'err'); return false; }
            if (fs.exists(p)) { U.toast('已存在同名文件', 'err'); return false; }
            close();
            fs.create(p, 'file', '').then(function () { openPath(p); })
              .catch(function (e) { U.toast(e.message, 'err'); });
          }
        }
      ]
    });
  }

  function newFolder() {
    U.modal({
      title: '新建文件夹',
      inputs: [{ name: 'name', label: '路径', placeholder: 'src' }],
      actions: [
        { label: '取消' },
        {
          label: '创建', primary: true, onClick: function (close, v) {
            var p = U.normPath((v.name || '').trim());
            if (!p) { U.toast('路径不能为空', 'err'); return false; }
            if (fs.exists(p)) { U.toast('已存在', 'err'); return false; }
            close();
            fs.create(p, 'dir', '').then(function () { U.toast('已创建 ' + p); })
              .catch(function (e) { U.toast(e.message, 'err'); });
          }
        }
      ]
    });
  }

  function askRename(path) {
    U.modal({
      title: '重命名',
      inputs: [{ name: 'name', label: '新路径', value: path }],
      actions: [
        { label: '取消' },
        {
          label: '确定', primary: true, onClick: function (close, v) {
            var to = U.normPath((v.name || '').trim());
            if (!to || to === path) return;
            if (fs.exists(to)) { U.toast('目标已存在', 'err'); return false; }
            close();
            flushAll();
            fs.move(path, to).then(function () {
              var open = UI.tabs.list().indexOf(path);
              if (open >= 0) { UI.tabs.close(path); openPath(to); }
              U.toast('已重命名为 ' + to);
            }).catch(function (e) { U.toast(e.message, 'err'); });
          }
        }
      ]
    });
  }

  function askRemove(path) {
    var st = fs.stat(path);
    var tip = st && st.type === 'dir' ? '文件夹及其内容会一起删除。' : '文件会被删除。';
    U.modal({
      title: '删除',
      body: '<p class="about-p">确定删除 <b>' + U.esc(path) + '</b> 吗？' + tip +
        '删除后无法在本工具内恢复，建议先导出备份。</p>',
      actions: [
        { label: '取消' },
        {
          label: '删除', primary: true, onClick: function (close) {
            close();
            /* E-031：删除【文件夹】时其下所有标签都要关掉。
               只关 path 本身的话，子文件标签还挂着，继续打字会把它们重建出来。 */
            var hits = affectedTabs(path);
            if (hits.length > 1 || (hits.length === 1 && hits[0] !== path)) {
              dropTabs(path);
            } else if (UI.tabs.list().indexOf(path) >= 0) {
              closePath(path);
            }
            fs.remove(path).then(function () { U.toast('已删除 ' + path); refreshTabs(); })
              .catch(function (e) { U.toast(e.message, 'err'); });
          }
        }
      ]
    });
  }

  function jumpTo(path, line) {
    openPath(path).then(function () {
      if (line > 0) {
        var ta = U.$('#editor');
        var v = ta.value, idx = 0;
        for (var i = 1; i < line && idx >= 0; i++) idx = v.indexOf('\n', idx) + 1;
        if (idx >= 0) {
          ta.focus();
          ta.setSelectionRange(idx, idx);
          ed.refresh();
        }
      }
    });
  }

  function refreshTree() { tree.render(); }

  /* ================= 导入导出 ================= */
  function doExport() {
    flushAll();
    var blob = fs.exportZip();
    /* E-044：以前固定叫 code-workspace.zip，多次导出互相覆盖或变成 (1)(2)，
       真要恢复时只能靠文件修改时间猜顺序。而备份是本项目唯一的防丢手段。
       所以带上日期时间，文件名本身就能排出先后。 */
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes());
    U.download('code-workspace-' + stamp + '.zip', blob);
    U.toast('已导出 ' + fs.list().length + ' 项');
  }

  /* ================= 导入 =================
   *
   * 导入会覆盖同名文件，而覆盖是不可恢复的（云端没有版本历史，
   * 本地也没有）。所以这里做三层：
   *
   *   1. 导入前确认 —— 告诉总共要导入多少
   *   2. 有同名文件时二次确认 —— 明确列出会被覆盖的那些
   *   3. 导入后可撤销 —— 动手前存快照，给一条退路
   *
   * 三层不是重复：第 1 层拦的是"手滑选错文件"，
   * 第 2 层拦的是"没想到会撞名"，第 3 层接的是"看结果才发现不该导"。
   * 前两层是防，第三层是补救 —— 防不住的情况一定存在，所以退路必须有。
   */
  function doImport() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = '.zip,.json,.*';
    inp.onchange = function () {
      var picked = Array.prototype.slice.call(inp.files || []);
      if (!picked.length) return;
      /* 先只读地算出"会导入哪些、哪些会撞名"，一步都不写 */
      peekAll(picked).then(function (info) {
        confirmThenImport(picked, info);
      }).catch(function (e) {
        U.toast('读不了：' + String(e && e.message || e), 'err');
      });
    };
    inp.click();
  }

  /* 只读预览：不写入任何东西 */
  function peekAll(picked) {
    var names = [], chain = Promise.resolve();
    picked.forEach(function (f) {
      chain = chain.then(function () {
        if (/\.zip$/i.test(f.name)) {
          return U.readFileAsArrayBuffer(f).then(fs.peekZip).then(function (ns) {
            names = names.concat(ns);
          }).catch(function () { names.push(f.name); });
        }
        if (/\.json$/i.test(f.name)) {
          return U.readFileAsText(f).then(function (t) {
            return fs.peekPack(t).then(function (ns) { names = names.concat(ns); },
              function () { names.push(f.name); });
          }).catch(function () { names.push(f.name); });
        }
        if (!/\.(zip|json)$/i.test(f.name)) {
          names.push(U.normPath((f.webkitRelativePath || f.name).replace(/^\/+/, '')));
        }
      });
    });
    return chain.then(function () {
      var uniq = [];
      names.forEach(function (n) { if (n && uniq.indexOf(n) < 0) uniq.push(n); });
      var dup = uniq.filter(function (n) { return fs.exists(n); });
      return { all: uniq, dup: dup };
    });
  }

  function confirmThenImport(picked, info) {
    var total = info.all.length, dup = info.dup;

    /* 第一层：确认要导入 */
    U.modal({
      title: '导入文件',
      body: '<p class="about-p">将导入 <b>' + total + '</b> 个文件。</p>' +
        (dup.length
          ? '<p class="about-p">其中 <b>' + dup.length + '</b> 个与现有文件同名，' +
            '导入后<b>会被覆盖</b>。</p>'
          : '<p class="about-p">没有与现有文件同名的，不会覆盖任何东西。</p>'),
      actions: [
        { label: '取消', primary: true },
        { label: '继续', onClick: function () { secondConfirm(picked, info); } }
      ]
    });
  }

  /* 第二层：有同名才出现，明确列出会被覆盖的 */
  function secondConfirm(picked, info) {
    var dup = info.dup;
    if (!dup.length) { runImport(picked, info); return; }
    var show = dup.slice(0, 12).map(function (d) { return '<li>' + U.esc(d) + '</li>' }).join('');
    var more = dup.length > 12 ? '<li>…以及另外 ' + (dup.length - 12) + ' 个</li>' : '';
    U.modal({
      title: '会覆盖 ' + dup.length + ' 个文件',
      body: '<p class="about-p">下列文件已存在，导入后<b>原内容会被替换</b>：</p>' +
        '<ul class="about-ul">' + show + more + '</ul>' +
        '<p class="about-p">导入前会自动存一份快照，导完可以撤销。</p>',
      actions: [
        { label: '取消', primary: true },
        { label: '覆盖并导入', onClick: function () { runImport(picked, info); } }
      ]
    });
  }

  function runImport(picked, info) {
    /* 第三层的地基：动手之前先存快照 */
    try { fs.takeImportSnapshot(info.all); } catch (e) { }

    var chain = Promise.resolve(), zips = 0, singles = 0;
    var importFailures = [];
    picked.forEach(function (f) {
      chain = chain.then(function () {
        if (/\.zip$/i.test(f.name)) {
          return U.readFileAsArrayBuffer(f).then(fs.importZip).then(function (r) {
            var got = (r && typeof r === 'object') ? (r.imported || 0) : (r || 0);
            zips += got;
            if (r && r.failed && r.failed.length) importFailures = importFailures.concat(r.failed);
          });
        }
        if (/\.json$/i.test(f.name)) {
          return U.readFileAsText(f).then(function (t) {
            try { return fs.importPack(t).then(function (n) { singles += n; }); }
            catch (e) { return fs.importFiles([f]).then(function (n) { singles += n; }); }
          });
        }
        return fs.importFiles([f]).then(function (n) { singles += n; });
      });
    });

    chain.then(function () {
      refreshTree(); refreshTargets();
      var done = zips + singles;

      if (importFailures.length) {
        var names = importFailures.slice(0, 5).map(function (x) { return x.name; }).join('、');
        var more = importFailures.length > 5 ? ' 等 ' + importFailures.length + ' 个' : '';
        U.modal({
          title: '导入部分完成',
          body: '<p class="about-p">成功 <b>' + done + '</b> 个，失败 <b>' +
            importFailures.length + '</b> 个。</p>' +
            '<p class="about-p">失败的文件：' + U.esc(names + more) + '</p>' +
            '<p class="about-p">原因：' + U.esc(String(importFailures[0].err || '')) + '</p>' +
            '<p class="about-p">成功部分<b>已经写入</b>。' +
            '不要重复导入 —— 那样会把它们再覆盖一次。</p>',
          actions: [
            { label: '知道了', primary: true },
            { label: '撤销本次导入', onClick: function () { undoImport(); } }
          ]
        });
        U.toast('导入部分完成：成功 ' + done + '，失败 ' + importFailures.length, 'err');
        return;
      }

      /* 成功时也给撤销入口 —— 用户看到结果才发现不该导，是常有的事 */
      U.modal({
        title: '导入完成',
        body: '<p class="about-p">已导入 <b>' + done + '</b> 个文件' +
          (info.dup.length ? '（其中 ' + info.dup.length + ' 个覆盖了原有文件）' : '') + '。</p>' +
          '<p class="about-p">如果不该导，现在可以撤销。</p>',
        actions: [
          { label: '完成', primary: true },
          { label: '撤销本次导入', onClick: function () { undoImport(); } }
        ]
      });
      U.toast('导入完成：' + done + ' 个');
    }).catch(function (e) { U.toast('导入失败：' + e.message, 'err'); });
  }

  /* 撤销：把快照写回去。只在本次会话有效 ——
     刷新之后再说"撤销上次导入"是没有意义的，也容易误伤后来的改动。 */
  function undoImport() {
    if (!fs.hasImportSnapshot || !fs.hasImportSnapshot()) {
      U.toast('没有可撤销的导入', 'err');
      return;
    }
    U.modal({
      title: '撤销本次导入',
      body: '<p class="about-p">会还原到导入前的状态：被覆盖的文件写回原内容，' +
        '新导入的文件删掉。</p>' +
        '<p class="about-p">导入<b>之后</b>你做的改动也会被一起还原 —— ' +
        '如果导完又改了东西，请先导出备份。</p>',
      actions: [
        { label: '算了', primary: true },
        {
          label: '撤销', onClick: function () {
            fs.rollbackImport().then(function (n) {
              refreshTree(); refreshTargets();
              try { UI.tabs.render(); } catch (e) { }
              U.toast('已撤销，还原了 ' + n + ' 项');
            }).catch(function (e) { U.toast('撤销失败：' + e.message, 'err'); });
          }
        }
      ]
    });
  }

  function refreshTargets() {
    var sel = U.$('#run-target');
    if (!sel) return;
    var cur = sel.value;
    var files = fs.list().filter(function (r) { return r.type === 'file'; })
      .map(function (r) { return r.path; }).sort();
    sel.innerHTML = '';
    files.forEach(function (p) {
      sel.appendChild(U.el('option', { value: p, text: p }));
    });
    if (cur && files.indexOf(cur) >= 0) sel.value = cur;
    else if (ed.current()) sel.value = ed.current();
  }

  /* ================= 运行 ================= */
  function doRun() {
    var sel = U.$('#run-target');
    var path = (sel && sel.value) || ed.current();
    if (!path) { U.toast('没有可运行的文件', 'err'); return; }
    flushAll();
    UI.panel.open(true);
    UI.panel.show('output');
    var code = fs.read(path) || '';
    var lang = langOf(path);
    runner.run(path, code, lang);
    UI.status({ left: '运行 ' + path });
  }

  function command(name) {
    switch (name) {
      case 'new-file': newFile(); break;
      case 'new-folder': newFolder(); break;
      case 'save': flushAll(); U.toast('已保存'); break;
      case 'run': doRun(); break;
      case 'export': doExport(); break;
      case 'import': doImport(); break;
      case 'theme': toggleTheme(); break;
      case 'panel': UI.panel.open(!UI.panel.isOpen()); break;
      case 'clear': runner.clear(); break;
      case 'about': UI.about(); break;
      case 'extensions': UI.extensions(); break;
      /* E-041：refresh 以前根本没有这个 case —— 就算按钮绑上了也是死的 */
      /* 撤销上次导入：快照只在会话内有效，有才显示这个命令 */
      case 'undo-import': undoImport(); break;
      /* E-030：预览必须有关闭出口。按钮、命令面板、Esc 三条路都给上。 */
      case 'close-preview':
        if (runner.hidePreview) runner.hidePreview();
        U.toast('已关闭预览');
        break;
      case 'refresh':
        tree.render();
        try {
          var sel = U.$('#run-target');
          if (sel && sel.value) UI.status({ left: sel.value });
        } catch (e) { }
        U.toast('已刷新文件树');
        break;
    }
  }

  function toggleTheme() {
    var next = store.prefs.theme === 'dark' ? 'light' : 'dark';
    store.set('theme', next);
    UI.applyTheme(next);
    var sel = U.$('#set-theme');
    if (sel) sel.value = next;
  }

  /* ================= AI 设置 =================
     密钥只写 localStorage。仓库里没有，也不经过任何中间服务器。 */
  function renderAiHint() {
    var h = U.$('#ai-hint');
    if (!h || !Code.ai) return;
    var a = Code.ai.load();
    var p = Code.ai.preset(a.preset);
    var txt = '';
    if (p && p.note) txt += p.note;
    if (p && p.keyURL) {
      txt += ' <a href="' + p.keyURL + '" target="_blank" rel="noopener">去拿密钥</a>';
    }
    /* 计费状态直接告诉用户，不让他猜 */
    var bt = Code.ai.billingText(a.model);
    txt += '<br>' + bt.text;
    if (p && p.warn) txt += '<br>' + p.warn;
    if (!a.apiKey || !a.enabled) {
      txt += '<br><b>未启用</b>：填入密钥并开启后，才会出现 AI 相关入口。';
    }
    h.innerHTML = txt;
  }

  function bindAi() {
    if (!Code.ai) return;
    var sel = U.$('#set-ai-preset');
    if (sel) {
      Code.ai.PRESETS.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        var p = Code.ai.preset(this.value);
        if (!p) return;
        /* 选预置就自动带出地址和模型名，省得手抄错。自定义那项留空给人填。 */
        Code.ai.save({ preset: p.id, baseURL: p.baseURL, model: p.model });
        var b = U.$('#set-ai-base'), m = U.$('#set-ai-model');
        if (b) b.value = p.baseURL;
        if (m) m.value = p.model;
        renderAiHint();
      });
    }
    var on = function (id, evt, fn) { var e = U.$(id); if (e) e.addEventListener(evt, fn); };
    on('#set-ai-enabled', 'change', function () {
      Code.ai.save({ enabled: this.value === 'on' });
      renderAiHint();
      U.toast(this.value === 'on' ? 'AI 已开启（需已填密钥）' : 'AI 已关闭');
    });
    ['#set-ai-base', '#set-ai-model', '#set-ai-key'].forEach(function (id) {
      on(id, 'change', function () {
        Code.ai.save(id === '#set-ai-base' ? { baseURL: this.value.trim() }
          : id === '#set-ai-model' ? { model: this.value.trim() }
          : { apiKey: this.value.trim() });
        renderAiHint();
      });
    });
    on('#btn-ai-test', 'click', function () {
      if (!Code.ai.ready()) { U.toast('请先填入密钥并开启', 'err'); return; }
      U.toast('测试中…');
      Code.ai.chat([{ role: 'user', content: '回复两个字：可用' }],
        { timeout: 30000, skipPaidCheck: true })
        .then(function (r) {
          U.toast('连接成功：' + String(r.text || '').slice(0, 40));
        })
        .catch(function (e) {
          U.toast(String(e && e.message || e).split('\n')[0], 'err');
        });
    });
    on('#btn-ai-clear', 'click', function () {
      Code.ai.clearKey();
      var k = U.$('#set-ai-key'); if (k) k.value = '';
      var en = U.$('#set-ai-enabled'); if (en) en.value = 'off';
      renderAiHint();
      U.toast('密钥已删除');
    });
  }

  Code.bindAiHint = renderAiHint;

  /* ================= 设置 ================= */
  function applySettingsToUI(p) {
    var map = {
      '#set-theme': p.theme, '#set-fontsize': p.fontSize, '#set-tabsize': p.tabSize,
      '#set-indent': p.indentMode, '#set-wrap': p.wordWrap ? 'on' : 'off',
      '#set-ws': p.showWS ? 'on' : 'off'
    };
    if (Code.ai) {
      var a = Code.ai.load();
      var put = function (sel, v) { var e = U.$(sel); if (e) e.value = v; };
      put('#set-ai-enabled', a.enabled ? 'on' : 'off');
      put('#set-ai-preset', a.preset || 'zhipu');
      put('#set-ai-base', a.baseURL || '');
      put('#set-ai-model', a.model || '');
      put('#set-ai-key', a.apiKey || '');
      renderAiHint();
    }
    Object.keys(map).forEach(function (k) {
      var el = U.$(k);
      if (el) el.value = map[k];
    });
  }

  /* ================= 内置键盘 ================= */
  function bindVkb() {
    var sel = U.$('#set-vkb');
    if (!sel) return;
    sel.addEventListener('change', function () {
      var v = this.value === 'on';
      try { localStorage.setItem('code_vkb_on', v ? 'on' : 'off'); } catch (e) { }
      if (Code.vkb) Code.vkb.setOn(v);
      U.toast(v ? '内置键盘已开启' : '已切回系统输入法');
    });
  }

  /* ================= 云盘 ================= */
  function bindCloud() {
    var on = function (sel, evt, fn) {
      var el = U.$(sel);
      if (el) el.addEventListener(evt, fn);
    };
    if (!Code.cloud) return;

    on('#btn-cloud-login', 'click', function () {
      var nick = (U.$('#cloud-nick') || {}).value || '';
      var pwd = (U.$('#cloud-pwd') || {}).value || '';
      if (!nick.trim() || !pwd) { U.toast('请填昵称与密码', 'err'); return; }
      U.toast('登录中…');
      Code.cloud.login(nick.trim(), pwd)
        .then(function () { U.toast('已登录'); if (UI.refreshCloud) UI.refreshCloud(); })
        .catch(function (e) { U.toast(String(e.message || e), 'err'); });
    });

    on('#btn-cloud-register', 'click', function () {
      var nick = (U.$('#cloud-nick') || {}).value || '';
      var pwd = (U.$('#cloud-pwd') || {}).value || '';
      if (!nick.trim() || !pwd) { U.toast('请填昵称与密码', 'err'); return; }
      U.toast('注册中…');
      Code.cloud.register(nick.trim(), pwd)
        .then(function () {
          /* 注册后多数站点要求审核，不自动登录 */
          U.toast('注册成功。若站点需审核，请等管理员通过后再登录');
          if (UI.refreshCloud) UI.refreshCloud();
        })
        .catch(function (e) { U.toast(String(e.message || e), 'err'); });
    });

    on('#btn-cloud-redeem', 'click', function () {
      var t = (U.$('#cloud-ticket') || {}).value || '';
      if (!t.trim()) { U.toast('请粘贴票据码', 'err'); return; }
      U.toast('兑换中…');
      Code.cloud.redeem(t.trim())
        .then(function (j) {
          U.toast('已登录：' + ((j && j.nick) || '成功'));
          var el = U.$('#cloud-ticket'); if (el) el.value = '';
          if (UI.refreshCloud) UI.refreshCloud();
        })
        .catch(function (e) { U.toast(String(e.message || e), 'err'); });
    });

    on('#btn-cloud-logout', 'click', function () {
      Code.cloud.logout()
        .then(function () { if (UI.refreshCloud) UI.refreshCloud(); })
        .catch(function () { if (UI.refreshCloud) UI.refreshCloud(); });
    });

    /* 传输进度：大文件逐个上传要走很久，没有任何反馈的话
       用户会以为卡死了然后刷新，结果前功尽弃。
       所以每传一个都更新状态栏。 */
    var progress = function (done, total, name) {
      var el = U.$('#cloud-state');
      if (!el) return;
      el.innerHTML = '<b>传输中 ' + done + '/' + total + '</b><br>' +
        String(name).replace(/</g, '&lt;');
    };

    on('#btn-cloud-push', 'click', function () {
      /* E-020：下载弹确认、上传却不弹 —— 同一条原则只守了一侧。
         反向同样成立：用户在 A 机器写完、换到 B 机器改过、回 A 点上传，
         B 的那一版就没了，而云端没有版本历史、不可恢复。 */
      U.modal({
        title: '上传到云端',
        body: '<p class="about-p">会用<b>本地内容覆盖云端同名文件</b>。' +
          '云端没有版本历史，覆盖后不可恢复。</p>' +
          '<p class="about-p">如果另一台设备上改过同一批文件，那一版会被这一版顶掉。</p>' +
          '<p class="about-p">确定继续？</p>',
        actions: [
          { label: '取消', primary: true },
          { label: '上传并覆盖', onClick: function () { doCloudPush(); } }
        ]
      });
    });

    function doCloudPush() {
      U.toast('上传中…');
      Code.cloud.pushAll(function (d, t, n) { progress(d, t, n); })
        .then(function (r) {
          var msg = '已上传 ' + (r && r.pushed != null ? r.pushed : 0) + ' 个文件';
          if (r && r.failed) msg += '，失败 ' + r.failed + ' 个' + (r.lastErr ? '（' + r.lastErr + '）' : '');
          U.toast(msg, r && r.failed ? 'err' : 'ok');
          if (UI.refreshCloud) UI.refreshCloud();
        })
        .catch(function (e) { U.toast(String(e.message || e), 'err'); if (UI.refreshCloud) UI.refreshCloud(); });
    }

    on('#btn-cloud-pull', 'click', function () {
      /* 覆盖本地同名文件，先问一次 —— 这一步会改用户电脑上的东西 */
      U.modal({
        title: '从云端下载',
        body: '<p class="about-p">会用云端内容<b>覆盖本地同名文件</b>。' +
          '本地有而云端没有的文件不受影响。</p>' +
          '<p class="about-p">确定继续？</p>',
        actions: [
          { label: '取消', primary: true },
          {
            label: '下载并覆盖', onClick: function () {
              U.toast('下载中…');
              Code.cloud.pullAll(function (d, t, n) { progress(d, t, n); })
                .then(function (r) {
                  var msg = '已下载 ' + (r && r.pulled != null ? r.pulled : 0) + ' 个文件';
                  if (r && r.failed) msg += '，失败 ' + r.failed + ' 个';
                  U.toast(msg, r && r.failed ? 'err' : 'ok');
                  if (UI.refreshCloud) UI.refreshCloud();
                })
                .catch(function (e) { U.toast(String(e.message || e), 'err'); });
            }
          }
        ]
      });
    });

    on('#btn-cloud-reset', 'click', function () {
      U.modal({
        title: '清空云盘',
        body: '<p class="about-p">会删除<b>云端全部文件</b>，不可恢复。</p>' +
          '<p class="about-p">本地文件不受影响。确定继续？</p>',
        actions: [
          { label: '取消', primary: true },
          {
            label: '确认清空', onClick: function () {
              Code.cloud.cloudReset()
                .then(function () { U.toast('云盘已清空'); if (UI.refreshCloud) UI.refreshCloud(); })
                .catch(function (e) { U.toast(String(e.message || e), 'err'); });
            }
          }
        ]
      });
    });
  }

  function bindSettings() {
    var on = function (sel, evt, fn) {
      var el = U.$(sel);
      if (el) el.addEventListener(evt, fn);
    };
    on('#set-theme', 'change', function () {
      store.set('theme', this.value); UI.applyTheme(this.value);
    });
    on('#set-fontsize', 'change', function () {
      var n = Math.max(11, Math.min(22, parseInt(this.value, 10) || 14));
      this.value = n; store.set('fontSize', n); ed.applyPrefs(store.prefs);
    });
    on('#set-tabsize', 'change', function () {
      var n = Math.max(1, Math.min(8, parseInt(this.value, 10) || 4));
      this.value = n; store.set('tabSize', n); ed.applyPrefs(store.prefs);
    });
    on('#set-indent', 'change', function () { store.set('indentMode', this.value); });
    on('#set-wrap', 'change', function () {
      store.set('wordWrap', this.value === 'on'); ed.applyPrefs(store.prefs);
    });
    on('#set-ws', 'change', function () {
      store.set('showWS', this.value === 'on');
      ed.refresh();
    });
    on('#btn-goto-cloud', 'click', function () {
      UI.setView('cloud');
      try { store.set('sideView', 'cloud'); } catch (e) { }
      if (UI.refreshCloud) UI.refreshCloud();
    });
    bindCloud();
    bindVkb();
    bindAi();

    on('#btn-reset', 'click', function () {
      U.modal({
        title: '恢复默认设置',
        body: '<p class="about-p">只重置外观与编辑偏好，文件不动。</p>',
        actions: [
          { label: '取消' },
          {
            label: '重置', primary: true, onClick: function () {
              store.reset();
              UI.applyPrefs(store.prefs);
              ed.applyPrefs(store.prefs);
              applySettingsToUI(store.prefs);
              U.toast('已恢复默认设置');
            }
          }
        ]
      });
    });
  }

  /* PWA 快捷方式：右键桌面图标 → 新建文件 / 扩展中心 */
  function runPwaAction() {
    var a = '';
    try { a = new URLSearchParams(location.search).get('action') || ''; } catch (e) { return; }
    if (!a) return;
    try {
      if (a === 'new') command('new-file');
      else if (a === 'extensions') UI.extensions();
      /* 清掉参数：否则刷新会再触发一次（用户在"新建"里填了名又被弹一次） */
      history.replaceState(null, '', location.pathname);
    } catch (e) { }
  }

  /* ================= 绑定 ================= */
  function bind() {
    /* E-041：側栏文件树上方的「新建文件 / 新建文件夹 / 刷新」三个按钮在
       #side-actions 里，而以前只绑 '#top-menu [data-act]' —— 选择器选不到，
       点了完全没反应。那是新用户最先会点的位置（一个显眼的 + 号），
       点了没反应会让人以为编辑器坏了。
       所以改成全量绑定，不再限定父容器。 */
    U.$$('[data-act]').forEach(function (b) {
      b.onclick = function () {
        var a = b.getAttribute('data-act');
        if (a === 'about') UI.about();
        else if (a === 'extensions') UI.extensions();
        else if (a === 'palette') UI.palette('cmd');
        else command(a);
      };
    });
    var br = U.$('#btn-run'); if (br) br.onclick = doRun;
    var bpc = U.$('#btn-preview-close');
    if (bpc) bpc.onclick = function () { command('close-preview'); };
    var bt = U.$('#btn-theme'); if (bt) bt.onclick = toggleTheme;
    /* 顶栏菜单：以前这个按钮绑的是 toggleSide，而 #top-menu 没有任何代码
       给它加 open 类 —— 那 7 个菜单项（新建、导出、导入、扩展中心、关于…）
       从来没有出现在界面上，是死 UI。
       桌面还能靠 Ctrl+Shift+P 走命令面板绕过去，手机上连快捷键都没有，
       等于这些功能在手机上完全不可达。所以这里让它真正打开菜单。
       侧栏切换另有入口：活动栏图标 + Ctrl+B。 */
    var bm = U.$('#btn-menu');
    var menuEl = U.$('#top-menu');
    function closeMenu() { if (menuEl) menuEl.classList.remove('open'); }
    function toggleMenu() {
      if (!menuEl) return;
      menuEl.classList.toggle('open');
    }
    if (bm) {
      bm.onclick = function (e) {
        e.stopPropagation();
        toggleMenu();
      };
    }
    /* 点别处关掉；菜单内的项点完也关 */
    document.addEventListener('click', function (e) {
      if (!menuEl) return;
      if (menuEl.contains(e.target) || (bm && bm.contains(e.target))) return;
      closeMenu();
    });
    U.$$('#top-menu [data-act]').forEach(function (b) {
      var prev = b.onclick;
      b.onclick = function () { closeMenu(); if (prev) prev(); };
    });

    /* 运行视图 */
    var r2 = U.$('#btn-run2'); if (r2) r2.onclick = doRun;
    var st = U.$('#btn-stop'); if (st) st.onclick = function () { runner.stop(); };
    var cl = U.$('#btn-clear'); if (cl) cl.onclick = function () { runner.clear(); };
    var rl = U.$('#run-lang');
    if (rl) rl.addEventListener('change', function () {
      var p = U.$('#run-target').value;
      if (!p) return;
      if (!runner.hasRuntime(this.value)) {
        runner.printSys(LANG_NAME[this.value] + ' 运行时未内置：本工具不伪造执行，请改用 JavaScript 或 HTML。');
      }
    });

    /* 面板按钮 */
    /* E-045：按当前面板清对应内容。按钮常驻却只在「输出」下有效，
       在「控制台」点它毫无反应，用户会以为工具坏了。 */
    var pc = U.$('#btn-panel-clear');
    if (pc) pc.onclick = function () {
      var which = (UI.panel && UI.panel.name) || 'output';
      if (which === 'console') {
        if (runner.clear) runner.clear('console');
        var cbox = U.$('#panel-console');
        if (cbox) cbox.innerHTML = '';
      } else if (runner.clear) {
        runner.clear();
        var obox = U.$('#panel-output');
        if (obox) obox.innerHTML = '';
      }
    };
    var px = U.$('#btn-panel-close');
    if (px) px.onclick = function () { UI.panel.open(false); store.set('panelOpen', false); };

    bindSettings();

    /* 快捷键 */
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      var k = e.key.toLowerCase();
      if (k === 'p' && !e.shiftKey) { e.preventDefault(); UI.palette('file'); }
      else if (k === 'p' && e.shiftKey) { e.preventDefault(); UI.palette('cmd'); }
      else if (k === 'enter') { e.preventDefault(); doRun(); }
      else if (k === 's') { e.preventDefault(); flushAll(); U.toast('已保存'); }
      else if (e.key === '`') { e.preventDefault(); UI.panel.open(!UI.panel.isOpen()); }
      else if (k === 'b') { e.preventDefault(); UI.toggleSide(); }
    });

    /* 离开前保存 */
    global.addEventListener('beforeunload', function () { flushAll(); });
  }

  Code.app = {
    onSaveFail: onSaveFail,
    /* 供命令面板与自动化调用。名字与 command() 的 case 对齐，
       不另起一套说法 —— 两处叫不同名字，后来的人会对不上。 */
    import: doImport,
    undoImport: undoImport,
    exportZip: doExport, boot: boot, run: doRun, open: openPath, exportZip: doExport, importPick: doImport };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
