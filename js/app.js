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
  /* ===== 崩溃恢复 =====
   * 上次是不是没写完就走了？是就把内容还给用户，并明确告诉他发生了什么。
   * 静默恢复同样不行 —— 用户得知道"上次没存住"，否则他会以为自动保存一直管用。
   */
  function restoreDraftIfAny() {
    var d = null;
    try { d = ed.takeDraft ? ed.takeDraft() : null; } catch (e) { return; }
    if (!d) return;
    var same = true;
    try {
      var now = fs.read(d.path);
      same = (now === d.content);
    } catch (e) { same = false; }
    if (same) return;   /* 已经落盘了，不必打扰 */

    var mins = Math.max(0, Math.round((Date.now() - (d.t || 0)) / 60000));
    U.modal({
      title: '发现上次未保存的内容',
      body: '<p class="about-p"><b>' + U.esc(d.path) + '</b></p>' +
        '<p class="about-p">上次离开时这个文件还没写完（约 ' +
        (mins < 1 ? '不到 1 分钟' : mins + ' 分钟') + '前），' +
        '浏览器存储里只留下了这份草稿。</p>' +
        '<p class="about-p">要把它<b>恢复</b>进这个文件吗？' +
        '选「丢弃」则保留当前已保存的版本。</p>',
      actions: [
        { label: '丢弃', primary: true },
        {
          label: '恢复草稿', onClick: function () {
            openPath(d.path).then(function () {
              if (ed.setValue) ed.setValue(d.content);
              U.toast('已恢复草稿，记得保存');
            });
            return true;
          }
        }
      ]
    });
  }

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
      /* 统一身份服务加载完成 + 状态变化时都要刷新。
         ready 是它首次 whoami 的 Promise —— 启动时它可能还没探测完，
         那时 state 还是初始的"未登录"，直接用会闪一下错误状态。 */
      try {
        var SI0 = window.SiteIdentity;
        if (SI0 && SI0.ready && SI0.ready.then) {
          SI0.ready.then(function () { try { UI.refreshCloud(); } catch (e) { } },
                         function () { try { UI.refreshCloud(); } catch (e) { } });
        }
        if (UI.watchIdentity) UI.watchIdentity();
      } catch (e) { }
      restoreDraftIfAny();
      ed.on('change', onChange);
      ed.on('cursor', onCursor);
      ed.on('save', onSaved);
      /* 自动保存失败：状态栏每次都更新，弹窗只弹一次。
         不弹窗的话用户看不见（他在看代码，不在看控制台）；
         每次都弹的话又太吵 —— 他已经知道失败了，再弹是骚扰。 */
      ed.on('save-fail', onAutoSaveFail);
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

  var saveFailShown = false;
  function onAutoSaveFail(err) {
    /* 状态栏：常驻红色，不自动消失 —— 用户随时抬头都能看见 */
    UI.status({ left: '自动保存失败！改动只在内存里，请立刻导出备份', warn: true });
    if (saveFailShown) return;
    saveFailShown = true;
    onSaveFail(err);
  }

  function onSaved(path) {
    /* 成功一次就把失败状态清掉，别让红色警告一直挂着 */
    saveFailShown = false;
    delete dirty[path];
    /* 落盘成功了，同步草稿就没用了 —— 留着会导致下次启动误报"有未保存内容" */
    try { if (ed.onSavedClearDraft) ed.onSavedClearDraft(path); } catch (e) { }
    refreshTabs();
    UI.status({ left: '已保存到本机浏览器 · ' + path });
  }

  function onCursor(c) {
    UI.status({
      pos: '行 ' + c.line + '，列 ' + c.col + (c.sel ? '（选中 ' + c.sel + ' 字符）' : ''),
      size: c.bytes + ' 字节 / ' + c.total + ' 行'
    });
  }

  /* 保存当前文件。返回 Promise，成功/失败如实反映。
     以前返回 undefined —— 调用方无从知道到底存没存上，
     于是"已保存"只能是句祈祷。E-017 的两处谎报（Ctrl+S 与自动保存）
     根子都在这里：下面不给结果，上面就只能瞎说。 */
  function flushAll() {
    var p = ed.current();
    if (!p) return Promise.resolve({ saved: 0 });
    var r;
    try { r = ed.save(); } catch (e) { return Promise.reject(e); }
    /* ed.save() 在没有当前文档时返回 undefined，直接 .then 会抛 */
    return Promise.resolve(r).then(function () { return { saved: 1 }; });
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

  /* ⚠ 三处问题（S-106 / S-107）：
     ① 只 setSelectionRange 不调滚动 —— 在几百行的文件里跳到后面，
        光标过去了但视口不动，用户看不到任何变化，会以为点击没生效；
     ② openPath().then() 没有 .catch —— 打开失败时静默无反馈；
     ③ 自己 U.$('#editor') 拿 textarea，而虚拟键盘走 ed.el().ta、
        编辑器内部走 el.ta —— 同一个 textarea 三种拿法。 */
  function jumpTo(path, line) {
    openPath(path).then(function () {
      if (!(line > 0)) return;
      var ta = (ed.el && ed.el()) ? ed.el().ta : U.$('#editor');
      if (!ta) return;
      var v = ta.value, idx = 0;
      for (var i = 1; i < line && idx >= 0; i++) idx = v.indexOf('\n', idx) + 1;
      if (idx < 0) return;
      ta.focus();
      ta.setSelectionRange(idx, idx);
      /* 让目标行居中：先估算行高，再把 scrollTop 调到目标位置减半屏 */
      try {
        var lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
        var targetLine = line - 1;
        ta.scrollTop = Math.max(0, targetLine * lh - ta.clientHeight / 2 + lh / 2);
      } catch (e) { }
      ed.refresh();
    }).catch(function (e) {
      U.toast('跳转失败：' + ((e && e.message) || e), 'err');
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
    /* 单文件导入的失败也要计入（S-049）：此前它们被静默吞掉，
       界面只显示成功数，用户不会知道有文件没进来。 */
    var fails = 0, allErrs = [];
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
            catch (e) { return fs.importFiles([f]).then(function (r) { singles += r.imported; fails += (r.failed || 0); allErrs = allErrs.concat(r.errors || []); }); }
          });
        }
        return fs.importFiles([f]).then(function (r) { singles += r.imported; fails += (r.failed || 0); allErrs = allErrs.concat(r.errors || []); });
      });
    });

    chain.then(function () {
      refreshTree(); refreshTargets();
      var done = zips + singles;
      if (fails) {
        importFailures = importFailures.concat(allErrs.map(function (x) {
          return { name: x, err: '读取或写入失败' };
        }));
      }

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
  /* ============================================================
   * TLE 预测
   *
   * 为什么需要它：
   *   竞赛里超时（TLE）是最贵的一类错 —— 逻辑全对，只是慢了，
   *   交上去一片红，而本地怎么跑都发现不了。
   *   本环境是解释器，比真实编译器慢几个数量级，
   *   **在这里跑不完 ≠ 你的算法会超时**（很可能只跑了真实 1 毫秒）。
   *   反过来，**在这里跑得飞快也不代表安全** —— 小规模看不出问题。
   *
   *   所以正确的做法是外推：小规模测两点 → 求增长阶数 → 推到目标规模。
   * ============================================================ */
  function runTLEPredict() {
    var cur = ed.current();
    if (!cur) { U.toast('请先打开一个文件'); return; }
    var L = Code.langs ? Code.langs.byPath(cur.path) : null;
    var kind = L && L.runner;
    if (kind !== 'cpplite') {
      U.modal({
        title: 'TLE 预测',
        body: '<p style="margin:0 0 10px">当前文件不是 C++（' + ((L && L.name) || cur.path) + '）。</p>' +
              '<p style="margin:0;color:#9aa4b2">TLE 预测目前只支持 C++（cpplite）。' +
              'Python 侧的等效时间已在每次运行后显示。</p>',
        okText: '知道了'
      });
      return;
    }

    U.modal({
      title: 'TLE 预测（按小规模外推）',
      body: '<p style="margin:0 0 8px;color:#9aa4b2;font-size:12px">' +
            '本环境是解释器，比真实编译器慢几个数量级 —— 在这里跑不完不代表会超时。' +
            '下面用小规模实测增长阶数，外推到你的目标规模。</p>' +
            '<label style="display:block;margin:8px 0 4px">目标规模 n（竞赛常见 1e5 / 1e6）</label>' +
            '<input id="tle-target" type="number" value="100000" style="width:100%;padding:6px">' +
            '<label style="display:block;margin:8px 0 4px">时限（秒，通常为 1）</label>' +
            '<input id="tle-limit" type="number" value="1" step="0.1" style="width:100%;padding:6px">' +
            '<p style="margin:8px 0 0;color:#9aa4b2;font-size:12px">' +
            '假设程序从输入读第一个整数作为规模 n。</p>',
      okText: '开始预测',
      onOk: function () {
        var tn = parseInt((U.$('#tle-target') || {}).value, 10);
        var tl = parseFloat((U.$('#tle-limit') || {}).value);
        if (!isFinite(tn) || tn < 2) tn = 100000;
        if (!isFinite(tl) || tl <= 0) tl = 1;
        doTLEPredict(cur.content, tn, tl);
        return true;
      }
    });
  }

  function doTLEPredict(code, target, limitSec) {
    var r;
    try {
      r = Code.cpplite.predictTLE(code, { target: target, limitSec: limitSec });
    } catch (e) {
      U.modal({ title: 'TLE 预测', body: '<p style="margin:0">' + String(e && e.message || e) + '</p>', okText: '关闭' });
      return;
    }

    var html;
    if (!r.ok) {
      html = '<p style="margin:0 0 8px">无法外推：</p>' +
             '<p style="margin:0;color:#9aa4b2">' + String(r.reason).replace(/\n/g, '<br>') + '</p>';
    } else {
      var verdict = r.willTLE
        ? '<b style="color:#ff6b6b">会 TLE</b> —— 超出时限约 ' + (r.estSec / r.limitSec).toFixed(1) + ' 倍'
        : '<b style="color:#51cf66">可以过</b>';
      html =
        '<p style="margin:0 0 6px">推测复杂度：<b>' + r.complexity + '</b>（实测阶数 k=' + r.k.toFixed(2) + '）</p>' +
        '<p style="margin:0 0 6px">n = ' + r.target.toLocaleString() + ' 时，等效真实 C++ 耗时约 <b>' + r.estText + '</b></p>' +
        '<p style="margin:0 0 6px">结论（时限 ' + r.limitSec + ' 秒）：' + verdict + '</p>' +
        '<p style="margin:0 0 6px;color:#9aa4b2">在该时限下能过的最大规模：n ≈ ' + r.maxN.toLocaleString() + '</p>' +
        '<p style="margin:8px 0 0;color:#9aa4b2;font-size:12px">' +
        '换算依据：实测 cpplite 12 步 ≈ 真实 C++ 1 次迭代，真实 C++ -O2 约 1e8 次迭代/秒。' +
        '换机器不改变数量级结论。</p>';
    }
    U.modal({ title: 'TLE 预测结果', body: html, okText: '关闭' });
  }

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

  /* 只允许 http/https —— 挡掉 javascript: 与 data: 这类伪协议 */
  function safeURL(u) {
    return /^https?:\/\//i.test(String(u || '').trim());
  }
  /* 属性内转义：引号、尖括号、& 都要处理 */
  function escAttr(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function command(name) {
    switch (name) {
      case 'new-file': newFile(); break;
      case 'new-folder': newFolder(); break;
      /* 同一处谎报的第三份拷贝：命令面板里"保存当前文件"走这条路径。
         修了快捷键那一处、修了 editor 那一处，这一处漏了 ——
         用户从命令面板保存时依然会看到假的"已保存"。
         一个谎撒在三处，修两处等于没修。 */
      case 'save':
        Promise.resolve().then(function () { return flushAll(); })
          .then(function (r) {
            if (r && r.failed) { onSaveFail(r.err || new Error('部分文件保存失败')); return; }
            U.toast('已保存');
          })
          .catch(onSaveFail);
        break;
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
      /* 快捷键接过来的这几个（KEYS 表里引用），以前命令面板有、command 里没有 */
      /* 直接调 closePath —— 这里用 hooks.close 是拿不到的：
         hooks 是传给 UI.init 的回调对象，在 command() 的作用域里不存在。
         写成 hooks.close(cp) 时它恒为 undefined，于是走 else 分支，
         而 UI.tabs.closeCurrent 又反过来调 hooks.close —— 死路一条，
         表现为"按 Ctrl+W 毫无反应"。 */
      case 'close-tab': {
        var cp = ed.current();
        if (cp) closePath(cp);
        break;
      }
      /* 搜索框在侧栏的搜索面板里，面板默认隐藏 ——
         直接 focus 一个隐藏元素不会生效（焦点不会过去），
         表现为"按 Ctrl+F 毫无反应"。所以先切到搜索面板再聚焦。 */
      case 'search': {
        try { UI.panel.show && UI.panel.show('search'); } catch (e) { }
        var btn = document.querySelector('[data-view="search"], [data-act="search"]');
        if (btn) btn.click();
        setTimeout(function () {
          var sb = U.$('#search-input');
          if (sb) { try { sb.focus(); sb.select(); } catch (e) { } }
        }, 60);
        break;
      }
      case 'settings': {
        var sg = document.querySelector('[data-act="settings"], [data-view="settings"]');
        if (sg) sg.click();
        break;
      }
      case 'ext': UI.extensions(); break;
      /* TLE 预测：按小规模外推到目标规模，判断会不会超时。
         这是"时间同步"的落地入口 —— 解释器跑不出的规模，
         靠外推告诉用户真实环境会怎样。 */
      case 'tle': runTLEPredict(); break;
      /* 清空本地工程（S-110）：clearAll 此前定义了、导出了，但全仓零调用，
         用户只能一个个删文件；而云盘反倒有「清空云盘」按钮 ——
         本地比云端还没得清。这是危险操作，必须二次确认。 */
      case 'clear-all': {
        U.modal({
          title: '清空本地工程',
          body: '<p style="margin:0 0 8px;color:#ff6b6b"><b>这会删除本地所有文件，且无法撤销。</b></p>' +
                '<p style="margin:0;color:#9aa4b2;font-size:12px">' +
                '云端文件不受影响。建议先「导出全部文件（ZIP）」留一份备份。</p>',
          okText: '确认清空',
          onOk: function () {
            Promise.resolve().then(function () { return Code.fs.clearAll(); })
              .then(function () { tree.render(); U.toast('已清空本地工程'); })
              .catch(function (e) { U.toast('清空失败：' + ((e && e.message) || e), 'err'); });
            return true;
          }
        });
        break;
      }
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
    /* ⚠ 未知命令必须有 default（S-052）。
       此前没有 default：命令名写错、或面板里多出一个没接的条目时，
       点了**毫无反应** —— 用户会以为是界面卡了，而不是功能没接。
       至少要说一句人话。 */
    default:
      if (global.Code.util && global.Code.util.toast) {
        global.Code.util.toast('命令未接入：' + name, 'err');
      }
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
    /* ⚠ 拼进 HTML 前必须转义，且要校验协议（S-050）。
       这是全仓唯一一处把变量拼进 innerHTML 的地方。
       keyURL 来自内置 preset（不是用户输入），所以当前不会真的被利用 ——
       但它是一份"可以这么写"的示范，后来的人照抄就会引入真漏洞。
       两道防线：① 属性转义 ② 只允许 http/https（挡掉 javascript:）。 */
    if (p && p.keyURL && safeURL(p.keyURL)) {
      txt += ' <a href="' + escAttr(p.keyURL) + '" target="_blank" rel="noopener">去拿密钥</a>';
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

    /* 登录/注册**不在 Code 里做** —— 跳全站统一的登录页。
       原因写在 index.html 那段注释里（安全边界不能取决于从哪个入口进）。
       回来时带上 next=当前页，登录完自动回来。
       ⚠ next 由 SiteIdentity.goLogin 内部的白名单校验（只接受同源），
         我们这里不要自己去拼 URL —— 拼了就是开放重定向。 */
    on('#btn-cloud-gologin', 'click', function () {
      var SI = window.SiteIdentity;
      if (SI && SI.goLogin) { SI.goLogin(location.href); return; }
      /* identity.js 没加载出来（离线/脚本挂了）：不能让按钮变成死的，
         如实说明并给出可点的地址 —— 比"点了没反应"强。 */
      U.modal({
        title: '统一登录页没加载出来',
        body: '<p class="about-p">Code 不自己做登录，统一身份服务需要联网才能用。</p>' +
          '<p class="about-p">请检查网络后刷新；或直接打开 ' +
          '<b>liuyiming2024.github.io/login.html</b> 登录，再回到本页。</p>',
        actions: [{ label: '知道了', primary: true }]
      });
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
    /* 真进度条：按字节百分比走，并显示已传 / 总量。
       以前是"传输中 3/10"（文件序号），传一个大文件时数字纹丝不动，
       看起来和卡死没有区别 —— 而用户一旦判定卡死就会刷新，前功尽弃。
       另外进度只写在设置面板的 #cloud-state 里，面板没打开时用户完全看不到，
       所以同时打到状态栏（任何界面下都可见）。
       总字节未知（total=0）时退回文件数，并如实说明"总量未知"。 */
    var progress = function (d) {
      var done = (d && typeof d === 'object') ? d.done : d;
      var total = (d && typeof d === 'object') ? d.total : arguments[1];
      var name = (d && typeof d === 'object') ? d.name : arguments[2];
      var idx = (d && typeof d === 'object') ? d.index : 0;
      var cnt = (d && typeof d === 'object') ? d.count : 0;

      var pct = (total > 0) ? Math.min(100, Math.round(done / total * 100)) : -1;
      var sizeTxt = (total > 0)
        ? fmtBytes(done) + ' / ' + fmtBytes(total) + '（' + pct + '%）'
        : (cnt ? '第 ' + idx + ' / ' + cnt + ' 个（总量未知）' : '');

      var html = '<div class="prog"><div class="prog-bar"' +
        (pct >= 0 ? ' style="width:' + pct + '%"' : '') + '></div></div>' +
        '<div class="prog-txt"><b>' + (pct >= 0 ? pct + '%' : '传输中') + '</b> ' +
        sizeTxt + '<br>' + esc(String(name || '')).slice(0, 60) + '</div>';

      var el = U.$('#cloud-state');
      if (el) el.innerHTML = html;
      var sb = U.$('#st-left');
      if (sb) sb.textContent = '传输中… ' + (pct >= 0 ? pct + '%' : '');
    };

    function fmtBytes(n) {
      n = Number(n) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }
    function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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
                  /* ⚠ 下载完必须刷新树并重载编辑器（S-039）。
                     此前只弹了个 toast —— 文件树还是旧的，
                     编辑器里打开的还是**旧内容**。
                     用户接着打字 → debounce 触发保存 →
                     **刚下载的云端内容被旧内容覆盖**，等于白下载一场，
                     而且毫无提示。这是"会让用户丢东西"的那类错。 */
                  return reloadAfterCloudPull(r);
                })
                .catch(function (e) { U.toast(String(e.message || e), 'err'); });
            }
          }
        ]
      });
    });

    /* 云端下载后：刷新文件树 + 重载当前编辑器的内容。
       不做这一步，用户继续打字会把旧内容回写覆盖刚下载的新内容（S-039）。 */
    function reloadAfterCloudPull(r) {
      var paths = (r && r.paths) || [];
      try {
        if (Code.tree && Code.tree.refresh) Code.tree.refresh();
      } catch (e) { }
      try {
        var cur = Code.editor && Code.editor.current ? Code.editor.current() : null;
        var p = cur && cur.path;
        /* 只重载确实被这次下载覆盖到的文件，避免打断没动过的标签 */
        if (p && (!paths.length || paths.indexOf(p) >= 0)) {
          return Code.fs.read(p).then(function (txt) {
            if (Code.editor && Code.editor.setContent) Code.editor.setContent(p, txt);
          }).catch(function () { });
        }
      } catch (e) { }
      return Promise.resolve();
    }

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
    /* 页眉账号：点了就切到「账号与云盘」视图。
       ⚠ 必须先确保侧栏是展开的 —— 侧栏折叠时切视图没有任何视觉变化，
       用户点了没反应，只会以为按钮坏了。 */
    var ba = U.$('#btn-acct');
    if (ba) ba.onclick = function () {
      if (!Code.cloud) { U.toast('云盘未配置：后端地址缺失', 'err'); return; }
      var side = U.$('#sidebar');
      if (side && side.classList.contains('collapsed')) UI.toggleSide();
      UI.setView('cloud');
      /* 窄屏下抽屉会盖住编辑器，让用户能一键收起 */
      if (UI.isNarrow && UI.isNarrow()) document.body.classList.add('side-open');
    };
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
    /* 快捷键表。
       问题：命令面板有 28 个条目，以前只接了 6 个快捷键 ——
       剩下 22 个只能用鼠标点、或在命令面板里搜。
       对键盘用户来说那 22 个等于不存在：他们不会去点一个要靠鼠标才够得着的入口。
       所以这里把能接的都接上，并让键位在命令面板的 hint 里看得见。 */
    var KEYS = [
      { k: 'p', shift: false, run: function () { UI.palette('file'); } },
      { k: 'p', shift: true, run: function () { UI.palette('cmd'); } },
      { k: 'enter', shift: false, run: function () { doRun(); } },
      { k: '`', shift: false, run: function () { UI.panel.open(!UI.panel.isOpen()); } },
      { k: 'b', shift: false, run: function () { UI.toggleSide(); } },
      /* 以下为新增：命令面板里有、却没有键位的那些 */
      { k: 'n', shift: false, run: function () { command('new-file'); } },
      { k: 'n', shift: true, run: function () { command('new-folder'); } },
      { k: 'o', shift: false, run: function () { command('import'); } },
      { k: 'e', shift: false, run: function () { command('export'); } },
      { k: 'w', shift: false, run: function () { command('close-tab'); } },
      { k: ',', shift: false, run: function () { command('settings'); } },
      { k: 'g', shift: false, run: function () { command('theme'); } },
      { k: 'd', shift: false, run: function () { command('ext'); } },
      /* 不用 Ctrl+/ —— 那是编辑器的"切换行注释"，两条命令抢一个键时
         注释会赢（绑在 textarea 上，先收到事件），搜索命令永远触发不了。
         Ctrl+F 是查找的事实标准，浏览器页面查找在这里让位给文件内查找。 */
      { k: 'f', shift: false, run: function () { command('search'); } }
    ];

    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      var k = e.key.toLowerCase();

      /* Alt + 数字：切到第 N 个标签。
         不用 Ctrl+数字 —— 那被浏览器占去跳标签页了。 */
      if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        if (UI.tabs && UI.tabs.pick) UI.tabs.pick(parseInt(e.key, 10) - 1);
        return;
      }

      /* Ctrl+Tab / Ctrl+Shift+Tab：左右切标签。
         浏览器会抢这两个键，但在编辑器里"切文件"优先于"切浏览器标签页"，
         所以拦下来。 */
      if (mod && e.key === 'Tab') {
        e.preventDefault();
        if (UI.tabs && UI.tabs.cycle) UI.tabs.cycle(e.shiftKey ? -1 : 1);
        return;
      }

      if (!mod) return;

      /* E-017：这里以前是 flushAll(); U.toast('已保存') —— 无条件、不接 promise。
         上一轮我只修了 editor.js 里的同一处，漏了这个：
         同一个谎撒在两个地方，修一个等于没修。
         IndexedDB 写失败（配额满、隐私模式）时用户依然看到"已保存"，
         然后关标签页 —— 数据就这么没了。 */
      if (k === 's') {
        e.preventDefault();
        Promise.resolve().then(function () { return flushAll(); })
          .then(function (r) {
            if (r && r.failed) { onSaveFail(r.err || new Error('部分文件保存失败')); return; }
            U.toast('已保存');
          })
          .catch(onSaveFail);
        return;
      }

      for (var i = 0; i < KEYS.length; i++) {
        var it = KEYS[i];
        if (it.k === k && !!it.shift === !!e.shiftKey) {
          e.preventDefault();
          try { it.run(); } catch (err) { }
          return;
        }
      }
    });

    /* ===== 离开前保存 =====
     *
     * ⚠ 只写 beforeunload 是不够的，三条理由：
     *   1. 它调的 idb.put() 是异步的，处理器一返回浏览器就卸载，事务来不及提交；
     *   2. iOS Safari 基本不触发 beforeunload —— 移动端等于没有钩子；
     *   3. 手机上最常见的是"切到别的 App 再回来"，只有 visibilitychange 抓得到。
     *
     * 所以：三个事件都接，且每个都**先同步写 localStorage 草稿**
     * （同步 API，卸载路径里一定能写完），异步那条照跑、成功更好。
     */
    function leaveSave() {
      try { if (ed.saveDraftSync) ed.saveDraftSync(); } catch (e) { }
      try { flushAll().catch(function (e) { if (onSaveFail) onSaveFail(e); }); } catch (e) { }
    }
    global.addEventListener('beforeunload', leaveSave);
    /* pagehide：iOS Safari 唯一可靠的卸载信号 */
    global.addEventListener('pagehide', leaveSave);
    /* visibilitychange：切后台/切 App。手机上这是最常见的"离开"方式 */
    global.document.addEventListener('visibilitychange', function () {
      if (global.document.visibilityState === 'hidden') leaveSave();
    });
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
