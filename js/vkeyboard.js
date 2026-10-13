/* vkeyboard.js —— 内置虚拟键盘（不依赖系统输入法）
 *
 * 为什么要有它：
 *   手机系统输入法是给"聊天"设计的，写代码时处处别扭 ——
 *   没有 Tab、符号藏在三层菜单里、中英切换要来回点、
 *   自动纠错还会把变量名改掉。所以给 Code 配一个自己的键盘。
 *
 * 核心难点：怎么让系统输入法不弹出来。
 *   只用 inputmode="none" 在部分安卓 WebView 上无效；
 *   只设 readonly 又会让光标和选区在某些浏览器里丢失。
 *   这里两条一起上：inputmode="none" 负责大多数场合，
 *   readonly 在按下瞬间兜底（见 suppressNative 的注释）。
 *
 * 输入一律走 Code.editor.replace()，不直接改 textarea.value ——
 *   否则撤销栈、高亮、行号、自动保存全都不会触发，
 *   表现是"字打进去了但撤销没记录、保存后刷新又没了"。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var LS_ON = 'code_vkb_on';
  var bar = null, curPage = 'abc', shift = false, caps = false;
  var repeatTimer = null;

  /* ---------- 键位布局 ----------
     每页 4~5 行。k=插入文本，act=动作，w=相对宽度，ic=图标名 */
  var PAGES = {
    abc: [
      [
        { t: 'q', k: 'q' }, { t: 'w', k: 'w' }, { t: 'e', k: 'e' },
        { t: 'r', k: 'r' }, { t: 't', k: 't' }, { t: 'y', k: 'y' },
        { t: 'u', k: 'u' }, { t: 'i', k: 'i' }, { t: 'o', k: 'o' },
        { t: 'p', k: 'p' }
      ],
      [
        { t: 'a', k: 'a' }, { t: 's', k: 's' }, { t: 'd', k: 'd' },
        { t: 'f', k: 'f' }, { t: 'g', k: 'g' }, { t: 'h', k: 'h' },
        { t: 'j', k: 'j' }, { t: 'k', k: 'k' }, { t: 'l', k: 'l' }
      ],
      [
        { t: '⇧', act: 'shift', w: 1.4, cls: 'vk-mod' },
        { t: 'z', k: 'z' }, { t: 'x', k: 'x' }, { t: 'c', k: 'c' },
        { t: 'v', k: 'v' }, { t: 'b', k: 'b' }, { t: 'n', k: 'n' },
        { t: 'm', k: 'm' },
        { t: '⌫', act: 'backspace', w: 1.4, cls: 'vk-mod', repeat: true }
      ],
      [
        { t: '123', act: 'page:num', w: 1.3, cls: 'vk-mod' },
        { t: '#+', act: 'page:sym', w: 1.3, cls: 'vk-mod' },
        { t: ',', k: ',' }, { t: '.', k: '.' },
        { t: '空格', k: ' ', w: 2.6 },
        { t: '⏎', act: 'enter', w: 1.6, cls: 'vk-mod' }
      ]
    ],
    num: [
      [
        { t: '1', k: '1' }, { t: '2', k: '2' }, { t: '3', k: '3' },
        { t: '4', k: '4' }, { t: '5', k: '5' }, { t: '6', k: '6' },
        { t: '7', k: '7' }, { t: '8', k: '8' }, { t: '9', k: '9' },
        { t: '0', k: '0' }
      ],
      [
        { t: '-', k: '-' }, { t: '/', k: '/' }, { t: ':', k: ':' },
        { t: ';', k: ';' }, { t: '(', k: '(' }, { t: ')', k: ')' },
        { t: '$', k: '$' }, { t: '&', k: '&' }, { t: '@', k: '@' },
        { t: '"', k: '"' }
      ],
      [
        { t: '#+', act: 'page:sym', w: 1.4, cls: 'vk-mod' },
        { t: '.', k: '.' }, { t: ',', k: ',' }, { t: '?', k: '?' },
        { t: '!', k: '!' }, { t: "'", k: "'" }, { t: '_', k: '_' },
        { t: '⌫', act: 'backspace', w: 1.4, cls: 'vk-mod', repeat: true }
      ],
      [
        { t: 'abc', act: 'page:abc', w: 1.3, cls: 'vk-mod' },
        { t: '空格', k: ' ', w: 2.6 },
        { t: '⏎', act: 'enter', w: 1.6, cls: 'vk-mod' }
      ]
    ],
    sym: [
      [
        { t: '{', k: '{' }, { t: '}', k: '}' }, { t: '[', k: '[' },
        { t: ']', k: ']' }, { t: '(', k: '(' }, { t: ')', k: ')' },
        { t: '<', k: '<' }, { t: '>', k: '>' }, { t: '=', k: '=' }
      ],
      [
        { t: '+', k: '+' }, { t: '-', k: '-' }, { t: '*', k: '*' },
        { t: '/', k: '/' }, { t: '%', k: '%' }, { t: '!', k: '!' },
        { t: '?', k: '?' }, { t: '|', k: '|' }, { t: '^', k: '^' }
      ],
      [
        { t: '&', k: '&' }, { t: '#', k: '#' }, { t: '~', k: '~' },
        { t: '`', k: '`' }, { t: '\\', k: '\\' }, { t: '"', k: '"' },
        { t: "'", k: "'" }, { t: ';', k: ';' }, { t: ':', k: ':' }
      ],
      [
        { t: 'abc', act: 'page:abc', w: 1.3, cls: 'vk-mod' },
        { t: 'Tab', act: 'tab', w: 1.5, cls: 'vk-mod' },
        { t: '空格', k: ' ', w: 1.8 },
        { t: '⌫', act: 'backspace', w: 1.2, cls: 'vk-mod', repeat: true }
      ]
    ],
    fn: [
      [
        { t: '←', act: 'left', repeat: true }, { t: '→', act: 'right', repeat: true },
        { t: '↑', act: 'up', repeat: true }, { t: '↓', act: 'down', repeat: true }
      ],
      [
        { t: 'Home', act: 'home' }, { t: 'End', act: 'end' },
        { t: 'PgUp', act: 'pgup' }, { t: 'PgDn', act: 'pgdn' }
      ],
      [
        { t: '全选', act: 'selectAll' }, { t: '复制', act: 'copy' },
        { t: '剪切', act: 'cut' }, { t: '粘贴', act: 'paste' }
      ],
      [
        { t: '撤销', act: 'undo' }, { t: '重做', act: 'redo' },
        { t: '保存', act: 'save' }, { t: '运行', act: 'run' }
      ],
      [
        { t: 'abc', act: 'page:abc', cls: 'vk-mod' },
        { t: 'Esc', act: 'esc', cls: 'vk-mod' },
        { t: '⌫', act: 'backspace', cls: 'vk-mod', repeat: true }
      ]
    ]
  };

  function ta() {
    try {
      var ed = Code.editor;
      if (ed && ed.el) { var e = ed.el(); return (e && e.ta) ? e.ta : null; }
    } catch (e) { }
    return null;
  }

  /* ---------- 阻止系统输入法 ----------
     编辑区本身设了 inputmode="none"（见 index.html）。
     安卓部分 WebView 不认这个属性，所以在触摸设备上再补一道：
     按下瞬间置 readonly 再立刻恢复。置 readonly 会让键盘收起，
     恢复后光标位置由 editor 的 sel() 记着，不会丢。 */
  function suppressNative() {
    var t = ta();
    if (!t) return;
    try {
      t.setAttribute('readonly', 'readonly');
      setTimeout(function () { t.removeAttribute('readonly'); }, 0);
    } catch (e) { }
  }

  /* ---------- 文本操作：一律走 editor 接口 ---------- */
  function ins(text) {
    var ed = Code.editor;
    if (!ed) return;
    var s = ed.sel();
    ed.replace(s[0], s[1], text);
    var t = ta();
    if (t) { try { t.focus({ preventScroll: true }); } catch (e) { } }
  }

  function indentUnit() {
    try { return (Code.editor && Code.editor.indentUnit) ? Code.editor.indentUnit() : '\t'; }
    catch (e) { return '\t'; }
  }

  function backspace() {
    var ed = Code.editor;
    if (!ed) return;
    var s = ed.sel();
    if (s[0] !== s[1]) { ed.replace(s[0], s[1], ''); return; }
    if (s[0] <= 0) return;
    ed.replace(s[0] - 1, s[0], '');
  }

  function del() {
    var ed = Code.editor;
    if (!ed) return;
    var s = ed.sel();
    var t = ta();
    var len = t ? t.value.length : 0;
    if (s[0] !== s[1]) { ed.replace(s[0], s[1], ''); return; }
    if (s[0] >= len) return;
    ed.replace(s[0], s[0] + 1, '');
  }

  /* 换行并继承上一行缩进 —— 写 Python 时这是刚需。
     额外做两件事，因为手写缩进在手机上太麻烦：
       1. 上一行以 { [ ( 或 : 结尾 → 多缩进一级（块开始）
       2. 光标正好在成对括号中间 → 空出一行并把右括号挪下去
     不做的：自动补右括号。补全容易在删改时留下孤儿括号，
     反而更烦 —— 这里的括号配对只在你主动按左括号时插入一对。 */
  function newline() {
    var t = ta(), ed = Code.editor;
    if (!t || !ed) return;
    var s = ed.sel();
    var v = t.value;
    var lb = v.lastIndexOf('\n', s[0] - 1);
    var line = v.slice(lb + 1, s[0]);
    var ind = (line.match(/^[ \t]*/) || [''])[0];
    var unit = indentUnit();

    /* 光标在 ")"/"}" 之前且本行开头有对应的 "(" → 中间空一行 */
    var nextCh = v.charAt(s[0]);
    var prevCh = v.charAt(s[0] - 1);
    if ((nextCh === ')' && prevCh === '(') ||
        (nextCh === '}' && prevCh === '{') ||
        (nextCh === ']' && prevCh === '[')) {
      ed.replace(s[0], s[1], '\n' + ind + unit + '\n' + ind, s[0] + 1 + ind.length + unit.length, s[0] + 1 + ind.length + unit.length);
      return;
    }

    /* 块开始：多缩进一级 */
    var trimmed = line.replace(/\s+$/, '');
    if (/[{[(]$/.test(trimmed) || /:\s*$/.test(trimmed)) {
      ed.replace(s[0], s[1], '\n' + ind + unit);
      /* 顺手补上收尾的右括号：块都开了，闭合符早晚要打 */
      var close = /\{$/.test(trimmed) ? '}' : (/\[$/.test(trimmed) ? ']' : (/\($/.test(trimmed) ? ')' : ''));
      if (close) {
        var pos2 = s[0] + 1 + ind.length + unit.length;
        ed.replace(pos2, pos2, '\n' + ind + close, pos2, pos2);
      }
      return;
    }

    ed.replace(s[0], s[1], '\n' + ind);
  }

  /* ---------- 光标移动 ---------- */
  function move(act) {
    var t = ta(), ed = Code.editor;
    if (!t || !ed) return;
    var v = t.value, s = ed.sel(), p = s[0], np = p;

    function col(p) { var lb = v.lastIndexOf('\n', p - 1); return p - (lb + 1); }
    function lineStart(p) { return v.lastIndexOf('\n', p - 1) + 1; }

    if (act === 'left') np = Math.max(0, p - 1);
    else if (act === 'right') np = Math.min(v.length, p + 1);
    else if (act === 'up' || act === 'down') {
      var ls = lineStart(p), c = col(p);
      if (act === 'up') {
        if (ls === 0) np = 0;
        else {
          var ps = v.lastIndexOf('\n', ls - 2) + 1;
          var plen = (ls - 1) - ps;
          np = ps + Math.min(c, plen);
        }
      } else {
        var nl = v.indexOf('\n', p);
        if (nl < 0) np = v.length;
        else {
          var ns = nl + 1, nl2 = v.indexOf('\n', ns);
          var nlen = (nl2 < 0 ? v.length : nl2) - ns;
          np = ns + Math.min(c, nlen);
        }
      }
    } else if (act === 'home') np = lineStart(p);
    else if (act === 'end') {
      var e1 = v.indexOf('\n', p);
      np = e1 < 0 ? v.length : e1;
    } else if (act === 'pgup' || act === 'pgdn') {
      /* 一屏按 20 行算，够用又不会跳太远 */
      var lines = v.split('\n'), i = 0, acc = 0;
      while (i < lines.length && acc + lines[i].length + 1 <= p) { acc += lines[i].length + 1; i++; }
      var target = Math.max(0, Math.min(lines.length - 1, i + (act === 'pgup' ? -20 : 20)));
      var base = 0;
      for (var j = 0; j < target; j++) base += lines[j].length + 1;
      np = base + Math.min(col(p), lines[target].length);
    } else return;

    try { t.focus({ preventScroll: true }); t.setSelectionRange(np, np); } catch (e) { }
    if (ed.refresh) { try { ed.refresh(); } catch (e) { } }
  }

  function act(a) {
    var t = ta(), ed = Code.editor;
    switch (a) {
      case 'backspace': backspace(); return;
      case 'del': del(); return;
      case 'enter': newline(); return;
      case 'tab': ins(indentUnit()); return;
      case 'left': case 'right': case 'up': case 'down':
      case 'home': case 'end': case 'pgup': case 'pgdn': move(a); return;
      case 'selectAll':
        if (t) { try { t.focus({ preventScroll: true }); t.setSelectionRange(0, t.value.length); } catch (e) { } }
        return;
      case 'copy': case 'cut':
        if (!t) return;
        var selTxt = t.value.slice(t.selectionStart, t.selectionEnd);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(selTxt).catch(function () { try { document.execCommand(a); } catch (e) { } });
        } else { try { document.execCommand(a); } catch (e) { } }
        if (a === 'cut' && selTxt && ed) {
          var s2 = ed.sel(); ed.replace(s2[0], s2[1], '');
        }
        return;
      case 'paste':
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (x) { if (x != null) ins(x); })
            .catch(function () { hint('无法读取剪贴板'); });
        } else hint('此浏览器不支持读取剪贴板');
        return;
      /* ⚠ 不能走 document.execCommand('undo')（S-104）。
         编辑器自研撤销栈的原因（editor.js 注释里写着）正是
         "程序化赋值会破坏浏览器原生栈"—— 而虚拟键盘的输入**全是**程序化赋值。
         于是：①原生栈里没有这些记录，按了没反应；
              ②execCommand 改 ta.value 不触发 input 事件，
                cur.content 与 textarea 不同步，下一次保存会把旧内容写回。
         同一个功能两条路径、行为互不一致，必须统一走自研栈。 */
      case 'undo':
        if (Code.editor && Code.editor.undo) { try { Code.editor.undo(); } catch (e) { hint('撤销不可用'); } }
        else { try { document.execCommand('undo'); } catch (e) { hint('撤销不可用'); } }
        return;
      case 'redo':
        if (Code.editor && Code.editor.redo) { try { Code.editor.redo(); } catch (e) { hint('重做不可用'); } }
        else { try { document.execCommand('redo'); } catch (e) { hint('重做不可用'); } }
        return;
      case 'save':
        if (Code.ui && Code.util.toast) Code.util.toast('内容会自动保存');
        return;
      case 'run':
        if (Code.app && Code.app.run) { try { Code.app.run(); } catch (e) { } }
        return;
      case 'esc':
        try { if (Code.ui && Code.ui.closeModal) Code.ui.closeModal(); } catch (e) { }
        try { if (t) t.blur(); } catch (e) { }
        return;
    }
  }

  var hintTimer = null;
  function hint(msg) {
    var h = bar && bar.querySelector('.vk-hint');
    if (!h) return;
    h.textContent = msg; h.style.opacity = '1';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { h.style.opacity = '0'; }, 2000);
  }

  /* ---------- 渲染 ---------- */
  function build() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'vkb';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', '内置键盘');

    var hintEl = document.createElement('div');
    hintEl.className = 'vk-hint';
    hintEl.style.opacity = '0';

    var pages = document.createElement('div');
    pages.className = 'vk-pages';

    var body = document.createElement('div');
    body.className = 'vk-body';

    bar.appendChild(hintEl);
    bar.appendChild(pages);
    bar.appendChild(body);
    document.body.appendChild(bar);

    /* 页面切换标签 */
    [['abc', 'abc'], ['num', '123'], ['sym', '#+'], ['fn', '功能']].forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'vk-page' + (p[0] === curPage ? ' on' : '');
      b.textContent = p[1];
      b.setAttribute('data-page', p[0]);
      bind(b, function () { showPage(p[0]); });
      pages.appendChild(b);
    });

    var saved = null;
    try { saved = localStorage.getItem('code_vkb_page'); } catch (e) { }
    showPage((saved && PAGES[saved]) ? saved : curPage);
    document.body.classList.add('has-vkb');
  }

  /* 按下即阻止默认 —— 否则 textarea 失焦、光标丢、系统键盘弹出 */
  function bind(el, fn, opts) {
    var down = function (e) { e.preventDefault(); };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('mousedown', down);
    el.addEventListener('click', function (e) { e.preventDefault(); fn(); });
    if (opts && opts.repeat) {
      var start = function (e) {
        e.preventDefault();
        fn();
        clearTimeout(repeatTimer);
        repeatTimer = setTimeout(function loop() {
          fn();
          repeatTimer = setTimeout(loop, 70);
        }, 400);
      };
      var stop = function () { clearTimeout(repeatTimer); repeatTimer = null; };
      el.addEventListener('touchstart', start, { passive: false });
      el.addEventListener('mousedown', start);
      el.addEventListener('touchend', stop);
      el.addEventListener('mouseup', stop);
      el.addEventListener('mouseleave', stop);
      el.addEventListener('touchcancel', stop);
    }
  }

  function showPage(p) {
    curPage = p;
    /* 记住上次用的页面：写代码时大多数人停在符号页，
       每次打开都跳回 abc 要手动切一次，很烦。 */
    try { localStorage.setItem('code_vkb_page', p); } catch (e) { }
    var body = bar && bar.querySelector('.vk-body');
    if (!body) return;
    Array.prototype.forEach.call(bar.querySelectorAll('.vk-page'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-page') === p);
    });
    body.innerHTML = '';
    (PAGES[p] || []).forEach(function (row) {
      var r = document.createElement('div');
      r.className = 'vk-row';
      row.forEach(function (k) {
        var b = document.createElement('button');
        b.className = 'vk-key' + (k.cls ? ' ' + k.cls : '');
        if (k.w) b.style.flexGrow = String(k.w);
        b.textContent = labelOf(k);
        b.setAttribute('data-k', k.k != null ? k.k : '');
        b.setAttribute('data-act', k.act || '');
        bind(b, function () { press(k); }, { repeat: !!k.repeat });
        r.appendChild(b);
      });
      body.appendChild(r);
    });
  }

  /* 大小写：字母键跟随 shift/caps，符号键不受影响 */
  function labelOf(k) {
    if (k.k == null || !/^[a-z]$/.test(k.k)) return k.t;
    return (shift || caps) ? k.k.toUpperCase() : k.k;
  }

  /* 成对符号：按左半边时把右半边一起插进去，光标停中间。
     直接跳过：如果光标右边已经是同一个右半边，说明它已经在那儿了，
     再插一个会变成 "))"。 */
  var PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };

  function insertWithPair(ch) {
    var ed = Code.editor, t = ta();
    if (!ed || !t) { ins(ch); return; }
    var s = ed.sel();
    var close = PAIRS[ch];
    if (!close) { ins(ch); return; }
    /* 有选区：把选区包起来 */
    if (s[0] !== s[1]) {
      var mid = t.value.slice(s[0], s[1]);
      ed.replace(s[0], s[1], ch + mid + close, s[0] + 1, s[0] + 1 + mid.length);
      return;
    }
    if (t.value.charAt(s[0]) === close) { ins(ch); return; }
    ed.replace(s[0], s[1], ch + close, s[0] + 1, s[0] + 1);
  }

  function press(k) {
    suppressNative();
    if (k.k != null) {
      var s = /^[a-z]$/.test(k.k) && (shift || caps) ? k.k.toUpperCase() : k.k;
      if (PAIRS[s]) { insertWithPair(s); }
      else ins(s);
      /* shift 是一次性的；caps 是持续的 */
      if (shift && !caps) { shift = false; renderLabels(); }
      return;
    }
    if (k.act) {
      if (k.act === 'shift') {
        shift = !shift;
        if (shift && caps) caps = false;
        renderLabels();
        return;
      }
      var m = /^page:(.+)$/.exec(k.act);
      if (m) { showPage(m[1]); return; }
      act(k.act);
    }
  }

  /* 只改文字不改结构 —— 重建整页会打断正在进行的长按 */
  function renderLabels() {
    if (!bar) return;
    Array.prototype.forEach.call(bar.querySelectorAll('.vk-key'), function (b) {
      var k = b.getAttribute('data-k');
      if (k && /^[a-z]$/.test(k)) b.textContent = (shift || caps) ? k.toUpperCase() : k;
    });
    var sb = bar.querySelector('[data-act="shift"]');
    if (sb) sb.classList.toggle('on', shift || caps);
  }

  /* ---------- 开关 ---------- */
  function loadOn() {
    try { return localStorage.getItem(LS_ON) === 'on'; } catch (e) { return false; }
  }
  function setOn(v) {
    try { localStorage.setItem(LS_ON, v ? 'on' : 'off'); } catch (e) { }
    if (v) { build(); } else if (bar) { bar.classList.add('off'); document.body.classList.remove('has-vkb'); }
    else { document.body.classList.remove('has-vkb'); }
    if (v && bar) bar.classList.remove('off');
    /* 通知移动键条：两套并存会互相挡 */
    try { if (Code.mobileBar) Code.mobileBar.onVkbChange && Code.mobileBar.onVkbChange(v); } catch (e) { }
  }
  function isOn() { return !!bar && !bar.classList.contains('off'); }

  /* 首次提示：内置键盘藏在设计里没人会发现。
     触摸设备上提示一次，用户选过就不再问（不管选开还是选关）。
     不自动开启 —— 换掉别人的输入法默认行为是很大的改变，
     该由用户自己决定。 */
  var LS_ASKED = 'code_vkb_asked';

  function maybeOffer() {
    try { if (localStorage.getItem(LS_ASKED)) return; } catch (e) { return; }
    if (loadOn()) return;
    var touch = false;
    try {
      touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) &&
              (('ontouchstart' in window) || navigator.maxTouchPoints > 0);
    } catch (e) { }
    if (!touch) return;

    var done = function () {
      try { localStorage.setItem(LS_ASKED, '1'); } catch (e) { }
    };
    var yes = function () { setOn(true); done(); };
    var no = function () { done(); };

    try {
      if (Code.ui && Code.util.modal) {
        Code.util.modal({
          title: '用内置键盘写代码？',
          body: '<p class="about-p">系统输入法是给聊天设计的：没有 Tab、符号要翻页、' +
            '自动纠错还会改掉变量名。</p>' +
            '<p class="about-p">Code 自带一个写代码的键盘，开启后系统输入法不再弹出。</p>' +
            '<p class="about-p">随时可以在设置里改回来。</p>',
          actions: [
            { label: '先用系统输入法', primary: true, onClick: no },
            { label: '开启内置键盘', onClick: yes }
          ]
        });
      } else if (window.confirm('开启 Code 内置键盘？（写码更顺手，可在设置里关闭）')) yes(); else no();
    } catch (e) { }
  }

  Code.vkb = {
    setOn: setOn, isOn: isOn, loadOn: loadOn,
    showPage: showPage, maybeOffer: maybeOffer,
    PAGES: PAGES,
    _build: build
  };
})(typeof window !== 'undefined' ? window : globalThis);
