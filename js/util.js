/* util.js —— 通用小工具
   约定：全局挂到 window.Code.util，不使用模块语法，
   以便本地直接双击打开（file://）与 Pages 上线表现一致。 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});
  var U = {};

  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  U.el = function (tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  };

  U.esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  U.fmtSize = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  };

  U.debounce = function (fn, ms) {
    var t = null;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  };

  U.raf = function (fn) {
    var pending = false, lastArgs = null;
    return function () {
      lastArgs = arguments;
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; fn.apply(null, lastArgs); });
    };
  };

  U.basename = function (p) { var i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); };
  U.dirname = function (p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  U.join = function (a, b) { return a ? a + '/' + b : b; };

  U.normPath = function (p) {
    var parts = String(p || '').split('/').filter(function (s) { return s && s !== '.'; });
    var out = [];
    parts.forEach(function (s) {
      if (s === '..') out.pop(); else out.push(s);
    });
    return out.join('/');
  };

  /* 语言识别：按扩展名。未知一律按纯文本处理。 */
  var EXT_MAP = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'javascript', json: 'json',
    html: 'html', htm: 'html', svg: 'html', xml: 'html',
    css: 'css', scss: 'css', less: 'css',
    py: 'python', pyw: 'python',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'cpp', h: 'cpp', hpp: 'cpp',
    md: 'markdown', markdown: 'markdown',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    txt: 'text', log: 'text', csv: 'text', yml: 'yaml', yaml: 'yaml',
    sql: 'sql', php: 'php',
    /* E-049：Lua 与 Ruby 能跑（扩展中心可下载运行时）、着色规则也写好了，
       唯独这里漏了两个键 —— 于是 langOf() 回退 'text'，
       用户花 1.6 MB 下载 Lua 运行时，编辑器却当他写的是纯文本。
       E-050：反过来，java/go/rust 在这里声明了，但 highlight.js 里
       根本没有对应规则，状态栏却显示"Java/Go/Rust"，等于骗人。
       既然没有着色规则，就别声明 —— 老实显示"纯文本"比假装有支持强。
       这两条是同一个根因：语言表散在 lang / highlight / util 三处各维护各的，
       详见下面的一致性断言（tests 里也有）。 */
    lua: 'lua', rb: 'ruby'
  };
  U.langOf = function (path) {
    var n = U.basename(String(path || '')).toLowerCase();
    var i = n.lastIndexOf('.');
    if (i < 0) return 'text';
    return EXT_MAP[n.slice(i + 1)] || 'text';
  };
  U.LANG_LABEL = {
    javascript: 'JavaScript', json: 'JSON', html: 'HTML', css: 'CSS',
    python: 'Python', cpp: 'C/C++', markdown: 'Markdown', shell: 'Shell',
    text: '纯文本', yaml: 'YAML', sql: 'SQL', php: 'PHP',
    lua: 'Lua', ruby: 'Ruby'
  };
  /* 状态栏显示名只在"真有规则或真能跑"的语言里列，
     java/go/rust 已从 EXT_MAP 移除（无着色规则），这里也不再列。 */

  /* 字节数按 UTF-8 计 */
  U.byteLen = function (s) {
    var n = 0, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  };

  U.uid = function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  /* ---------- 轻提示 ---------- */
  var toastTimer = null;
  /* HTML 转义。**任何**来自外部的值（服务端返回的昵称、文件名、代码内容等）
     拼进 innerHTML 前都必须过这一道。
     为什么单独抽出来：转义函数散在各文件里，就会出现"有的地方转了有的没转"，
     而漏掉的那一处就是漏洞 —— 且看代码的人分不出哪个是哪个。
     统一到 U.esc，之后只要 grep `innerHTML` 附近有没有 U.esc 就能查。
     ⚠ 只做字符转义，**不做协议校验** —— 拼进 href/src 时还要另走 safeURL。 */
  U.esc = function (v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  /* 只允许 http/https —— 挡掉 javascript: 与 data: 这类伪协议。
     ⚠ 光有 U.esc 挡不住 javascript: —— 它在 HTML 里是合法字符串，
       真正执行是在浏览器解析 href/src 的时候。所以两者必须搭配。 */
  U.safeURL = function (u) {
    return /^https?:\/\//i.test(String(u || '').trim());
  };

  U.toast = function (msg, kind) {
    var t = U.$('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = kind || '';
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  };

  /* ---------- 右键菜单（自绘，无第三方组件） ---------- */
  var menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  U.menu = function (x, y, items) {
    closeMenu();
    var m = U.el('div', { class: 'menu' });
    (items || []).forEach(function (it) {
      if (!it) return;
      var b = U.el('button', { class: 'menu-item', text: it.label });
      b.onclick = function () { closeMenu(); it.act && it.act(); };
      m.appendChild(b);
    });
    m.style.left = x + 'px'; m.style.top = y + 'px';
    document.body.appendChild(m);
    var r = m.getBoundingClientRect();
    if (r.right > innerWidth) m.style.left = Math.max(0, innerWidth - r.width - 6) + 'px';
    if (r.bottom > innerHeight) m.style.top = Math.max(0, innerHeight - r.height - 6) + 'px';
    menuEl = m;
    setTimeout(function () {
      document.addEventListener('mousedown', onceAway);
      document.addEventListener('keydown', onceEsc);
    }, 0);
  };
  function onceAway(e) { if (menuEl && !menuEl.contains(e.target)) { closeMenu(); off(); } }
  function onceEsc(e) { if (e.key === 'Escape') { closeMenu(); off(); } }
  function off() {
    document.removeEventListener('mousedown', onceAway);
    document.removeEventListener('keydown', onceEsc);
  }

  /* ---------- 模态框 ---------- */
  /* 用法：
     U.modal({title, body(HTML), inputs:[{name,label,value,placeholder}],
              actions:[{label, primary, onClick(close, values)}]}) */
  /* 对话框是复用的同一个 #modal，一次只能有一个。
     于是有个坑：在按钮的 onClick 里再开一个对话框时，
     外层按钮处理器执行完会紧接着 close() —— 把刚打开的那个关掉。
     表现为"第二个对话框一闪就没了"，而这正是确认链（确认 → 二次确认）会走的路径。
     所以用 token 标记"当前有效的是哪一个"：
     关闭时若发现自己已经过期（期间又开了新的），就不动手。 */
  var modalToken = 0;

  U.modal = function (opt) {
    var box = U.$('#modal'), title = U.$('#modal-title'),
      content = U.$('#modal-content'), actions = U.$('#modal-actions');
    var myToken = ++modalToken;
    title.textContent = opt.title || '提示';
    content.innerHTML = opt.body || '';
    var fields = {};
    (opt.inputs || []).forEach(function (f) {
      var wrap = U.el('div', { class: 'field' });
      if (f.label) wrap.appendChild(U.el('label', { text: f.label }));
      var input;
      if (f.type === 'select') {
        input = U.el('select');
        (f.options || []).forEach(function (o) {
          var op = U.el('option', { value: o.value, text: o.label });
          if (o.value === f.value) op.selected = true;
          input.appendChild(op);
        });
      } else {
        input = U.el('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '' });
      }
      wrap.appendChild(input);
      content.appendChild(wrap);
      fields[f.name] = input;
    });
    actions.innerHTML = '';
    (opt.actions || [{ label: '知道了' }]).forEach(function (a) {
      actions.appendChild(U.el('button', {
        class: 'btn' + (a.primary ? ' primary' : ''),
        text: a.label,
        onclick: function () {
          var vals = {};
          for (var k in fields) vals[k] = fields[k].value;
          if (a.onClick) { if (a.onClick(close, vals) === false) return; }
          close();
        }
      }));
    });
    /* E-054：以前关闭时只隐藏、不恢复焦点。焦点留在已经隐藏的对话框元素上，
       此时直接敲字进不了编辑器，用户会先以为卡了。
       所以记下打开前的焦点元素，关闭时还回去；还不了就退回编辑器。
       为什么不放进 finally：有些按钮要在 onClick 里 return false 保持打开，
       那时不该抢焦点。 */
    var prevFocus = null;
    try { prevFocus = document.activeElement; } catch (e) { }

    function restoreFocus() {
      try {
        var ed = Code && Code.editor ? Code.editor.el && Code.editor.el() : null;
        var ta = ed && ed.ta ? ed.ta : null;
        if (prevFocus && prevFocus.focus && document.contains(prevFocus)) {
          prevFocus.focus({ preventScroll: true });
        } else if (ta && ta.focus) {
          ta.focus({ preventScroll: true });
        }
      } catch (e) { }
    }

    function close() {
      /* 期间又开了新的对话框 → 我已经不是当前那个，别把新的关掉 */
      if (myToken !== modalToken) return;
      box.classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      restoreFocus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    box.classList.remove('hidden');
    box.querySelectorAll('[data-close]').forEach(function (m) {
      m.onclick = close;
    });
    var first = content.querySelector('input,select');
    if (first) first.focus();
    return close;
  };

  /* 下载：把 Blob 存成文件（本地与线上同一条路径） */
  U.download = function (filename, blob) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  };

  U.readFileAsText = function (file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result)); };
      r.onerror = function () { rej(r.error || new Error('读取失败')); };
      r.readAsText(file);
    });
  };

  U.readFileAsArrayBuffer = function (file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('读取失败')); };
      r.readAsArrayBuffer(file);
    });
  };

  /* 图标：引用页内的 SVG symbol（图标全部为本仓库自绘，不引第三方图标包） */
  var NS = 'http://www.w3.org/2000/svg';
  U.svg = function (id, size) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', size || 16);
    s.setAttribute('height', size || 16);
    s.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS(NS, 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  };

  Code.util = U;
})(window);
