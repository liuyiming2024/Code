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
      ed.on('change', onChange);
      ed.on('cursor', onCursor);
      ed.on('save', onSaved);
      UI.setView(prefs.sideView || 'files');
      refreshTree();
      refreshTargets();
      applySettingsToUI(prefs);

      var last = prefs.lastPath;
      var files = fs.list().filter(function (r) { return r.type === 'file'; });
      var start = (last && fs.exists(last)) ? last
        : (files.length ? files[0].path : null);
      if (start) openPath(start);
      else UI.status({ left: '空工程 —— 用左侧「新建文件」开始' });

      booted = true;
      runner.printSys('Code 已就绪。文件存在本机浏览器，代码在本机执行。');
    }).catch(function (err) {
      booted = true;
      U.toast('初始化失败：' + err.message, 'err');
      U.$('#st-left').textContent = '初始化失败：' + err.message;
    });
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
  function flushDirty() {
    clearTimeout(saveTimer);
    var p = ed.current();
    if (!p) return;
    ed.save().then(function () { })
      .catch(function (err) {
        /* 保存失败必须让人看见：否则用户以为存住了，关掉页面才发现没了 */
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
      });
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
            if (UI.tabs.list().indexOf(path) >= 0) closePath(path);
            fs.remove(path).then(function () { U.toast('已删除 ' + path); })
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
    U.download('code-workspace.zip', blob);
    U.toast('已导出 ' + fs.list().length + ' 项');
  }

  function doImport() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = '.zip,.json,.*';
    inp.onchange = function () {
      var files = Array.prototype.slice.call(inp.files || []);
      if (!files.length) return;
      var chain = Promise.resolve(), zips = 0, singles = 0;
      files.forEach(function (f) {
        chain = chain.then(function () {
          if (/\.zip$/i.test(f.name)) {
            return U.readFileAsArrayBuffer(f).then(fs.importZip).then(function (n) { zips += n; });
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
        var msg = [];
        if (zips) msg.push(zips + ' 个来自压缩包');
        if (singles) msg.push(singles + ' 个文件');
        U.toast('导入完成：' + (msg.join('，') || '0 项'));
      }).catch(function (e) { U.toast('导入失败：' + e.message, 'err'); });
    };
    inp.click();
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
      Code.ai.chat([{ role: 'user', content: '回复两个字：可用' }], { timeout: 30000 })
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
      '#set-ws': p.showWS ? 'on' : 'off',
      '#set-sync': p.syncEnabled ? 'on' : 'off',
      '#set-sync-url': p.syncUrl, '#set-sync-key': p.syncKey
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
    on('#set-sync', 'change', function () {
      /* 未实现前不允许打开：能填能开却无反馈，会让用户以为上云了从而不再备份 */
      this.value = 'off';
      store.set('syncEnabled', false);
      U.toast('云端同步尚未实现，当前版本不会同步任何数据', 'err');
    });
    ['#set-sync-url', '#set-sync-key'].forEach(function (s) {
      on(s, 'change', function () {
        store.set(s === '#set-sync-url' ? 'syncUrl' : 'syncKey', this.value);
      });
    });
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

  /* ================= 绑定 ================= */
  function bind() {
    /* 顶栏菜单 */
    U.$$('#top-menu [data-act]').forEach(function (b) {
      b.onclick = function () {
        var a = b.getAttribute('data-act');
        if (a === 'about') UI.about();
        else if (a === 'extensions') UI.extensions();
        else command(a);
      };
    });
    var br = U.$('#btn-run'); if (br) br.onclick = doRun;
    var bt = U.$('#btn-theme'); if (bt) bt.onclick = toggleTheme;
    var bm = U.$('#btn-menu');
    if (bm) bm.onclick = function () { UI.toggleSide(); };

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
    var pc = U.$('#btn-panel-clear'); if (pc) pc.onclick = function () { runner.clear(); };
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

  Code.app = { boot: boot, run: doRun, open: openPath, exportZip: doExport, importPick: doImport };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
