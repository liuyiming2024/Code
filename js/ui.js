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
    /* 切到云盘就刷一次状态：登录态可能已在别处变化。
       加密网盘**按需**刷 —— 它要加载另一个页面（隐藏 iframe），
       启动时就做会白白拖慢首屏，而多数人根本不用它。 */
    if (name === 'cloud') {
      if (Code.cloud) { try { setTimeout(function () { UI.refreshCloud(); }, 0); } catch (e) { } }
      try { setTimeout(function () { UI.refreshDrive(); }, 0); } catch (e) { }
    }
    /* ⚠ 这个名单必须**包含 activitybar 上每一个 data-view**。
       之前漏了 'cloud'，后果是：点左侧云盘图标按钮会亮起（active 生效），
       但 #view-cloud 从来没被去掉 hidden —— 于是**整个侧栏空白**，
       而右上角标题也是空的，看起来就像"云盘坏了/白屏"。
       按钮亮着 + 内容空白，用户只会以为云盘功能没做完，
       不会想到是这里少写了一个单词。
       所以下面不从硬编码名单出发，而是**直接读 DOM 上实际有哪些视图**，
       以后再加视图也不会重蹈覆辙。 */
    U.$$('#activitybar [data-view]').forEach(function (b) {
      var v = b.getAttribute('data-view');
      var e = U.$('#view-' + v);
      if (e) e.classList.toggle('hidden', v !== name);
      b.classList.toggle('active', v === name);
    });
    var t = U.$('#side-title');
    var names = { files: '文件', search: '搜索', run: '运行', settings: '设置', cloud: '账号与云盘' };
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
      /* S-040：片段开关此前只存在于注释里，命令面板没有这一项，
         用户关不掉 Tab 片段展开。写竞赛代码时这个展开很碍事。 */
      (Code.snippets ? {
        label: (Code.snippets.isOff() ? '开启' : '关闭') + ' Tab 片段展开',
        hint: '', icon: 'i-return',
        act: function () {
          var now = Code.snippets.toggle();
          U.toast(now ? '已关闭 Tab 片段展开（按 Tab 只缩进）' : '已开启 Tab 片段展开');
        }
      } : null),
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
    /* ⚠ 自检在 **Code.runtimes**（管 Worker、能真跑探针）里，
       不在 R（Code.runtime，只回答"有哪些、多大、缓存里有没有"）里。
       原来写 R.selfTest，而 R 上根本没有这个方法 ——
       于是 `if (!R.selfTest) return;` 恒成立，
       按钮点下去**什么都不会发生**，连报错都没有。
       用户看到的就是"自检点不动"，无从判断是没装还是坏了。 */
    var W = Code.runtimes;
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

    /* 基础包自检块。
       放在最上面，是因为它是"能不能跑"的地基 ——
       扩展包只影响某一种语言，基础包坏了则什么都跑不了。
       用户先看到它，才知道后面的下载值不值得做。 */
    function renderBasePack() {
      var box = U.el('div', { class: 'ext-base' });
      var head = U.el('div', { class: 'ext-head' });
      head.appendChild(U.el('div', { class: 'ext-name', text: '基础包（已内置）' }));
      head.appendChild(U.el('span', { class: 'ext-tag', text: '零下载' }));
      head.appendChild(U.el('span', { class: 'ext-size', text: '永久可用' }));
      box.appendChild(head);
      box.appendChild(U.el('div', {
        class: 'ext-desc',
        text: '打开就能跑，不需要下载任何东西：JS / HTML 由浏览器执行，' +
              'Python 与 C++ 由本项目自研解释器执行。' +
              '下面这些扩展包是**可选增强**，不装也能正常用。'
      }));

      var ul = U.el('div', { class: 'ext-selftest' });
      var btn = U.el('button', { class: 'ext-btn', text: '自检' });
      btn.style.marginTop = '6px';
      var out = U.el('div', { class: 'ext-desc' });
      out.textContent = '点「自检」会真的跑一行代码逐项验证 —— ' +
        '只检查"文件在不在"说明不了问题（六个官方运行时就是这样：' +
        '看着都有，实际一次都没跑通过）。';
      btn.onclick = function () {
        /* selfTestBase 返回 Promise（HTML 预览那条要等 srcdoc 回传）。
           不接 Promise 的话 res 会是个 Promise 对象，
           res.forEach 直接抛错 —— 表现为"自检本身出错"，
           而真正的自检结果一条都看不到。 */
        out.textContent = '正在自检（HTML 预览要等回传，最多 3 秒）…';
        var pr;
        try {
          pr = (Code.runner && Code.runner.selfTestBase)
              ? Code.runner.selfTestBase() : Promise.resolve([]);
        } catch (e) {
          out.textContent = '自检本身出错：' + String((e && e.message) || e);
          return;
        }
        Promise.resolve(pr).then(function (res) { renderRes(res); }, function (e) {
          out.textContent = '自检本身出错：' + String((e && e.message) || e);
        });
      };
      function renderRes(res) {
        out.innerHTML = '';
        var bad = 0;
        res.forEach(function (r) {
          if (!r.ok) bad++;
          var line = U.el('div', {
            class: 'ext-desc',
            text: (r.ok ? '✅ ' : '❌ ') + r.name + '：' + r.detail
          });
          if (!r.ok) line.className = 'ext-state bad';
          out.appendChild(line);
        });
        if (bad === 0) {
          out.appendChild(U.el('div', {
            class: 'ext-desc', text: '全部通过 —— 不装任何扩展包也能正常写代码和运行。'
          }));
        } else {
          out.appendChild(U.el('div', {
            class: 'ext-desc',
            text: bad + ' 项未通过。基础包坏了意味着连 Hello world 都跑不了，' +
                  '请先把它修好再考虑扩展包。'
          }));
        }
      }
      ul.appendChild(btn);
      ul.appendChild(out);
      box.appendChild(ul);
      return box;
    }

    function render() {
      list.innerHTML = '';
      try { list.appendChild(renderBasePack()); } catch (e) { }
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

        /* 已知起不来的，必须在**下载前**就说清楚。
           12 MB 下完才发现不能用是最坏的体验 —— 用户会以为是自己的问题。 */
        var rtBroken = (rt && rt.broken) || (lang.wasm && lang.wasm.broken);
        if (rtBroken) {
          var w = U.el('div', { class: 'ext-state bad', text: '⚠ 已知无法启动：' + rtBroken });
          row.appendChild(w);
        }

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
          /* 已下载的才给自检按钮 —— 没装的时候按了只会报错。
             自检=真跑一行探针，不是检查文件在不在。 */
          var tbtn = U.el('button', { class: 'ext-btn', text: '自检' });
          tbtn.style.marginLeft = '6px';
          tbtn.onclick = function () {
            if (!W || !W.selfTest) {
              var t2 = U.el('div', { class: 'ext-state bad',
                text: '自检不可用：Code.runtimes 未加载（自检要真跑探针，只有它做得到）' });
              row.appendChild(t2);
              return;
            }
            tbtn.disabled = true;
            var tip = U.el('div', { class: 'ext-desc', text: '正在真跑一行探针代码…' });
            row.appendChild(tip);
            /* ⚠ 必须挂 fail 与超时钩子。
               只挂 selftested 的话，Worker 一旦失败或没回应，
               tip 会永远停在"正在自检…"，按钮也一直灰着 ——
               和"点不动"看起来一模一样，用户根本分不清。 */
            var settled = false;
            function finish(text, bad) {
              if (settled) return;
              settled = true;
              tbtn.disabled = false;
              tip.textContent = text;
              tip.className = bad ? 'ext-state bad' : 'ext-desc';
            }
            W.selfTest(id, {
              selftested: function (d) {
                finish((d && d.ok ? '✅ ' : '❌ ') +
                  ((d && d.detail) || '无结果') +
                  (d && d.known ? '（已知缺陷，不是你的问题）' : ''), !(d && d.ok));
              },
              fail: function (d) {
                finish('❌ 自检失败：' + ((d && d.error) || '未知原因'), true);
              }
            });
            setTimeout(function () {
              finish('❌ 自检超时（2 分钟未回应）—— 可能是 Worker 没起来', true);
            }, 2 * 60 * 1000);
          };
          bar.appendChild(tbtn);
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
  /* 页眉账号按钮的状态。
     它和侧栏云盘面板是**同一个状态的两处显示**，必须一起更新 ——
     只更新一处会出现"页眉显示已登录、点进去却是未登录"的分裂状态，
     用户不知道该信哪个。所以抽成一个函数，两边共用。 */
  UI.refreshAcct = function (m) {
    var btn = U.$('#btn-acct');
    var lab = U.$('#acct-label');
    if (!btn || !lab) return;
    var SI = window.SiteIdentity;

    /* ⚠「离线」与「未登录」必须分开显示 —— 这两件事对用户完全不同：
         "未登录" → 我知道我没登录
         "离线"   → 我登录了，但现在连不上
       不区分的话，用户在地铁里打开会以为自己被登出了，
       于是重新登录、改密码，制造出一堆本来不存在的问题。
       （这条判定来自统一身份服务的约定，不是本文件自创。） */
    if (!m && SI && SI.state && SI.state.offline) {
      lab.textContent = '离线';
      btn.classList.remove('on');
      btn.classList.add('off');
      btn.title = '连不上服务器 —— 本地照常能用';
      return;
    }
    btn.classList.remove('off');
    if (m && m.nick) {
      lab.textContent = m.nick;
      btn.classList.add('on');
      btn.title = '已登录：' + m.nick + ' —— 点击查看云盘';
    } else {
      lab.textContent = '登录';
      btn.classList.remove('on');
      btn.title = '未登录 —— 点击登录';
    }
  };

  /* 打开云盘视图。页眉账号按钮和设置面板的「前往云盘」都走这里 ——
     两处各写一份就会出现"从这里点正常、从那里点没反应"。
     ⚠ 必须先确保侧栏是展开的：侧栏折叠时切视图没有任何视觉变化，
       用户点了没反应，只会以为按钮坏了。 */
  UI.openCloud = function () {
    if (!Code.cloud) { U.toast('云盘暂时用不了', 'err'); return; }
    var side = U.$('#sidebar');
    if (side && side.classList.contains('collapsed')) UI.toggleSide();
    UI.setView('cloud');
    try { Code.store.set('sideView', 'cloud'); } catch (e) { }
    /* 窄屏下抽屉会盖住编辑器，加遮罩让用户能一键收起 */
    if (isNarrow()) document.body.classList.add('side-open');
    if (UI.refreshCloud) UI.refreshCloud();
  };

  /* ================= 加密网盘（另一个网盘） =================
     它与本项目云盘**完全独立**：那边存的是加密后的字节，走 GitHub Actions，
     上传下载要等几十秒；这边是按文件同步的代码。
     界面上必须说清这是两块空间 —— 叫混了用户会以为存一份两边都有。 */
  UI.refreshDrive = function () {
    var st = U.$('#drive-state');
    var list = U.$('#drive-list');
    if (!st) return;
    var D = Code.drive;
    if (!D) { st.innerHTML = '（不可用）'; return; }

    /* 状态先如实报，不猜测 */
    st.innerHTML = '（正在连接…）';
    D.status().then(function (r) {
      if (!r.ok) {
        /* 不可用也要给得出路：能跳过去就用，跳过去之后用户至少知道去哪设置 */
        st.innerHTML = '用不了：' + U.esc(r.reason || '未知原因') +
          (r.canJump ? '（点右侧「打开加密网盘」去设置）' : '');
        if (list) list.innerHTML = '';
        return;
      }
      var who = r.who && r.who.uid ? '账号 ' + U.esc(r.who.uid) : '已就绪';
      /* 快通道（后端直连）是秒级，慢通道（Actions 搬运）要等几十秒 ——
         不说清楚的话，快通道的用户看到"要等一会儿"会以为坏了，
         慢通道的用户看到没提示会以为卡死然后刷新。 */
      var chTxt = (r.channel === 'worker') ? '快通道' : '慢通道（每次要等一会儿）';
      var bindTxt = '';
      try {
        var cur = (UI.tabs && UI.tabs.current) ? UI.tabs.current() : '';
        var b = cur ? bindGet(cur) : null;
        if (b) bindTxt = '<br>当前文件已连到里面的一条，改完点「把当前文件存进去」就是更新它，不会多出副本。';
      } catch (e) { }
      st.innerHTML = '<b>可用</b> · ' + who + ' · ' + chTxt + bindTxt;
      return D.list().then(function (items) {
        if (!list) return;
        list.innerHTML = '';
        if (!items || !items.length) {
          list.innerHTML = '<p class="hint">里面还是空的。</p>';
          return;
        }
        items.forEach(function (it) {
          var row = document.createElement('div');
          row.className = 'row';
          var nm = document.createElement('span');
          nm.className = 'row-key';
          nm.textContent = it.name || it.id || '(无名)';
          var sz = document.createElement('span');
          sz.className = 'hint';
          sz.textContent = (it.size != null) ? fmtSize(it.size) : '';
          var dl = document.createElement('button');
          dl.className = 'btn';
          dl.textContent = '取回';
          dl.onclick = function () { UI.driveGet(it.id, it.name); };
          row.appendChild(nm); row.appendChild(sz); row.appendChild(dl);
          list.appendChild(row);
        });
      }).catch(function (e) {
        st.innerHTML = '连上了，但列不出来：' + U.esc(String((e && e.message) || e));
      });
    }).catch(function (e) {
      st.innerHTML = '用不了：' + U.esc(String((e && e.message) || e));
    });
  };

  /* 错误提示要说人话。有一条尤其必须单独处理：
       对面上传时**会先查重**，内容完全一样就拒绝并抛
       "存储里已经有完全一样的内容了"。
       这其实是成功（东西确实在那儿），但报成了失败 ——
       用户会以为上传坏了，于是反复重试、甚至改坏文件再去传。
       所以把它翻成"已经在里面了，不用再传"。 */
  UI.driveErr = function (what, e) {
    var m = String((e && e.message) || e);
    if (/已经有完全一样的内容|dup/.test(m)) {
      U.toast(what + '完成：里面已经有完全一样的内容了，不用再传');
      return;
    }
    /* 先判是不是**对面代码的问题** —— 是的话说清楚，
       否则用户会对着自己的文件反复重试，而根因在另一个仓库。 */
    if (Code.drive && Code.drive.explain) {
      var why = Code.drive.explain(m);
      if (why) { U.toast(why, 'err'); return; }
    }
    U.toast(what + '失败：' + m, 'err');
  };

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* 取回：拿到明文后**存成新文件再打开**。
     ⚠ 绝不直接覆盖同名文件 —— 本地那份可能已经有改动，
        覆盖掉就是不可逆的丢失。所以重名时换个名字存，让用户自己比对。 */
  UI.driveGet = function (id, name) {
    var D = Code.drive;
    if (!D) return;
    U.toast('正在取回…');
    D.download(id).then(function (blob) {
      return blob.text().then(function (txt) {
        return UI.drivePut(name || 'drive-file.txt', txt, id);
      });
    }).catch(function (e) { UI.driveErr('取回', e); });
  };

  /* 把一段文本落成文件并打开。重名自动改名，不覆盖。
     ⚠ 非文本（图片/压缩包等）不往编辑器里塞 —— 塞进去就是一堆乱码，
       而且保存时会把二进制写坏。如实告诉用户，并给出"下载到本地"的出路。 */
  UI.drivePut = function (name, txt, driveId) {
    var fs = Code.fs;
    if (!fs) { U.toast('文件系统还没就绪', 'err'); return; }
    name = String(name || 'drive-file.txt');
    if (!isTextPath(name)) {
      U.toast('这不是文本文件，Code 里改不了', 'err');
      return;
    }
    var p = U.normPath(name);
    /* 重名就加后缀 —— 宁可多一个文件，也不覆盖已有内容 */
    if (fs.exists && fs.exists(p)) {
      var dot = p.lastIndexOf('.');
      var base = dot > 0 ? p.slice(0, dot) : p;
      var ext = dot > 0 ? p.slice(dot) : '';
      var i = 1, np;
      do { np = base + '-' + (i++) + ext; } while (fs.exists(np) && i < 100);
      p = np;
    }
    fs.create(p, 'file', txt).then(function () {
      if (Code.app && Code.app.open) Code.app.open(p);
      /* 记下它来自哪一条 —— 之后"存回去"就是更新这一条，不是新建副本 */
      if (driveId) bindSet(p, driveId, name);
      U.toast('已取回为 ' + p + (driveId ? '（改完可存回同一条）' : ''));
    }).catch(function (e) { U.toast('存不进去：' + String((e && e.message) || e), 'err'); });
  };

  /* ---------- 来自加密网盘的文件的"身份" ----------
     从加密网盘取回一个文件，改完再存回去 —— 这应当是**更新同一条**，
     不是新增一份。否则来回几次就堆出一串副本，用户自己都分不清哪个是新的。

     所以记下「本地路径 → 加密网盘里的条目 id」。
     存进 prefs 而不是只放内存：今天取回、明天再来存回也应该还认得。 */
  function bindMap() {
    try { return (Code.store && Code.store.prefs && Code.store.prefs.driveBind) || {}; } catch (e) { return {}; }
  }
  function bindSet(path, id, name) {
    try {
      var m = bindMap();
      m[path] = { id: id, name: name || path, at: Date.now() };
      Code.store.set('driveBind', m);
    } catch (e) { }
  }
  function bindGet(path) { return bindMap()[path] || null; }
  function bindDrop(path) {
    try {
      var m = bindMap();
      if (m[path]) { delete m[path]; Code.store.set('driveBind', m); }
    } catch (e) { }
  }
  UI.driveBound = function (path) { return bindGet(path); };

  /* 文本判断：代码文件一律当文本。
     ⚠ 按扩展名判，不按内容猜 —— 内容 sniff 对短文件不准，
       而"明明能编辑却被当成二进制"比反过来更烦。
     没有扩展名的（README / Makefile）也算文本 —— 网盘里放这些很常见。 */
  var BIN_EXT = {
    png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, ico: 1, bmp: 1,
    mp3: 1, mp4: 1, wav: 1, mov: 1, avi: 1, webm: 1,
    zip: 1, gz: 1, tar: 1, rar: 1, '7z': 1, pdf: 1,
    wasm: 1, exe: 1, dll: 1, so: 1, dylib: 1, ttf: 1, woff: 1, woff2: 1
  };
  function isTextPath(p) {
    var ext = String(p || '').split('.').pop().toLowerCase();
    if (!ext || ext === String(p || '').toLowerCase()) return true;  /* 无扩展名 */
    return !BIN_EXT[ext];
  }
  UI.isTextPath = isTextPath;

  /* 慢通道（Actions 搬运）要等几十秒 —— 这期间刷新会前功尽弃，
     所以必须**在操作开始前**就说清楚，而不是等用户等急了才提示。
     快通道秒级返回，不需要这句话（说了反而是噪音）。 */
  function slowHint(r) {
    if (r && r.channel === 'worker') return null;
    return '加密网盘要由后台搬一趟，通常要等几十秒 —— 这期间别刷新页面。';
  }

  /* 存进去：把当前打开的文件传上去。
     用**完整路径**当名字 —— 只传文件名的话，不同目录下的同名文件会互相覆盖。 */
  UI.driveSave = function () {
    var D = Code.drive;
    if (!D) return;
    var path = UI.tabs && UI.tabs.current && UI.tabs.current();
    if (!path) { U.toast('先打开一个文件', 'err'); return; }
    var fs = Code.fs;
    if (!fs || !fs.read) { U.toast('文件系统还没就绪', 'err'); return; }
    U.toast('正在上传…');
    D.status().then(function (r) {
      if (r && !r.ok) { U.toast('加密网盘用不了：' + (r.reason || ''), 'err'); return null; }
      var hint = slowHint(r);
      if (hint) U.toast(hint);
      return fs.read(path).then(function (txt) {
        var blob = new Blob([String(txt == null ? '' : txt)], { type: 'text/plain;charset=utf-8' });
        var old = bindGet(path);
        /* 文本走压缩：代码文本压缩率很高，能省下不少存储和搬运时间。
           ⚠ 只建议、不强制 —— 对面会自己判断压不压得动
             （压完更大就存原样），所以传 'auto' 就够，不必替它决定。 */
        return D.upload(blob, path, 'auto').then(function (newId) {
          /* 更新 = 先存新的，再删旧的。
             **顺序不能反** —— 先删后传，中途失败就是两边都没有，
             那才是真的丢了。先传后删，最坏情况是留一条重复的，可以手动删。 */
          if (old && old.id && old.id !== newId) {
            return D.remove(old.id).catch(function () {
              /* 删不掉不报错到用户脸上：东西已经存好了，
                 只是多留了一条旧的，用户自己能删。 */
            }).then(function () { return newId; });
          }
          return newId;
        }).then(function (newId) {
          if (newId) bindSet(path, newId, path);
          U.toast(old ? '已更新加密网盘里的同一条' : '已存入加密网盘');
          UI.refreshDrive();
        });
      });
    }).catch(function (e) { UI.driveErr('上传', e); });
  };

  /* 统一身份服务的状态变化（含**跨标签页**）要能带动云盘刷新。
     场景：用户在另一个标签页的主页登录了，切回 Code 这个标签 ——
     不订阅的话这里还显示"未登录"，而 token 其实已经写进 localStorage 了。
     用户看到的是"我明明登录了，它还说没有"。 */
  UI.watchIdentity = function () {
    var SI = window.SiteIdentity;
    if (!SI || !SI.onChange) return;
    SI.onChange(function () {
      try { UI.refreshCloud(); } catch (e) { }
    });
  };

  UI.refreshCloud = function () {
    var st = U.$('#cloud-state');
    var setSt = U.$('#set-cloud-state');
    var loginBox = U.$('#cloud-login-box');
    var opsBox = U.$('#cloud-ops-box');
    /* cloud.js 没加载（后端未配置）时，页眉按钮不能就这么杵着 ——
       它显示"登录"，点进去却什么都没有，等于一个坏按钮。
       所以明确标成不可用，比给一个点了没反应的按钮诚实。 */
    if (!Code.cloud) {
      var b0 = U.$('#btn-acct');
      var l0 = U.$('#acct-label');
      if (l0) l0.textContent = '云盘';
      if (b0) { b0.disabled = true; b0.title = '云盘暂时用不了'; }
      if (!st) return;
    }
    if (!st) return;

    function show(text, logged) {
      st.innerHTML = text;
      if (setSt) setSt.innerHTML = text;
      if (loginBox) loginBox.classList.toggle('hidden', !!logged);
      if (opsBox) opsBox.classList.toggle('hidden', !logged);
    }

    /* 统一身份服务说"离线"：不要去问后端（问了也是失败），
       直接显示离线态。注意它**可能仍然是已登录的**，只是连不上。 */
    var SI = window.SiteIdentity;
    if (SI && SI.state && SI.state.offline && !Code.cloud.token()) {
      show('<b>连不上服务器</b><br>本地照常能用，云盘暂时用不了。', false);
      UI.refreshAcct(null);
      return;
    }

    /* 没有会话就不必发请求：省一次往返，也不会出现"请先登录"的红字 */
    if (!Code.cloud.token()) {
      show('<b>未登录</b><br>文件只存在这台设备上，换台设备就看不到了。', false);
      UI.refreshAcct(null);
      return;
    }

    show('（正在获取…）', false);
    Code.cloud.me(true).then(function (m) {
      var mb = function (n) { return (n / 1048576).toFixed(2) + ' MB'; };
      var shared = Code.cloud.isSharedSession()
        ? '<br><span class="hint">（已沿用 Chat 的登录态）</span>' : '';
      /* ⚠ nick 来自服务端、由用户自己设定 —— **不是可信内容**。
         把它原样拼进 innerHTML 就是一个存储型 XSS：
         把昵称改成 `<img src=x onerror=fetch(...)>`
         就能在任何看到这条状态的页面上执行脚本。
         安全简报 D-3 要逐处复核的就是这一类。 */
      show('<b>已登录：' + U.esc(m.nick || '?') + '</b>' +
        '<br>云端 ' + (m.files || 0) + ' 个文件，' + mb(m.used || 0) + ' / ' + mb(m.quota || 0) +
        shared, true);
      UI.refreshAcct(m);
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      /* 会话失效就清掉，避免一直显示"已登录"却什么都用不了 */
      if (/失效|未登录|请先登录/.test(msg)) Code.cloud.dropSession();
      show('<b>未登录</b>' + (/失效/.test(msg) ? '（登录已失效，请重新登录）' : '') +
        '<br>文件只存在这台设备上。', false);
      UI.refreshAcct(null);
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
