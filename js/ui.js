/* 界面层：标签栏、状态栏、底部面板、侧栏切换、主题、命令面板 */
(function () {
  var Code = window.Code = window.Code || {};
  var U = Code.util;

  var UI = {};
  var hooks = {};
  var tabs = [];      /* 打开的文件路径，顺序即显示顺序 */
  var active = null;

  /* ================= 标签栏 ================= */
  UI.tabs = {
    list: function () { return tabs.slice(); },
    current: function () { return active; },
    add: function (path) {
      if (tabs.indexOf(path) < 0) tabs.push(path);
      active = path;
      UI.tabs.render();
    },
    close: function (path) {
      var i = tabs.indexOf(path);
      if (i < 0) return;
      tabs.splice(i, 1);
      if (active === path) active = tabs.length ? tabs[Math.min(i, tabs.length - 1)] : null;
      UI.tabs.render();
    },
    closeOthers: function (path) { tabs = [path]; active = path; UI.tabs.render(); },
    select: function (path) {
      if (tabs.indexOf(path) < 0) tabs.push(path);
      active = path; UI.tabs.render();
    },
    render: function () {
      var bar = U.$('#tabsbar');
      bar.innerHTML = '';
      tabs.forEach(function (p) {
        var t = U.el('div', { class: 'tab' + (p === active ? ' active' : '') });
        var name = U.el('span', { class: 'tname', text: U.basename(p) });
        name.title = p;
        var dot = U.el('span', { class: 'tdot', text: '●' });
        var x = U.el('button', { class: 'tclose', title: '关闭' });
        x.appendChild(U.svg('i-close', 12));
        t.appendChild(name); t.appendChild(dot); t.appendChild(x);
        t.onclick = function (e) {
          if (e.target.closest('.tclose')) { hooks.close && hooks.close(p); return; }
          if (p !== active) { active = p; UI.tabs.render(); hooks.select && hooks.select(p); }
        };
        t.onmousedown = function (e) {
          if (e.button === 1) { e.preventDefault(); hooks.close && hooks.close(p); }
        };
        t.oncontextmenu = function (e) {
          e.preventDefault();
          U.menu(e.clientX, e.clientY, [
            { label: '关闭', act: function () { hooks.close && hooks.close(p); } },
            { label: '关闭其他', act: function () { UI.tabs.closeOthers(p); hooks.closeOthers && hooks.closeOthers(p); } },
            { label: '复制路径', act: function () { UI.copy(p); } }
          ]);
        };
        bar.appendChild(t);
      });
    }
  };

  UI.setDirty = function (path, dirty) {
    var i = tabs.indexOf(path);
    var el = U.$('#tabsbar').children[i];
    if (el) el.classList.toggle('dirty', !!dirty);
  };

  /* ================= 侧栏 ================= */
  UI.setView = function (name) {
    ['files', 'search', 'run', 'settings'].forEach(function (v) {
      var e = U.$('#view-' + v);
      if (e) e.classList.toggle('hidden', v !== name);
    });
    U.$$('#activitybar [data-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === name);
    });
    var t = U.$('#side-title');
    var names = { files: '文件', search: '搜索', run: '运行', settings: '设置' };
    t.textContent = names[name] || '';
    U.$('#side-actions').classList.toggle('hidden', name !== 'files');
    if (name === 'search') setTimeout(function () { var s = U.$('#search-input'); s && s.focus(); }, 0);
  };

  UI.toggleSide = function () {
    var side = U.$('#sidebar');
    var off = side.classList.toggle('collapsed');
    U.$('#activitybar').classList.toggle('nobar', false);
    return off;
  };

  /* ================= 底部面板 ================= */
  UI.panel = {
    name: 'output',
    show: function (name) {
      UI.panel.name = name;
      U.$$('#panel .pt').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-panel') === name);
      });
      ['output', 'problems', 'console'].forEach(function (n) {
        U.$('#panel-' + n).classList.toggle('hidden', n !== name);
      });
      if (name === 'console') setTimeout(function () { var i = U.$('#console-input'); i && i.focus(); }, 0);
    },
    open: function (yes) {
      U.$('#panel').classList.toggle('collapsed', !yes);
      U.$('#resizer').classList.toggle('hidden', !yes);
    },
    isOpen: function () { return !U.$('#panel').classList.contains('collapsed'); },
    setHeight: function (h) {
      h = Math.max(90, Math.min(innerHeight - 160, h | 0));
      U.$('#panel').style.height = h + 'px';
      return h;
    }
  };

  /* ================= 状态栏 ================= */
  UI.status = function (opt) {
    if (opt.pos != null) U.$('#st-pos').textContent = opt.pos;
    if (opt.lang != null) U.$('#st-lang').textContent = opt.lang;
    if (opt.size != null) U.$('#st-size').textContent = opt.size;
    if (opt.mode != null) U.$('#st-mode').textContent = opt.mode;
    if (opt.left != null) U.$('#st-left').textContent = opt.left;
  };

  /* ================= 主题 ================= */
  UI.applyTheme = function (theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var b = U.$('#btn-theme');
    if (b) {
      b.innerHTML = '';
      b.appendChild(U.svg(theme === 'light' ? 'i-moon' : 'i-sun', 16));
      b.title = theme === 'light' ? '切换为深色' : '切换为浅色';
    }
  };

  UI.applyPrefs = function (p) {
    document.documentElement.style.setProperty('--font-size', p.fontSize + 'px');
    UI.applyTheme(p.theme);
    UI.panel.open(!!p.panelOpen);
    if (p.panelHeight) UI.panel.setHeight(p.panelHeight);
    if (p.sideWidth) U.$('#sidebar').style.width = p.sideWidth + 'px';
  };

  /* ================= 复制 ================= */
  UI.copy = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { U.toast('已复制'); },
        function () { UI.copyFallback(text); });
    } else UI.copyFallback(text);
  };
  UI.copyFallback = function (text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); U.toast('已复制'); }
    catch (e) { U.toast('复制失败', 'err'); }
    ta.remove();
  };

  /* ================= 快速跳转 / 命令面板 ================= */
  UI.palette = function (mode) {
    var files = Code.fs.list();
    if (!files.length) { U.toast('还没有文件'); return; }
    var body = '<input id="pal-q" class="pal-input" placeholder="' +
      (mode === 'cmd' ? '输入命令，如：新建文件 / 切换主题 / 导出' : '输入文件名片段') + '" />' +
      '<div id="pal-list" class="pal-list"></div>';
    var close = U.modal({ title: mode === 'cmd' ? '命令面板' : '跳转文件', body: body, actions: [] });
    var q = U.$('#pal-q'), list = U.$('#pal-list');
    var items = mode === 'cmd' ? cmdItems() : files.slice().sort();
    var sel = 0;

    function render() {
      var kw = q.value.trim().toLowerCase();
      var hit = items.filter(function (it) {
        var s = (mode === 'cmd' ? it.label : it).toLowerCase();
        if (!kw) return true;
        if (mode === 'cmd') return s.indexOf(kw) >= 0;
        /* 模糊匹配：按顺序包含各字符 */
        var i = 0;
        for (var j = 0; j < s.length && i < kw.length; j++) if (s[j] === kw[i]) i++;
        return i === kw.length;
      }).slice(0, 60);
      sel = Math.min(sel, Math.max(0, hit.length - 1));
      list.innerHTML = '';
      hit.forEach(function (it, idx) {
        var label = mode === 'cmd' ? it.label : it;
        var d = U.el('div', { class: 'pal-item' + (idx === sel ? ' sel' : '') });
        if (mode === 'cmd') {
          d.appendChild(U.el('span', { class: 'pal-cmd', text: label }));
          d.appendChild(U.el('span', { class: 'pal-key', text: it.hint || '' }));
        } else {
          d.appendChild(U.el('span', { class: 'pal-cmd', text: U.basename(label) }));
          d.appendChild(U.el('span', { class: 'pal-key', text: label }));
        }
        d.onmouseenter = function () { sel = idx; mark(); };
        d.onclick = function () { go(hit[sel]); };
        list.appendChild(d);
      });
      if (!hit.length) list.appendChild(U.el('div', { class: 'pal-empty', text: '无匹配' }));
    }
    function mark() {
      U.$$('#pal-list .pal-item').forEach(function (e, i) { e.classList.toggle('sel', i === sel); });
      var s = U.$$('#pal-list .pal-item')[sel];
      if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
    }
    function go(it) {
      close();
      if (!it) return;
      if (mode === 'cmd') it.act();
      else hooks.open && hooks.open(it);
    }
    q.oninput = function () { sel = 0; render(); };
    q.onkeydown = function (e) {
      var n = U.$$('#pal-list .pal-item').length;
      if (e.key === 'ArrowDown') { sel = (sel + 1) % Math.max(1, n); mark(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = (sel - 1 + n) % Math.max(1, n); mark(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(pick()); }
      else if (e.key === 'Escape') close();
    };
    function pick() {
      var kw = q.value.trim().toLowerCase();
      var hit = items.filter(function (it) {
        var s = (mode === 'cmd' ? it.label : it).toLowerCase();
        if (!kw) return true;
        if (mode === 'cmd') return s.indexOf(kw) >= 0;
        var i = 0;
        for (var j = 0; j < s.length && i < kw.length; j++) if (s[j] === kw[i]) i++;
        return i === kw.length;
      }).slice(0, 60);
      return hit[sel];
    }
    render();
  };

  function cmdItems() {
    var out = [
      { label: '新建文件', hint: '', act: function () { hooks.cmd && hooks.cmd('new-file'); } },
      { label: '新建文件夹', hint: '', act: function () { hooks.cmd && hooks.cmd('new-folder'); } },
      { label: '保存当前文件', hint: 'Ctrl+S', act: function () { hooks.cmd && hooks.cmd('save'); } },
      { label: '运行当前文件', hint: 'Ctrl+Enter', act: function () { hooks.cmd && hooks.cmd('run'); } },
      { label: '导出全部文件（ZIP）', hint: '', act: function () { hooks.cmd && hooks.cmd('export'); } },
      { label: '导入文件或 ZIP', hint: '', act: function () { hooks.cmd && hooks.cmd('import'); } },
      { label: '切换深浅主题', hint: '', act: function () { hooks.cmd && hooks.cmd('theme'); } },
      { label: '显示 / 隐藏底部面板', hint: 'Ctrl+`', act: function () { hooks.cmd && hooks.cmd('panel'); } },
      { label: '清空运行输出', hint: '', act: function () { hooks.cmd && hooks.cmd('clear'); } },
      { label: '关于 Code', hint: '', act: function () { UI.about(); } }
    ];
    return out;
  }

  UI.about = function () {
    U.modal({
      title: '关于 Code',
      body: '<p class="about-p">Code 是一个完全在浏览器里运行的代码编辑器：文件存本地、代码在本地执行，' +
        '不经过任何服务器。</p>' +
        '<ul class="about-ul">' +
        '<li>文件：浏览器 IndexedDB 虚拟文件系统，可导出 / 导入 ZIP</li>' +
        '<li>运行：JavaScript 与 HTML 由浏览器原生执行</li>' +
        '<li>未内置：Python / C++ 运行时暂未提供，运行面板会如实提示</li>' +
        '<li>主题、字号、缩进等设置保存在本地</li>' +
        '</ul>' +
        '<p class="about-p">键盘：Ctrl+P 跳转文件，Ctrl+Shift+P 命令面板，Ctrl+Enter 运行，Ctrl+S 保存。</p>',
      actions: [{ label: '知道了', primary: true }]
    });
  };

  /* ================= 初始化 ================= */
  UI.init = function (h) {
    hooks = h || {};

    /* 活动栏 */
    U.$$('#activitybar [data-view]').forEach(function (b) {
      b.onclick = function () {
        UI.toggleSideForce(false);
        UI.setView(b.getAttribute('data-view'));
        Code.store.set('sideView', b.getAttribute('data-view'));
      };
    });

    /* 面板切换 */
    U.$$('#panel .pt').forEach(function (b) {
      b.onclick = function () { UI.panel.show(b.getAttribute('data-panel')); };
    });

    /* 面板拖动 */
    var rz = U.$('#resizer'), dragging = false, y0 = 0, h0 = 0;
    rz.addEventListener('mousedown', function (e) {
      dragging = true; y0 = e.clientY; h0 = U.$('#panel').offsetHeight;
      document.body.style.userSelect = 'none';
    });
    addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var h = UI.panel.setHeight(h0 - (e.clientY - y0));
      Code.store.set('panelHeight', h);
    });
    addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
    });

    /* 侧栏宽度拖动 */
    var sw = U.$('#side-resizer');
    if (sw) {
      var sd = false, x0 = 0, w0 = 0;
      sw.addEventListener('mousedown', function (e) {
        sd = true; x0 = e.clientX; w0 = U.$('#sidebar').offsetWidth;
        document.body.style.userSelect = 'none';
      });
      addEventListener('mousemove', function (e) {
        if (!sd) return;
        var w = Math.max(150, Math.min(520, w0 + (e.clientX - x0)));
        U.$('#sidebar').style.width = w + 'px';
        Code.store.set('sideWidth', w);
      });
      addEventListener('mouseup', function () { sd = false; document.body.style.userSelect = ''; });
    }

    UI.panel.show('output');
    UI.tabs.render();
  };

  UI.toggleSideForce = function (hidden) {
    U.$('#sidebar').classList.toggle('collapsed', !!hidden);
  };
  UI.sideCollapsed = function () { return U.$('#sidebar').classList.contains('collapsed'); };

  Code.ui = UI;
})();
