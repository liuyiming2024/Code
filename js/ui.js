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
    /* E-039：把标签列表与激活项存起来，刷新后恢复。
       存的是路径不是内容 —— 内容本来就在 IndexedDB 里，恢复时再读。 */
    persist: function () {
      try {
        if (!Code.store) return;
        Code.store.set('openTabs', tabs.slice());
        Code.store.set('activeTab', active || '');
      } catch (e) { }
    },
    /* 启动时调用：恢复上次的标签。
       文件可能已被删（在别的会话里），所以要逐个核对存在性，
       不存在的静默跳过 —— 恢复不出一个标签不值得弹错误打断启动。 */
    restore: function (paths) {
      try {
        if (!Code.store) return null;
        var saved = Code.store.prefs.openTabs || [];
        var act = Code.store.prefs.activeTab || '';
        var got = 0;
        saved.forEach(function (p) {
          if (typeof p !== 'string' || !p) return;
          if (paths) {
            var ok = false;
            for (var i = 0; i < paths.length; i++) { if (paths[i] === p) { ok = true; break; } }
            if (!ok) return;
          }
          if (tabs.indexOf(p) < 0) { tabs.push(p); got++; }
        });
        if (!got) return null;
        active = (tabs.indexOf(act) >= 0) ? act : tabs[tabs.length - 1];
        UI.tabs.render();
        return active;
      } catch (e) { return null; }
    },
    add: function (path) {
      if (tabs.indexOf(path) < 0) tabs.push(path);
      active = path;
      UI.tabs.render(); UI.tabs.persist();
    },
    close: function (path) {
      var i = tabs.indexOf(path);
      if (i < 0) return;
      tabs.splice(i, 1);
      if (active === path) active = tabs.length ? tabs[Math.min(i, tabs.length - 1)] : null;
      UI.tabs.render(); UI.tabs.persist();
    },
    closeOthers: function (path) { tabs = [path]; active = path; UI.tabs.render(); UI.tabs.persist(); },
    /* 按序号切到第 N 个标签（Alt+1..9）。越界就忽略 ——
       按 Alt+9 但只开了 3 个标签时什么都不做，比跳到最后一个更不容易误操作。 */
    pick: function (i) {
      if (typeof i !== 'number' || i < 0 || i >= tabs.length) return;
      var p = tabs[i];
      if (p === active) return;
      active = p;
      UI.tabs.render();
      UI.tabs.persist();
      hooks.select && hooks.select(p);
    },
    /* 相对切换：Ctrl+Tab 向后、Ctrl+Shift+Tab 向前，到头回绕。
       回绕而不是停住 —— 只有两三个标签时，"到头就停"会让人以为坏了。 */
    cycle: function (dir) {
      if (!tabs.length) return;
      var i = tabs.indexOf(active);
      if (i < 0) i = 0;
      var n = (i + (dir > 0 ? 1 : -1) + tabs.length) % tabs.length;
      UI.tabs.pick(n);
    },
    /* 关闭当前标签（Ctrl+W） */
    closeCurrent: function () {
      if (!active) return;
      hooks.close && hooks.close(active);
    },
    select: function (path) {
      if (tabs.indexOf(path) < 0) tabs.push(path);
      active = path; UI.tabs.render(); UI.tabs.persist();
    },
    render: function () {
      var bar = U.$('#tabsbar');
      bar.innerHTML = '';
      tabs.forEach(function (p) {
        var t = U.el('div', { class: 'tab' + (p === active ? ' active' : '') });
        /* E-038：以前没设 dataset.path，于是 app.js 里 dirty[undefined] 恒为 false，
           .dirty 类永远加不上；而 .tdot 又无条件创建、CSS 没有隐藏规则 ——
           结果每个标签都常亮"未保存"圆点，而它不代表任何事。
           两个 bug 叠在一起最坏：用户要么以为文件都没存，要么学会无视它。 */
        t.dataset.path = p;
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
    /* 切到云盘就刷一次状态：登录态可能已在别处变化 */
    if (name === 'cloud' && Code.cloud) {
      try { setTimeout(function () { UI.refreshCloud(); }, 0); } catch (e) { }
    }
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
    /* 抽屉模式：开了才显示遮罩。直接 toggle 时同步一次，
       否则会出现"抽屉开着但没有遮罩，点别处关不掉"的状态。 */
    document.body.classList.toggle('side-open', !off && isNarrow());
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
  /* opt.warn = true 时把左侧文字标红并加粗。
     保存失败这类"用户必须立刻知道"的事，不能和普通提示一个样式 ——
     他扫一眼状态栏就该看出不对劲。 */
  UI.status = function (opt) {
    if (opt.pos != null) U.$('#st-pos').textContent = opt.pos;
    if (opt.lang != null) U.$('#st-lang').textContent = opt.lang;
    if (opt.size != null) U.$('#st-size').textContent = opt.size;
    if (opt.mode != null) U.$('#st-mode').textContent = opt.mode;
    if (opt.left != null) {
      var el = U.$('#st-left');
      el.textContent = opt.left;
      /* warn：红色加粗。保存失败必须一眼看出来，不能和普通提示一个样。 */
      if (opt.warn) { el.classList.add('st-warn'); }
      else { el.classList.remove('st-warn'); }
    }
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
    /* 窄屏不用桌面拖出来的尺寸：那是在宽屏下调的，搬到手机上会把编辑区挤没。
       这里干脆不写内联样式，让 CSS 的媒体查询说了算。
       （CSS 那边也留了 !important 兜底 —— 两道保险，因为内联样式优先级更高，
         只要有一处漏写就会表现为"手机上侧栏特别宽"这种很难查的问题。 */
    if (!isNarrow()) {
      UI.panel.open(!!p.panelOpen);
      if (p.panelHeight) UI.panel.setHeight(p.panelHeight);
      if (p.sideWidth) U.$('#sidebar').style.width = p.sideWidth + 'px';
    } else {
      /* 窄屏默认不展开面板 —— 140px 在 667px 高的屏上占比太大 */
      UI.panel.open(false);
    }
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
  /* 当前主题对应的"切换后"图标：与顶栏按钮同一套逻辑。
     浅色下点它要切到深色 → 显示月亮；深色下显示太阳。
     E-048：命令面板以前写死太阳，与实际主题无关，其中一个永远是错的。 */
  function currentThemeIcon() {
    try {
      var t = document.documentElement.getAttribute('data-theme');
      return t === 'light' ? 'i-moon' : 'i-sun';
    } catch (e) { return 'i-sun'; }
  }

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
        /* ⚠ 原来写 go(hit[sel])（E-033）—— 用的是全局选中序号 sel，
           不是被点击那一项的 idx。
           桌面侥幸正确，因为 mouseenter 已把 sel 改成 idx；
           但触摸设备上没有 hover，sel 停在上一次的位置，
           **点第 3 项会打开第 1 项**。
           这种"能打开但打开错了"比打不开更难发现 —— 用户会以为自己点错了。
           本条曾被对面 AI 的推送覆盖，故重新应用。 */
        d.onmouseenter = function () { sel = idx; mark(); };
        d.onmousedown = function () { sel = idx; };
        d.onclick = function () { sel = idx; go(hit[idx]); };
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
      { label: '新建文件', hint: 'Ctrl+N', icon: 'i-plus', act: function () { hooks.cmd && hooks.cmd('new-file'); } },
      { label: '新建文件夹', hint: 'Ctrl+Shift+N', icon: 'i-folder-plus', act: function () { hooks.cmd && hooks.cmd('new-folder'); } },
      { label: '保存当前文件', hint: 'Ctrl+S', icon: 'i-save', act: function () { hooks.cmd && hooks.cmd('save'); } },
      { label: '运行当前文件', hint: 'Ctrl+Enter', icon: 'i-run', act: function () { hooks.cmd && hooks.cmd('run'); } },
      /* TLE 预测：超时是竞赛里最贵的错，入口必须显眼 ——
         藏在设置里等于没有，用户根本不会想到要找它。 */
      { label: 'TLE 预测（会不会超时）', hint: 'C++', icon: 'i-run', act: function () { hooks.cmd && hooks.cmd('tle'); } },
      { label: '清空本地工程（危险）', hint: '', icon: 'i-trash', act: function () { hooks.cmd && hooks.cmd('clear-all'); } },
      { label: '导出全部文件（ZIP）', hint: 'Ctrl+E', icon: 'i-download', act: function () { hooks.cmd && hooks.cmd('export'); } },
      { label: '导入文件或 ZIP', hint: 'Ctrl+O', icon: 'i-upload', act: function () { hooks.cmd && hooks.cmd('import'); } },
      /* E-048：以前写死 'i-sun'，而顶栏真按钮是动态的（浅色显示月亮）。
         同一个操作两个图标，其中一个永远是错的：浅色下命令面板显示太阳
         （=切到浅色），点了却切回深色。按当前主题取，与顶栏保持一致。 */
      { label: '切换深浅主题', hint: 'Ctrl+G', icon: currentThemeIcon(), act: function () { hooks.cmd && hooks.cmd('theme'); } },
      { label: '显示 / 隐藏底部面板', hint: 'Ctrl+`', icon: 'i-split', act: function () { hooks.cmd && hooks.cmd('panel'); } },
      { label: '关闭当前标签', hint: 'Ctrl+W', icon: 'i-close', act: function () { hooks.cmd && hooks.cmd('close-tab'); } },
      { label: '搜索文件内容', hint: 'Ctrl+F', icon: 'i-search', act: function () { hooks.cmd && hooks.cmd('search'); } },
      { label: '打开设置', hint: 'Ctrl+,', icon: 'i-gear', act: function () { hooks.cmd && hooks.cmd('settings'); } },
      { label: '清空运行输出', hint: '', icon: 'i-eraser', act: function () { hooks.cmd && hooks.cmd('clear'); } },
      { label: '扩展中心（下载运行时）', hint: 'Ctrl+D', icon: 'i-download', act: function () { UI.extensions(); } },
      /* E-030：命令面板里也要有，否则手机端（没有 Ctrl 组合键）无处可关 */
      { label: '关闭预览', hint: '', icon: 'i-close', act: function () { hooks.cmd && hooks.cmd('close-preview'); } },
      /* 撤销导入：只在有快照时出现 —— 没有可撤销的东西还摆着，是另一种误导 */
      (function () {
        try {
          if (!Code.fs || !Code.fs.hasImportSnapshot || !Code.fs.hasImportSnapshot()) return null;
          return { label: '撤销上次导入', hint: '', icon: 'i-undo',
            act: function () { hooks.cmd && hooks.cmd('undo-import'); } };
        } catch (e) { return null; }
      })(),
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
        /* ⚠ 原来无条件写"只存在这台设备上，不上传任何服务器"（E-034）。
           而云盘已上线：注册、登录、上传都是真实网络请求。
           「关于」是用户最常打开的入口，这句话他一定会读到，
           于是他会以为云盘也不上传 —— 声明与实际相反比没有声明更糟。
           用 token() 判断登录态，不能用 isOn() ——
           isOn() 是"后端是否配置好"，未登录时也可能是 true，
           拿它当登录态会在用户没登录时显示"已登录"，骗的方向相反。
           （同文件 581 行已有 Code.cloud.token() 的同类用法。） */
        (Code.cloud && Code.cloud.token && Code.cloud.token()
          ? '<p class="about-p">已登录云盘：你主动上传的文件会存到服务端数据库，' +
            '换设备可取回；未主动上传的文件仍只在这台设备上。</p>'
          : '<p class="about-p">当前未登录云盘：你的代码与文件只存在这台设备上，' +
            '不上传任何服务器；除了在扩展中心主动下载运行时，页面不发起任何网络请求。</p>') +
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
    /* 下载失败时最该做的不是重试，而是先弄清楚为什么失败。
       "NetworkError" 分不清是断网、被拦还是跨域被拒，而这三者处理方式完全不同。
       体检按钮一次就能判定。

       注意：U.modal 的 actions 只认 {label, primary, onClick} 这类普通对象，
       不认已经构造好的 DOM 元素 —— 传元素进去的话，modal 会去读 a.label
       得到 undefined，按钮就变成空白且点不动。
       所以要传 action 对象，按钮的后续状态改动通过 DOM 查找来做。 */
    var diagAction = {
      label: '网络体检',
      onClick: function () {
        var box = U.$('#ext-diag');
        var btn = null;
        var bs = document.querySelectorAll('#modal-actions .btn');
        for (var i = 0; i < bs.length; i++) {
          if (/网络体检|重新体检|体检中/.test(bs[i].textContent)) { btn = bs[i]; break; }
        }
        if (btn) { btn.disabled = true; btn.textContent = '体检中…'; }
        if (box) { box.classList.remove('hidden'); box.textContent = '正在检测（约几秒）…'; }

        function done() { if (btn) { btn.disabled = false; btn.textContent = '重新体检'; } }

        if (!Code.runtimes || !Code.runtimes.diagnose) {
          if (box) box.textContent = '运行时管理模块未加载，无法体检。';
          done(); return;
        }
        Code.runtimes.diagnose({
          diag: function (r) {
            done();
            if (!box) return;
            var head = (r && r.verdict === 'ok') ? '结论：链路正常'
              : (r && r.verdict === 'cors') ? '结论：跨域被拒（CORS）'
              : (r && r.verdict === 'network') ? '结论：网络层不通'
              : '结论：体检未能完成';
            var txt = head + '\n\n' + (r && r.text ? r.text : '') + '\n';
            if (r && r.assetUrl) txt += '\n体检用的地址：' + r.assetUrl;
            if (r && r.steps && r.steps.length) {
              txt += '\n\n分步结果：';
              /* 分步结果可能含 null（某一步的 note 没写成），
                 直接 st.r 会抛，把整个结果渲染打断。过滤掉再渲染。 */
              r.steps.filter(function (x) { return x && x.r; }).forEach(function (st) {
                var x = st.r || {};
                txt += '\n  · ' + st.name + '：' +
                  (x.ok ? ('成功（状态 ' + x.status + '，' + x.ms + 'ms）')
                        : ('失败（' + (x.err || '?') + '）'));
              });
            }
            box.textContent = txt;
          },
          fail: function (d) {
            done();
            if (box) box.textContent = '体检失败：' + ((d && d.error) || '未知');
          }
        });
      }
    };

    var close = U.modal({
      title: '扩展中心',
      body: '<p class="about-p">这些是可选的运行时扩展。基础功能（JavaScript、HTML、Python 子集、C/C++ 子集）' +
        '不需要下载，已经能直接用。</p>' +
        '<p class="about-p ext-note">下载的东西存进<b>你自己浏览器</b>的缓存里，不上传任何服务器。' +
        '<b>首次下载需要联网</b>，下完之后离线也能用。</p>' +
        /* 多语言的真实状态写在列表上方。
           "未下载"会被理解成"下载后就能用" —— 而这六种按需运行时
           端到端一次都没跑通过（开发环境访问 Release 下载被挡，403），
           只有结构断言、没有一次真实执行。
           放在 #ext-list 之外，因为 render() 会清空列表。 */
        '<p class="ext-warn">这些按需运行时尚未经端到端验证：' +
          '下载与加载链路只做过结构断言，实际能否跑出结果一次都没验过。' +
          '建议先试体积最小的 SQLite（约 0.7 MB），它通了就说明整条链路是好的。</p>' +
        '<pre id="ext-diag" class="ext-diag hidden"></pre>' +
        '<div id="ext-list" class="ext-list"></div>',
      actions: [
        diagAction,
        { label: '关闭', primary: true }
      ]
    });

    var list = U.$('#ext-list');
    if (!list) return;
    /* 先加载清单再渲染：ready / license 都取自它，
       没加载就渲染会得到"什么都没标"的空界面。 */
    render();
    if (R && R.loadManifest) {
      /* 清单读不到时，许可证与"暂不可用"标记都会是空的 ——
         用户会以为这些运行时都能下载、都没有许可证，
         而实际上有一个是下了也跑不了的。静默降级比报错更坏，
         所以读不到就明说，并把下载按钮禁掉（不知道该不该下，就别让人下）。 */
      var note = U.el('div', { class: 'ext-warn', text: '正在读取运行时清单…' });
      list.appendChild(note);
      try {
        R.loadManifest().then(function () {
          try { note.remove(); } catch (e) { }
          render();
        }, function () {
          note.textContent = '读不到运行时清单（api/runtimes.json），暂时无法确认各运行时的状态与许可证。' +
            '离线或本地直开时会出现这种情况 —— 此时不建议下载。';
        });
      } catch (e) {
        note.textContent = '运行时清单读取失败：' + String(e && e.message || e);
      }
    }

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
        /* E-051：TERMS.md 白纸黑字承诺"许可证在扩展中心逐项标明"。
           用户据此判断能不能商用，条款说了界面却没给 —— 等于承诺没兑现。
           数据本来就在清单里（rt.license），只是之前没读。 */
        if (rt && rt.license) {
          head.appendChild(U.el('span', { class: 'ext-license', text: rt.license }));
        }
        head.appendChild(U.el('span', { class: 'ext-size', text: L.fmtSize(bytes) }));
        row.appendChild(head);

        var d = U.el('div', { class: 'ext-desc', text: (lang.wasm && lang.wasm.desc) || lang.desc || '' });
        row.appendChild(d);

        /* E-018：「下完也跑不了」必须在下载前就写明。
           90 MB 下载要好几分钟，让用户等完了才发现不能用是最坏的体验。
           所以未就绪的运行时置灰下载按钮，并把原因写在旁边。 */
        var notReady = rt && rt.ready === false;
        if (notReady) {
          var warn = U.el('div', { class: 'ext-warn', text: '暂不可用：' + (rt.readyNote || '接线未完成') });
          row.appendChild(warn);
        }

        var bar = U.el('div', { class: 'ext-bar' });
        var state = U.el('span', { class: 'ext-state' });
        var btn = U.el('button', { class: 'btn small' });

        if (notReady) {
          state.textContent = '资源已就位，接线未完成';
          state.className = 'ext-state bad';
          btn.textContent = '暂不可用';
          btn.disabled = true;
        } else if (st && st.ready) {
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

    /* 不在这里抄第二份（S-041）：唯一定义在 runner.js，抄表必然漂移 */
    var RT_KEY = (Code.runner && Code.runner.RT_KEY) || {};

    /* 启动时探一次缓存状态，界面才知道谁已下载。
       E-055：refreshStatus() 是异步探测，以前这里调用完立刻同步 render()，
       读到的还是旧状态 —— 表现为"进度条走完 100%，状态却仍是未下载"，
       用户以为下载失败了。所以统一返回 promise，由调用方在 then 里 render。 */
    function refresh() {
      if (R && R.refreshStatus) {
        try {
          return Promise.resolve(R.refreshStatus()).catch(function () { });
        } catch (e) { return Promise.resolve(); }
      }
      return Promise.resolve();
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
          ready: function () {
            row.classList.remove('busy');
            refresh().then(function () { render(); });
          },
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

  /* ================= 云盘状态 =================
     未登录是常态，不是错误 —— 不能每次打开都弹"连接失败"。
     查不到就显示成"未登录"，用户想用自然会去登录。 */
  UI.refreshCloud = function () {
    var st = U.$('#cloud-state');
    var setSt = U.$('#set-cloud-state');
    var loginBox = U.$('#cloud-login-box');
    var opsBox = U.$('#cloud-ops-box');
    if (!st || !Code.cloud) return;

    function show(text, logged) {
      st.innerHTML = text;
      if (setSt) setSt.innerHTML = text;
      if (loginBox) loginBox.classList.toggle('hidden', !!logged);
      if (opsBox) opsBox.classList.toggle('hidden', !logged);
    }

    /* 没有会话就不必发请求：省一次往返，也不会出现"请先登录"的红字 */
    if (!Code.cloud.token()) {
      show('<b>未登录</b><br>文件只存在这台设备上。登录后可存到云端，换设备能取回。', false);
      return;
    }

    show('（正在获取…）', false);
    Code.cloud.me(true).then(function (m) {
      var mb = function (n) { return (n / 1048576).toFixed(2) + ' MB'; };
      var shared = Code.cloud.isSharedSession()
        ? '<br><span class="hint">（已沿用 Chat 的登录态）</span>' : '';
      show('<b>已登录：' + (m.nick || '?') + '</b>' +
        '<br>云端 ' + (m.files || 0) + ' 个文件，' + mb(m.used || 0) + ' / ' + mb(m.quota || 0) +
        shared, true);
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      /* 会话失效就清掉，避免一直显示"已登录"却什么都用不了 */
      if (/失效|未登录|请先登录/.test(msg)) Code.cloud.dropSession();
      show('<b>未登录</b>' + (/失效/.test(msg) ? '（登录已失效）' : '') +
        '<br>文件只存在这台设备上。', false);
    });
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

    /* E-028：改写的目的就是把结果用回去。以前只有「关闭」和「发送」，
       用户得拖选整段 → Ctrl+C → 关对话框 → 回编辑器 → 粘贴。
       不自动改文件是对的（改代码要用户自己确认），但不给出路就不对了。 */
    var lastText = '';
    var stripFence = function (t) {
      /* 模型常把代码包在 ``` 里，直接粘进去会多出围栏行 */
      var m = /^\s*```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/.exec(t);
      return m ? m[1] : t;
    };

    U.modal({
      title: mode === 'explain' ? 'AI 解释代码' : 'AI 改写代码',
      body: body,
      actions: [
        { label: '关闭' },
        {
          label: '复制结果', onClick: function () {
            if (!lastText) { U.toast('还没有结果可复制', 'err'); return false; }
            var txt = mode === 'rewrite' ? stripFence(lastText) : lastText;
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(txt)
                .then(function () { U.toast('已复制到剪贴板'); })
                .catch(function () { U.toast('复制失败，请手动选中', 'err'); });
            } else { U.toast('此浏览器不支持自动复制，请手动选中', 'err'); }
            return false;
          }
        },
        {
          label: '插入到光标处', onClick: function () {
            if (!lastText) { U.toast('还没有结果可插入', 'err'); return false; }
            var ed = Code.editor;
            if (!ed || !ed.replace) { U.toast('编辑器未就绪', 'err'); return false; }
            var txt = mode === 'rewrite' ? stripFence(lastText) : lastText;
            try {
              var r = ed.sel();
              ed.replace(r[0], r[1], txt);
              U.toast('已插入，可撤销');
            } catch (e) { U.toast('插入失败：' + e.message, 'err'); }
            return false;
          }
        },
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
              lastText = r.text || '';
              out.textContent = lastText || '（返回为空）';
            }).catch(function (e) {
              lastText = '';
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
    /* E-053：改用 Pointer Events —— 触摸屏没有 mousedown/mousemove/mouseup，
       以前手机上侧栏宽度与面板高度都拖不动。一套事件覆盖鼠标/触摸/手写笔。 */
    var rz = U.$('#resizer'), dragging = false, y0 = 0, h0 = 0;
    rz.addEventListener('pointerdown', function (e) {
      dragging = true; y0 = e.clientY; h0 = U.$('#panel').offsetHeight;
      document.body.style.userSelect = 'none';
      try { rz.setPointerCapture(e.pointerId); } catch (err) { }
      e.preventDefault();
    });
    rz.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var h = UI.panel.setHeight(h0 - (e.clientY - y0));
      Code.store.set('panelHeight', h);
      e.preventDefault();
    });
    var endPanelDrag = function (e) {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
      try { rz.releasePointerCapture(e.pointerId); } catch (err) { }
    };
    rz.addEventListener('pointerup', endPanelDrag);
    rz.addEventListener('pointercancel', endPanelDrag);

    /* 侧栏宽度拖动 */
    var sw = U.$('#side-resizer');
    if (sw) {
      var sd = false, x0 = 0, w0 = 0;
      sw.addEventListener('pointerdown', function (e) {
        sd = true; x0 = e.clientX; w0 = U.$('#sidebar').offsetWidth;
        document.body.style.userSelect = 'none';
        try { sw.setPointerCapture(e.pointerId); } catch (err) { }
        e.preventDefault();
      });
      sw.addEventListener('pointermove', function (e) {
        if (!sd) return;
        var w = Math.max(150, Math.min(520, w0 + (e.clientX - x0)));
        U.$('#sidebar').style.width = w + 'px';
        Code.store.set('sideWidth', w);
        e.preventDefault();
      });
      var endSideDrag = function (e) {
        if (!sd) return;
        sd = false; document.body.style.userSelect = '';
        try { sw.releasePointerCapture(e.pointerId); } catch (err) { }
      };
      sw.addEventListener('pointerup', endSideDrag);
      sw.addEventListener('pointercancel', endSideDrag);
    }

    UI.panel.show('output');
    UI.tabs.render();
  };

  UI.toggleSideForce = function (hidden) {
    setSide(!hidden);
  };
  UI.sideCollapsed = function () { return U.$('#sidebar').classList.contains('collapsed'); };

  /* ---------- 移动端：侧栏改抽屉 ----------
     窄屏下侧栏浮在内容之上（CSS 已处理），这里负责开合状态与遮罩。
     桌面行为完全不变 —— 只有 isNarrow() 为真时才走这套。 */
  /* 本文件的 IIFE 没有入参，所以只能用 window —— 写 global 会 ReferenceError。
     之前这里写成 global 外面又套了 try/catch 兜底，结果错误被静默吃掉，
     函数恒定返回 false，移动端整套布局一次都没生效过。
     教训：防御性 catch 只用来接"预期内的异常"，
     不能拿它兜底变量名写错这类逻辑错误 —— 那会把真故障伪装成正常分支。 */
  /* 窄屏 = 宽度不够 **或** 高度不够（横屏手机）。
     只判宽度的话，852×393 的横屏手机会走桌面布局，侧栏挤掉 250px，
     编辑区只剩不到两成高度。 */
  function isNarrow() {
    try {
      return !!(window.matchMedia &&
        window.matchMedia('(max-width: 720px), (max-height: 480px)').matches);
    } catch (e) { return false; }
  }
  UI.isNarrow = isNarrow;

  function setSide(open) {
    var sb = U.$('#sidebar');
    if (!sb) return;
    sb.classList.toggle('collapsed', !open);
    document.body.classList.toggle('side-open', !!open && isNarrow());
  }

  /* 窄屏时默认把抽屉关上：一进来就该看到代码，不是文件树。
     这条只对窄屏生效，不影响桌面 —— 否则用户上手机再回电脑会发现侧栏没了。 */
  UI.initMobileLayout = function () {
    if (!isNarrow()) return;
    if (isNarrow() && !U.$('#sidebar').classList.contains('collapsed')) {
      setSide(false);
    }
    /* 面板默认收起：190px 在手机上吃掉太多，要用再展开 */
    if (UI.panel && UI.panel.isOpen && UI.panel.isOpen()) UI.panel.open(false);

    var scrim = U.$('#side-scrim');
    if (scrim && !scrim.__bound) {
      scrim.__bound = true;
      scrim.addEventListener('click', function () { setSide(false); });
    }
  };

  /* 窗口从窄变宽（手机横屏/平板）时清掉遮罩状态，别留下幽灵遮罩 */
  try {
    window.addEventListener('resize', function () {
      if (!isNarrow() && document.body.classList.contains('side-open')) {
        document.body.classList.remove('side-open');
      }
    });
  } catch (e) { }

  Code.ui = UI;
})();
