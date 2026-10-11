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
        var dot = U.el('span', { class: 'tdot' });
        dot.appendChild(U.svg('i-dot', 9));
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
      ['output', 'console'].forEach(function (n) {
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
          var ic = U.el('span', { class: 'pal-icon' });
          if (it.icon) ic.appendChild(U.svg(it.icon, 14));
          d.appendChild(ic);
          d.appendChild(U.el('span', { class: 'pal-cmd', text: label }));
          d.appendChild(U.el('span', { class: 'pal-key', text: it.hint || '' }));
        } else {
          var ic2 = U.el('span', { class: 'pal-icon' });
          ic2.appendChild(U.svg('i-file', 14));
          d.appendChild(ic2);
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
      { label: '新建文件', hint: '', icon: 'i-plus', act: function () { hooks.cmd && hooks.cmd('new-file'); } },
      { label: '新建文件夹', hint: '', icon: 'i-folder-plus', act: function () { hooks.cmd && hooks.cmd('new-folder'); } },
      { label: '保存当前文件', hint: 'Ctrl+S', icon: 'i-save', act: function () { hooks.cmd && hooks.cmd('save'); } },
      { label: '运行当前文件', hint: 'Ctrl+Enter', icon: 'i-run', act: function () { hooks.cmd && hooks.cmd('run'); } },
      { label: '导出全部文件（ZIP）', hint: '', icon: 'i-download', act: function () { hooks.cmd && hooks.cmd('export'); } },
      { label: '导入文件或 ZIP', hint: '', icon: 'i-upload', act: function () { hooks.cmd && hooks.cmd('import'); } },
      { label: '切换深浅主题', hint: '', icon: 'i-sun', act: function () { hooks.cmd && hooks.cmd('theme'); } },
      { label: '显示 / 隐藏底部面板', hint: 'Ctrl+`', icon: 'i-split', act: function () { hooks.cmd && hooks.cmd('panel'); } },
      { label: '清空运行输出', hint: '', icon: 'i-eraser', act: function () { hooks.cmd && hooks.cmd('clear'); } },
      { label: '扩展中心（下载运行时）', hint: '', icon: 'i-download', act: function () { UI.extensions(); } },
      /* 没配密钥就不渲染 AI 入口 —— 渲染了点下去报错是误导 */
      (Code.ai && Code.ai.ready()
        ? { label: 'AI 解释选中代码', hint: '', icon: 'i-info', act: function () { UI.aiAsk('explain'); } }
        : null),
      (Code.ai && Code.ai.ready()
        ? { label: 'AI 改写选中代码', hint: '', icon: 'i-return', act: function () { UI.aiAsk('rewrite'); } }
        : null),
      (Code.ai && !Code.ai.ready()
        ? { label: '配置 AI 密钥（当前未启用）', hint: '', icon: 'i-key', act: function () { UI.openSettings('ai'); } }
        : null),
      { label: '关于 Code', hint: '', icon: 'i-info', act: function () { UI.about(); } }
    ];
    return out.filter(Boolean);
  }

  /* 打开设置并滚到 AI 区块 */
  UI.openSettings = function (which) {
    var btn = document.querySelector('[data-act="settings"], [data-view="settings"]');
    if (btn) btn.click();
    var target = which === 'ai' ? U.$('#set-ai-enabled') : null;
    if (target) {
      setTimeout(function () {
        try { target.scrollIntoView({ block: 'center' }); } catch (e) { }
        target.focus();
      }, 60);
    }
  };

  UI.about = function () {
    U.modal({
      title: '关于 Code',
      body: '<p class="about-p">Code 是一个完全在浏览器里运行的代码编辑器：文件存本地、代码在本地执行，' +
        '不经过任何服务器。</p>' +
        '<ul class="about-ul">' +
        '<li>文件：浏览器 IndexedDB 虚拟文件系统，可导出 / 导入 ZIP</li>' +
        '<li>内置可跑：JavaScript、HTML、Python 子集、C/C++ 子集（自研，零依赖）</li>' +
        '<li>按需下载：SQLite / Lua / Ruby / PHP / 完整 CPython / 真 Clang，见扩展中心</li>' +
        '<li>主题、字号、缩进等设置保存在本地</li>' +
        '</ul>' +
        '<p class="about-p">键盘：Ctrl+P 跳转文件，Ctrl+Shift+P 命令面板，Ctrl+Enter 运行，Ctrl+S 保存。</p>' +
        '<p class="about-p">你的代码与文件只存在这台设备上，不上传任何服务器；' +
        '除了在扩展中心主动下载运行时，页面不发起任何网络请求。</p>' +
        '<p class="about-p">' +
        '<a href="PRIVACY.md" target="_blank" rel="noopener">隐私声明</a> · ' +
        '<a href="TERMS.md" target="_blank" rel="noopener">使用条款</a> · ' +
        '<a href="LICENSE" target="_blank" rel="noopener">许可证</a>' +
        '</p>',
      actions: [{ label: '知道了', primary: true }]
    });
  };


  /* ================= 扩展中心 =================
     用户主动下载运行时。这里必须如实交代三件事：
       1. 每个包多大
       2. 首次下载需要联网
       3. 下载后存在本机，之后离线可用
     做不到就是做不到，不在这里给人"点了就能跑"的错觉。 */
  UI.extensions = function () {
    var L = Code.langs, R = Code.runtime;
    if (!L || !R) {
      U.modal({ title: '扩展中心', body: '<p class="about-p">语言模块未加载，无法列出扩展。</p>', actions: [{ label: '知道了', primary: true }] });
      return;
    }
    var close = U.modal({
      title: '扩展中心',
      body: '<p class="about-p">这些是可选的运行时扩展。基础功能（JavaScript、HTML、Python 子集、C/C++ 子集）' +
        '不需要下载，已经能直接用。</p>' +
        '<p class="about-p ext-note">下载的东西存进<b>你自己浏览器</b>的缓存里，不上传任何服务器。' +
        '<b>首次下载需要联网</b>，下完之后离线也能用。</p>' +
        '<div id="ext-list" class="ext-list"></div>',
      actions: [{ label: '关闭', primary: true }]
    });

    var list = U.$('#ext-list');
    if (!list) return;
    render();

    function render() {
      list.innerHTML = '';
      L.downloadable().forEach(function (lang) {
        var id = lang.wasm.id;
        var rt = R.findRt ? R.findRt(id) : null;
        var st = R.status(id);
        var bytes = 0;
        if (rt && rt.files) rt.files.forEach(function (f) { bytes += f.size || 0; });

        var row = U.el('div', { class: 'ext-row' });

        var head = U.el('div', { class: 'ext-head' });
        var nm = U.el('div', { class: 'ext-name', text: lang.name });
        head.appendChild(nm);
        if (lang.wasm.upgrade) {
          head.appendChild(U.el('span', { class: 'ext-tag', text: '升级' }));
        }
        head.appendChild(U.el('span', { class: 'ext-size', text: L.fmtSize(bytes) }));
        row.appendChild(head);

        var d = U.el('div', { class: 'ext-desc', text: (lang.wasm && lang.wasm.desc) || lang.desc || '' });
        row.appendChild(d);

        var bar = U.el('div', { class: 'ext-bar' });
        var state = U.el('span', { class: 'ext-state' });
        var btn = U.el('button', { class: 'btn small' });

        if (st && st.ready) {
          state.textContent = '已下载（本机缓存，离线可用）';
          state.className = 'ext-state ok';
          btn.textContent = '清理';
          btn.onclick = function () {
            R.clearCache(id).then(function () { render(); });
          };
        } else if (st && st.error) {
          state.textContent = '下载失败：' + st.error;
          state.className = 'ext-state bad';
          btn.textContent = '重试';
          btn.onclick = function () { start(id); };
        } else {
          state.textContent = '未下载';
          btn.textContent = '下载';
          btn.onclick = function () { start(id); };
        }
        bar.appendChild(state);
        bar.appendChild(btn);
        row.appendChild(bar);

        var pct = U.el('div', { class: 'ext-prog hidden' });
        var fill = U.el('i');
        pct.appendChild(fill);
        row.appendChild(pct);

        row.__prog = pct; row.__fill = fill; row.__state = state;
        list.appendChild(row);
      });
    }

    var RT_KEY = { sqlite: 'sql', pyodide: 'python', lua: 'lua', php: 'php', ruby: 'ruby', cpp: 'cpp' };

    /* 启动时探一次缓存状态，界面才知道谁已下载 */
    function refresh() {
      if (R && R.refreshStatus) R.refreshStatus();
    }

    function start(id) {
      var key = RT_KEY[id] || id;
      var rows0 = list.querySelectorAll('.ext-row');
      var row = null;
      L.downloadable().forEach(function (l, i) { if (l.wasm.id === id) row = rows0[i]; });
      if (!row) return;
      row.classList.add('busy');
      row.__prog.classList.remove('hidden');
      row.__state.className = 'ext-state';
      row.__state.textContent = '下载中，请保持联网…';

      if (Code.runtimes && Code.runtimes.prepare) {
        Code.runtimes.prepare(key, {
          begin: function () { row.__state.textContent = '开始下载…'; },
          progress: function (d) {
            if (d && d.pct != null) {
              row.__fill.style.width = d.pct + '%';
              row.__state.textContent = '下载中 ' + d.pct + '%' + (d.file ? '（' + d.file + '）' : '');
            }
          },
          ready: function () { row.classList.remove('busy'); refresh(); render(); },
          fail: function (d) {
            row.classList.remove('busy');
            row.__state.textContent = '下载失败：' + ((d && d.error) || '未知');
            row.__state.className = 'ext-state bad';
          }
        });
        return;
      }
      /* runtimes.js 不在时的退路 —— 如实报出来，不静默失败 */
      row.classList.remove('busy');
      row.__state.textContent = '运行时管理模块未加载（js/runtimes.js），无法下载';
      row.__state.className = 'ext-state bad';
    }
  };

  /* ================= AI 问答 =================
     结果只显示在面板上，不回写文件——改代码要用户自己确认再粘贴。 */
  UI.aiAsk = function (mode) {
    if (!Code.ai || !Code.ai.ready()) {
      U.modal({
        title: 'AI 尚未启用',
        body: '<p class="about-p">请先在设置里填入密钥并开启。密钥只存在这台设备上。</p>',
        actions: [{ label: '知道了', primary: true }]
      });
      return;
    }
    var sel = '';
    try {
      var ed = Code.editor;
      if (ed && ed.sel) {
        var r = ed.sel();
        var v = ed.value ? ed.value() : '';
        sel = (r[1] > r[0]) ? v.slice(r[0], r[1]) : '';
      }
    } catch (e) { sel = ''; }
    if (!sel) {
      U.modal({
        title: mode === 'explain' ? 'AI 解释代码' : 'AI 改写代码',
        body: '<p class="about-p">请先选中一段代码，再执行此命令。</p>',
        actions: [{ label: '知道了', primary: true }]
      });
      return;
    }

    var lang = '';
    try { lang = U.langOf(Code.editor.path()) || ''; } catch (e) { }

    var body =
      '<div class="ai-src"><pre>' + esc(sel.slice(0, 4000)) + '</pre></div>' +
      (mode === 'rewrite'
        ? '<div class="field"><input id="ai-instr" type="text" placeholder="改成什么样？例如：用 for 循环重写" autocomplete="off"></div>'
        : '') +
      '<div class="ai-out"><pre id="ai-result">（等待回复…）</pre></div>';

    U.modal({
      title: mode === 'explain' ? 'AI 解释代码' : 'AI 改写代码',
      body: body,
      actions: [
        { label: '关闭' },
        {
          label: '发送', primary: true, onClick: function () {
            var out = U.$('#ai-result');
            if (!out) return;
            out.textContent = '（请求中…）';
            var p;
            if (mode === 'rewrite') {
              var instr = (U.$('#ai-instr') || {}).value || '优化这段代码';
              p = Code.ai.rewrite(sel, instr, lang);
            } else {
              p = Code.ai.explain(sel, lang);
            }
            p.then(function (r) {
              out.textContent = r.text || '（返回为空）';
            }).catch(function (e) {
              out.textContent = '失败：' + String(e && e.message || e);
            });
            return false;   /* 不关对话框，让结果留在屏幕上 */
          }
        }
      ]
    });
    /* 打开后自动发一次解释（改写要等用户填要求） */
    if (mode === 'explain') {
      setTimeout(function () {
        var btn = document.querySelector('.modal .btn-primary');
        if (btn) btn.click();
      }, 30);
    }
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

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
