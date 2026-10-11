/* mobile-bar.js —— 移动端辅助键条
 *
 * 为什么必须有这个：
 *   手机输入法打不出 Tab（缩进）、没有 Ctrl、没有 Esc、没有方向键。
 *   一行像样的代码都写不完整 —— 缺了 Tab 缩进的 Python 干脆没法写。
 *   所以补一条常驻的键条，把这些键变成能点的按钮。
 *
 * 三条硬规矩：
 *   1. **点按钮不能让输入框失焦**。一旦失焦，光标位置就没了，
 *      手机键盘还会收起，等于点一下就断一次思路。
 *      所以 touchstart/mousedown 一律 preventDefault，只接管行为。
 *   2. **只在触摸设备上出现**。桌面有物理键盘，多一条是干扰。
 *   3. **能收起**。手机屏幕纵向宝贵，键条吃掉的每一像素都是代码区。
 *
 * 不接管输入法本身 —— 那是系统的事，网页碰不了，也不该碰。
 * 这里补的只是"输入法没有、但写代码必须有"的那部分键。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var LS_KEY = 'code-mobile-bar';

  /* 是不是触摸设备。粗指针 + 支持触摸 = 手机/平板。
     桌面触控屏是细腻指针，不该被误判。 */
  function isTouch() {
    try {
      var coarse = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
      var hasTouch = ('ontouchstart' in global) || (navigator.maxTouchPoints > 0);
      return !!(coarse && hasTouch);
    } catch (e) {
      return false;
    }
  }

  /* 键位表。分组渲染，常用组放前面。
     每个键：t=显示文字，k=要插入的文本，act=特殊动作，w=是否占两格宽 */
  var GROUPS = [
    {
      name: '编辑',
      keys: [
        { t: 'Tab', act: 'tab', w: 2 },
        { t: '←', act: 'left' },
        { t: '→', act: 'right' },
        { t: '↑', act: 'up' },
        { t: '↓', act: 'down' },
        { t: '⌫', act: 'backspace' },
        { t: '⏎', act: 'enter' }
      ]
    },
    {
      name: '符号',
      keys: [
        { t: '{', k: '{' }, { t: '}', k: '}' },
        { t: '(', k: '(' }, { t: ')', k: ')' },
        { t: '[', k: '[' }, { t: ']', k: ']' },
        { t: ';', k: ';' }, { t: ':', k: ':' },
        { t: '=', k: '=' }, { t: '<', k: '<' },
        { t: '>', k: '>' }, { t: '&', k: '&' },
        { t: '|', k: '|' }, { t: '!', k: '!' },
        { t: '"', k: '"' }, { t: "'", k: "'" },
        { t: '#', k: '#' }, { t: '/', k: '/' },
        { t: '\\', k: '\\' }, { t: '_', k: '_' },
        { t: '+', k: '+' }, { t: '-', k: '-' },
        { t: '*', k: '*' }, { t: '.', k: '.' },
        { t: ',', k: ',' }, { t: '$', k: '$' }
      ]
    },
    {
      name: '命令',
      keys: [
        { t: '全选', act: 'selectAll', w: 2 },
        { t: '复制', act: 'copy', w: 2 },
        { t: '剪切', act: 'cut', w: 2 },
        { t: '粘贴', act: 'paste', w: 2 },
        { t: '撤销', act: 'undo', w: 2 },
        { t: '保存', act: 'save', w: 2 },
        { t: '运行', act: 'run', w: 2 },
        { t: 'Esc', act: 'esc', w: 2 }
      ]
    }
  ];

  var bar = null, tabs = null, body = null, groupIdx = 0;
  var collapsed = false;

  function loadCollapsed() {
    try { return localStorage.getItem(LS_KEY) === 'off'; } catch (e) { return false; }
  }
  function saveCollapsed(v) {
    try { localStorage.setItem(LS_KEY, v ? 'off' : 'on'); } catch (e) { }
  }

  /* ---------- 动作 ---------- */
  function ta() {
    try {
      var ed = Code.editor;
      if (ed && ed.el) {
        var e = ed.el();
        return e && e.ta ? e.ta : null;
      }
    } catch (e) { }
    return null;
  }

  function insert(text) {
    var t = ta();
    if (!t) return;
    var s = t.selectionStart, en = t.selectionEnd;
    if (Code.editor && Code.editor.replace) {
      Code.editor.replace(s, en, text);
    } else {
      /* 编辑器接口不可用时的退路：直接操作，至少能用 */
      var v = t.value;
      t.value = v.slice(0, s) + text + v.slice(en);
      try { t.setSelectionRange(s + text.length, s + text.length); } catch (e) { }
    }
    try { t.focus({ preventScroll: true }); } catch (e) { }
  }

  function move(dir) {
    var t = ta();
    if (!t) return;
    var v = t.value, p = t.selectionStart;
    var np = p;
    if (dir === 'left') np = Math.max(0, p - 1);
    else if (dir === 'right') np = Math.min(v.length, p + 1);
    else if (dir === 'up' || dir === 'down') {
      var lb = v.lastIndexOf('\n', p - 1);
      var lineStart = lb + 1;
      /* 当前行内的列位置 */
      var col = p - lineStart;
      if (dir === 'up') {
        if (lineStart === 0) { np = 0; }
        else {
          var prevStart = v.lastIndexOf('\n', lineStart - 2) + 1;
          var prevLen = (lineStart - 1) - prevStart;
          np = prevStart + Math.min(col, prevLen);
        }
      } else {
        var nl = v.indexOf('\n', p);
        if (nl < 0) np = v.length;
        else {
          var nextStart = nl + 1;
          var nl2 = v.indexOf('\n', nextStart);
          var nextLen = (nl2 < 0 ? v.length : nl2) - nextStart;
          np = nextStart + Math.min(col, nextLen);
        }
      }
    } else return;
    try { t.focus({ preventScroll: true }); t.setSelectionRange(np, np); } catch (e) { }
    if (Code.editor && Code.editor.refresh) { try { Code.editor.refresh(); } catch (e) { } }
  }

  function delBack() {
    var t = ta();
    if (!t) return;
    var s = t.selectionStart, en = t.selectionEnd;
    if (s !== en) {
      if (Code.editor && Code.editor.replace) Code.editor.replace(s, en, '');
      else { t.value = t.value.slice(0, s) + t.value.slice(en); try { t.setSelectionRange(s, s); } catch (e) { } }
    } else if (s > 0) {
      if (Code.editor && Code.editor.replace) Code.editor.replace(s - 1, s, '');
      else { t.value = t.value.slice(0, s - 1) + t.value.slice(s); try { t.setSelectionRange(s - 1, s - 1); } catch (e) { } }
    }
    try { t.focus({ preventScroll: true }); } catch (e) { }
  }

  function doAct(a) {
    var t = ta();
    switch (a) {
      case 'tab':
        /* 用编辑器自己的缩进单元 —— 跟当前文件的风格一致 */
        var unit = '\t';
        try { if (Code.editor && Code.editor.indentUnit) unit = Code.editor.indentUnit(); } catch (e) { }
        insert(unit);
        return;
      case 'enter':
        /* 换行并继承上一行缩进，写 Python 时这是刚需 */
        var v2 = t ? t.value : '';
        var p2 = t ? t.selectionStart : 0;
        var lb2 = v2.lastIndexOf('\n', p2 - 1);
        var ind = (v2.slice(lb2 + 1, p2).match(/^[ \t]*/) || [''])[0];
        insert('\n' + ind);
        return;
      case 'left': case 'right': case 'up': case 'down': move(a); return;
      case 'backspace': delBack(); return;
      case 'selectAll':
        if (t) { try { t.focus({ preventScroll: true }); t.setSelectionRange(0, t.value.length); } catch (e) { } }
        return;
      case 'copy': case 'cut':
        /* 优先用系统剪贴板 API；失败就退回 execCommand */
        if (t) {
          var sel = t.value.slice(t.selectionStart, t.selectionEnd);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(sel).catch(function () { legacy(a); });
          } else legacy(a);
          if (a === 'cut' && sel) {
            if (Code.editor && Code.editor.replace) Code.editor.replace(t.selectionStart, t.selectionEnd, '');
          }
        }
        return;
      case 'paste':
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (txt) {
            if (txt != null) insert(txt);
          }).catch(function () { hint('浏览器不允许读取剪贴板，请长按输入框用系统粘贴'); });
        } else hint('此浏览器不支持读取剪贴板，请长按输入框用系统粘贴');
        return;
      case 'undo':
        /* 交回浏览器原生的撤销 —— execCommand 在多数移动浏览器上仍可用 */
        try { document.execCommand('undo'); } catch (e) { hint('撤销不可用'); }
        return;
      case 'save':
        if (Code.app && Code.app.exportZip) { /* 没有独立保存接口就用 toast 提示已自动保存 */ }
        hint('内容会自动保存');
        if (Code.ui && Code.ui.toast) Code.ui.toast('已自动保存');
        return;
      case 'run':
        if (Code.app && Code.app.run) { try { Code.app.run(); } catch (e) { } }
        return;
      case 'esc':
        if (Code.ui && Code.ui.closeModal) { try { Code.ui.closeModal(); } catch (e) { } }
        try { if (t) t.blur(); } catch (e) { }
        return;
    }
  }

  function legacy(which) {
    try { document.execCommand(which); } catch (e) { }
  }

  var hintTimer = null;
  function hint(msg) {
    if (!bar) return;
    var h = bar.querySelector('.mb-hint');
    if (!h) return;
    h.textContent = msg;
    h.style.opacity = '1';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { h.style.opacity = '0'; }, 2200);
  }

  /* ---------- 渲染 ---------- */
  function build() {
    bar = document.createElement('div');
    bar.className = 'mobile-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '移动端辅助键');

    /* 分组标签 */
    tabs = document.createElement('div');
    tabs.className = 'mb-tabs';
    body = document.createElement('div');
    body.className = 'mb-body';
    var hintEl = document.createElement('div');
    hintEl.className = 'mb-hint';
    hintEl.style.opacity = '0';

    GROUPS.forEach(function (g, i) {
      var b = document.createElement('button');
      b.className = 'mb-tab' + (i === 0 ? ' on' : '');
      b.textContent = g.name;
      /* 关键：不让按钮抢走焦点 */
      b.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { showGroup(i); });
      tabs.appendChild(b);
    });

    /* 收起/展开 */
    var toggle = document.createElement('button');
    toggle.className = 'mb-toggle';
    toggle.title = '收起键条';
    toggle.innerHTML = '<svg width="14" height="14"><use href="#i-chevron-down"/></svg>';
    toggle.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    toggle.addEventListener('mousedown', function (e) { e.preventDefault(); });
    toggle.addEventListener('click', function () { setCollapsed(!collapsed); });
    bar.__toggle = toggle;

    bar.appendChild(tabs);
    bar.appendChild(body);
    bar.appendChild(hintEl);
    bar.appendChild(toggle);

    document.body.appendChild(bar);
    /* 键盘条在就给 body 打标记，占位规则挂在这个类上而不是媒体查询上。
       为什么：键盘条的出现条件是"触摸设备"，跟屏幕宽度无关 ——
       iPad（768px 宽）也有键盘条，但它的宽度不匹配窄屏媒体查询，
       结果就是键盘条浮在内容上面盖住最后几行。 */
    document.body.classList.add('has-mb');
    showGroup(0);
  }

  function showGroup(i) {
    groupIdx = i;
    Array.prototype.forEach.call(tabs.children, function (b, k) {
      b.classList.toggle('on', k === i);
    });
    body.innerHTML = '';
    (GROUPS[i].keys || []).forEach(function (key) {
      var b = document.createElement('button');
      b.className = 'mb-key' + (key.w === 2 ? ' wide' : '');
      b.textContent = key.t;
      /* 核心：按下时不让输入框失焦。
         不 preventDefault 的话，textarea 会 blur，
         光标位置丢失、手机键盘收起 —— 点一下断一次思路。 */
      var down = function (e) { e.preventDefault(); };
      b.addEventListener('touchstart', down, { passive: false });
      b.addEventListener('mousedown', down);
      b.addEventListener('click', function (e) {
        e.preventDefault();
        if (key.k != null) insert(key.k);
        else if (key.act) doAct(key.act);
      });
      body.appendChild(b);
    });
  }

  function setCollapsed(v) {
    collapsed = v;
    saveCollapsed(v);
    if (!bar) return;
    bar.classList.toggle('off', v);
    var tg = bar.__toggle;
    if (tg) {
      tg.title = v ? '展开键条' : '收起键条';
      tg.innerHTML = '<svg width="14" height="14"><use href="#' +
        (v ? 'i-chevron-up' : 'i-chevron-down') + '"/></svg>';
    }
    /* 收起后给底部面板让出空间 */
    document.body.classList.toggle('mb-collapsed', v);
  }

  /* 只在触摸设备上装 */
  function init() {
    if (!isTouch()) return false;
    /* 打上 touch 标记：触摸目标的大小该由"是不是触摸设备"决定，
       而不是屏幕宽度 —— iPad 有 768px 宽，不匹配窄屏查询，
       但手指一样点不准 30px 的按钮。 */
    try { document.body.classList.add('touch'); } catch (e) { }
    if (bar) return true;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { build(); setCollapsed(loadCollapsed()); });
    } else {
      build(); setCollapsed(loadCollapsed());
    }
    return true;
  }

  Code.mobileBar = {
    init: init,
    isTouch: isTouch,
    setCollapsed: setCollapsed,
    _groups: GROUPS
  };
})(typeof window !== 'undefined' ? window : globalThis);
