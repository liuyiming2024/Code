/* editor.js —— 编辑内核
   做法：一个透明 textarea 叠在着色层之上，滚动位置与行号互相同步。
   不依赖任何编辑器库，IME 可用（合成期间不接管按键）。 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});
  var U = Code.util, HL = Code.highlight, store = Code.store, fs = Code.fs;

  var el = {};              // DOM 引用
  var docs = {};            // path -> {content, undo, redo, sel, scroll}
  var cur = null;           // 当前文档对象
  var lineH = 22, padTop = 10;
  var handlers = { change: [], cursor: [], save: [] };
  var saveTimer = null, rafId = 0;

  function on(evt, fn) { (handlers[evt] || (handlers[evt] = [])).push(fn); }
  function emit(evt, a, b) { (handlers[evt] || []).forEach(function (f) { try { f(a, b); } catch (e) { } }); }

  function init() {
    el.scroll = U.$('#editor-scroll');
    el.gutter = U.$('#gutter');
    el.area = U.$('#code-area');
    el.hl = U.$('#highlight');
    el.ta = U.$('#editor');
    el.crumb = U.$('#breadcrumb');

    el.ta.addEventListener('input', onInput);
    el.ta.addEventListener('keydown', onKey);
    el.ta.addEventListener('click', syncAll);
    el.ta.addEventListener('keyup', function (e) { if (e.key.indexOf('Arrow') === 0 || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') syncAll(); });
    el.ta.addEventListener('scroll', function () { syncScroll(); });
    el.ta.addEventListener('compositionstart', function () { el.ta.dataset.ime = '1'; });
    el.ta.addEventListener('compositionend', function () { delete el.ta.dataset.ime; onInput(); });
    el.ta.addEventListener('blur', function () { flushSave(); });
    applyPrefs();
  }

  function applyPrefs() {
    var p = store.prefs;
    document.documentElement.style.setProperty('--font-size', p.fontSize + 'px');
    el.ta.classList.toggle('wrap', !!p.wordWrap);
    el.hl.classList.toggle('wrap', !!p.wordWrap);
    el.ta.style.tabSize = p.tabSize;
    el.hl.style.tabSize = p.tabSize;
    measure();
    if (cur) { paint(); renderGutter(); }
  }

  function measure() {
    var cs = getComputedStyle(el.ta);
    var lh = parseFloat(cs.lineHeight);
    lineH = isFinite(lh) && lh > 0 ? lh : parseFloat(cs.fontSize) * 1.55;
    padTop = parseFloat(cs.paddingTop) || 10;
  }

  /* ---------- 文档管理 ---------- */

  function docOf(path) {
    if (!docs[path]) docs[path] = { path: path, content: '', undo: [], redo: [], sel: [0, 0], scroll: 0 };
    return docs[path];
  }

  function open(path) {
    if (cur && cur.path === path) { el.ta.focus(); return Promise.resolve(); }
    return Promise.resolve(fs.read(path)).then(function (text) {
      if (text == null) text = '';
      cur = docOf(path);
      cur.content = text;
      /* 打开文件就检测它自己的缩进风格，只对这一个文件生效。
         检测不出来会返回 null，那时继续用用户原本的偏好。 */
      if (Code.styleAdapt) Code.styleAdapt.apply(path, text);
      endSnippet();
      el.ta.value = text;
      el.ta.disabled = false;
      el.ta.scrollTop = cur.scroll || 0;
      try { el.ta.setSelectionRange(cur.sel[0], cur.sel[1]); } catch (e) { }
      /* 面包屑分隔符用图标，不用文本箭头 */
      el.crumb.innerHTML = '';
      path.split('/').forEach(function (seg, i, arr) {
        if (i) el.crumb.appendChild(U.svg('i-chevron-right', 11));
        var b = document.createElement('b');
        b.textContent = seg;
        el.crumb.appendChild(b);
      });
      paint(); renderGutter(); syncScroll();
      emit('cursor', caretInfo());
      return text;
    });
  }

  function close(path) { delete docs[path]; if (cur && cur.path === path) cur = null; }

  function current() { return cur ? cur.path : null; }
  function value() { return cur ? cur.content : ''; }

  function setValue(text, keepUndo) {
    if (!cur) return;
    pushUndo(!keepUndo);
    cur.content = text;
    el.ta.value = text;
    paint(); renderGutter(); syncScroll();
    queueSave();
    emit('change', cur.path, text);
  }

  /* ---------- 撤销栈（自研，因为程序化赋值会破坏浏览器原生栈） ---------- */

  function snapshot() {
    return { v: cur.content, s: el.ta.selectionStart, e: el.ta.selectionEnd, top: el.ta.scrollTop };
  }
  function pushUndo(coalesce) {
    if (!cur) return;
    var snap = snapshot();
    var last = cur.undo[cur.undo.length - 1];
    if (coalesce && last && Math.abs(last.v.length - snap.v.length) < 3) return;
    cur.undo.push(snap);
    if (cur.undo.length > 300) cur.undo.shift();
    cur.redo.length = 0;
  }
  function applySnap(snap) {
    cur.content = snap.v;
    el.ta.value = snap.v;
    try { el.ta.setSelectionRange(snap.s, snap.e); } catch (e) { }
    el.ta.scrollTop = snap.top;
    paint(); renderGutter(); syncScroll();
    queueSave();
    emit('change', cur.path, snap.v);
    emit('cursor', caretInfo());
  }
  function undo() {
    if (!cur || !cur.undo.length) return;
    var snap = cur.undo.pop();
    cur.redo.push(snapshot());
    applySnap(snap);
  }
  function redo() {
    if (!cur || !cur.redo.length) return;
    var snap = cur.redo.pop();
    cur.undo.push(snapshot());
    applySnap(snap);
  }

  /* ---------- 渲染 ---------- */

  function paint() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      if (!cur) return;
      var lang = U.langOf(cur.path);
      var ln = cur.content.slice(0, el.ta.selectionStart).split('\n').length;
      el.hl.innerHTML = HL.render(cur.content, lang, ln, { showWS: !!store.prefs.showWS });
      el.hl.scrollTop = el.ta.scrollTop;
      el.hl.scrollLeft = el.ta.scrollLeft;
    });
  }

  /* ---------- 行高测量（自动换行时用） ----------
   * E-032：行号以前一律按 i * lineH 排布，隐含"每行高度都等于 lineH"。
   *   自动换行一开，一个逻辑行可能占 2~3 个视觉行高，行号仍按等行高递增，
   *   从第 1 个长行开始整体错位，越往下错得越狠。
   *   所以换行时用镜像元素逐行实测高度：给每行内容一个独立 div，
   *   读它的 offsetHeight 累加出真实偏移。
   *
   * 为什么用镜像而不是 getClientRects()：textarea 内部无法取到每行的 rect，
   *   只能靠一个样式完全一致的隐藏容器来量。样式不同步就会量错，
   *   所以下面把影响换行的那几个属性都复制过去。 */
  var mirror = null;

  function ensureMirror() {
    if (mirror) return mirror;
    try {
      mirror = document.createElement('div');
      mirror.setAttribute('aria-hidden', 'true');
      mirror.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;' +
        'left:-9999px;top:0;z-index:-1;';
      document.body.appendChild(mirror);
    } catch (e) { mirror = null; }
    return mirror;
  }

  function syncMirror() {
    var m = ensureMirror();
    if (!m || !el.ta) return null;
    try {
      var cs = window.getComputedStyle(el.ta);
      /* 只复制会影响换行的那些属性，其余不碰 */
      m.style.font = cs.font;
      m.style.fontFamily = cs.fontFamily;
      m.style.fontSize = cs.fontSize;
      m.style.lineHeight = cs.lineHeight;
      m.style.letterSpacing = cs.letterSpacing;
      m.style.whiteSpace = 'pre-wrap';
      m.style.wordBreak = cs.wordBreak;
      m.style.overflowWrap = cs.overflowWrap;
      m.style.padding = '0';
      m.style.border = 'none';
      /* 内容宽度要减掉左右内边距，否则换行位置会偏 */
      var w = el.ta.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
      m.style.width = Math.max(10, w) + 'px';
      m.style.boxSizing = 'content-box';
    } catch (e) { return null; }
    return m;
  }

  /* 返回每行的真实顶部偏移（长度 = 行数 + 1，末位是总高） */
  function measureTops(lines) {
    var m = syncMirror();
    var tops = [0];
    if (!m) return null;
    try {
      m.innerHTML = '';
      var frag = document.createDocumentFragment();
      var divs = [];
      for (var i = 0; i < lines.length; i++) {
        var d = document.createElement('div');
        /* 空行也要占一行高，用 <br> 撑起来，否则会被压成 0 */
        d.textContent = lines[i] === '' ? ' ' : lines[i];
        frag.appendChild(d);
        divs.push(d);
      }
      m.appendChild(frag);
      for (var j = 0; j < divs.length; j++) {
        tops.push(tops[j] + divs[j].offsetHeight);
      }
      return tops;
    } catch (e) { return null; }
  }

  function renderGutter() {
    if (!cur) return;
    var lines = cur.content.split('\n');
    var total = lines.length;
    var curLine = cur.content.slice(0, el.ta.selectionStart).split('\n').length;
    var html = '';

    /* 只有换行开启时才实测 —— 不换行时每行等高，用实测纯属浪费 */
    var wrapped = false;
    try { wrapped = !!(el.ta && el.ta.classList && el.ta.classList.contains('wrap')); } catch (e) { }

    if (!wrapped) {
      var view = Math.ceil(el.area.clientHeight / lineH) + 40;
      var top = Math.floor(el.ta.scrollTop / lineH);
      var start = Math.max(0, top - 20), end = Math.min(total, start + view);
      if (start > 0) html += '<div style="height:' + (start * lineH) + 'px"></div>';
      for (var i = start; i < end; i++) {
        html += '<div' + (i + 1 === curLine ? ' class="cur"' : '') + '>' + (i + 1) + '</div>';
      }
      if (end < total) html += '<div style="height:' + ((total - end) * lineH) + 'px"></div>';
      el.gutter.innerHTML = html;
      el.gutter.scrollTop = el.ta.scrollTop;
      return;
    }

    var tops = measureTops(lines);
    if (!tops) {
      /* 量不出来就退回等行高，并在设置旁注明可能不对齐（见 app.js） */
      var v2 = Math.ceil(el.area.clientHeight / lineH) + 40;
      var t2 = Math.floor(el.ta.scrollTop / lineH);
      var s2 = Math.max(0, t2 - 20), e2 = Math.min(total, s2 + v2);
      if (s2 > 0) html += '<div style="height:' + (s2 * lineH) + 'px"></div>';
      for (var k = s2; k < e2; k++) {
        html += '<div' + (k + 1 === curLine ? ' class="cur"' : '') + '>' + (k + 1) + '</div>';
      }
      el.gutter.innerHTML = html;
      el.gutter.scrollTop = el.ta.scrollTop;
      return;
    }

    /* 按实测偏移排布：行号行用绝对高度，空隙用占位块撑开 */
    if (tops[0] !== undefined) {
      var prevBottom = 0;
      for (var n = 0; n < total; n++) {
        var topn = tops[n], h = tops[n + 1] - topn;
        if (h <= 0) h = lineH;
        /* 超出可视区太远的跳过，避免一次生成几千个节点 */
        var vis = el.area.clientHeight || 600;
        if (topn > el.ta.scrollTop + vis + 800) break;
        if (topn + h < el.ta.scrollTop - 800) { prevBottom = topn + h; continue; }
        var gap = topn - prevBottom;
        if (gap > 0) html += '<div style="height:' + gap + 'px"></div>';
        html += '<div style="height:' + h + 'px;line-height:' + h + 'px"' +
          (n + 1 === curLine ? ' class="cur"' : '') + '>' + (n + 1) + '</div>';
        prevBottom = topn + h;
      }
    }
    el.gutter.innerHTML = html;
    el.gutter.scrollTop = el.ta.scrollTop;
  }

  function syncScroll() {
    el.hl.scrollTop = el.ta.scrollTop;
    el.hl.scrollLeft = el.ta.scrollLeft;
    el.gutter.scrollTop = el.ta.scrollTop;
    renderGutter();
  }
  function syncAll() { syncScroll(); paint(); renderGutter(); emit('cursor', caretInfo()); }

  function caretInfo() {
    if (!cur) return { line: 1, col: 1, len: 0, sel: 0 };
    var pos = el.ta.selectionStart;
    var before = cur.content.slice(0, pos);
    var lines = before.split('\n');
    var selLen = Math.abs(el.ta.selectionEnd - el.ta.selectionStart);
    return {
      line: lines.length,
      col: lines[lines.length - 1].length + 1,
      sel: selLen,
      len: cur.content.length,
      bytes: U.byteLen(cur.content),
      total: cur.content.split('\n').length
    };
  }

  /* ---------- 输入与按键 ---------- */

  function onInput() {
    if (!cur || el.ta.dataset.ime) return;
    pushUndo(true);
    cur.content = el.ta.value;
    paint(); renderGutter();
    queueSave();
    emit('change', cur.path, cur.content);
    emit('cursor', caretInfo());
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    if (!cur) return;
    cur.scroll = el.ta.scrollTop;
    try { cur.sel = [el.ta.selectionStart, el.ta.selectionEnd]; } catch (e) { }
    if (cur.saved === cur.content) return;
    cur.saved = cur.content;
    /* 写入失败必须向外传播：静默吞掉会让用户以为存住了，实际丢了。
       由调用方（app.js）负责告警并给出导出备份的出路。 */
    return fs.write(cur.path, cur.content).then(function () {
      emit('save', cur.path);
    });
  }

  /* 片段会话期间 Tab 只跳占位、完全不缩进。
     E-029：用户不知道自己进了这个模式，会以为 Tab 键坏了。
     所以在状态栏给一句可见提示，并说明怎么退出。 */
  function snippetHint(on) {
    try {
      var slot = U.$('#st-mode');
      if (!slot) return;
      if (on) {
        slot.textContent = '片段模式：Tab 跳下一个空，Esc 退出';
        slot.title = '正在片段展开中：Tab 跳到下一个占位，Esc 或移动光标退出';
      } else {
        slot.textContent = '本地算力';
        slot.removeAttribute('title');
      }
    } catch (e) { }
  }

  /* 光标移动或改动文本都结束片段会话 —— 跳错位置比不跳更糟 */
  function dropSnippetOnEdit() {
    if (snipSession) endSnippet();
  }

  function replaceRange(start, end, text, selStart, selEnd) {
    var v = cur.content;
    cur.content = v.slice(0, start) + text + v.slice(end);
    el.ta.value = cur.content;
    if (selStart == null) selStart = start + text.length;
    if (selEnd == null) selEnd = selStart;
    try { el.ta.setSelectionRange(selStart, selEnd); } catch (e) { }
    paint(); renderGutter(); syncScroll(); queueSave();
    emit('change', cur.path, cur.content);
    emit('cursor', caretInfo());
  }

  function lineBounds(pos) {
    var v = cur.content;
    var s = v.lastIndexOf('\n', pos - 1) + 1;
    var e = v.indexOf('\n', pos);
    if (e < 0) e = v.length;
    return [s, e];
  }

  function spaces(n) { return new Array(((n | 0) || 4) + 1).join(' '); }
  /* 缩进单元：**当前文件的风格优先于全局偏好**。
     打开别人的文件时，它用 tab 你就跟着用 tab，别把人家的格式改乱。
     检测不到的情况才回落到用户在偏好里选的。 */
  function indentUnit() {
    var st = (Code.styleAdapt && cur) ? Code.styleAdapt.of(cur.path) : null;
    if (st && st.mode === 'tab') return '\t';
    if (st && st.mode === 'space' && st.size) return spaces(st.size);

    var p = store.prefs;
    if (p.indentMode === 'tab') return '\t';
    if (p.indentMode === 'space') return spaces(p.tabSize);
    if (!cur) return spaces(p.tabSize);
    var lb = lineBounds(el.ta.selectionStart);
    var ind = (cur.content.slice(lb[0], lb[1]).match(/^[ \t]+/) || [''])[0];
    return ind.charAt(0) === '\t' ? '\t' : spaces(p.tabSize);
  }

  function commentToken() {
    var lang = U.langOf(cur.path);
    if (lang === 'python' || lang === 'shell' || lang === 'yaml') return '#';
    if (lang === 'sql') return '--';
    if (lang === 'html' || lang === 'markdown') return null;
    return '//';
  }

  /* ---------- Tab 片段展开 ----------
     展开后光标落在第一个占位上（选中，方便直接改写）。
     再按 Tab 跳下一个占位；一旦用户改动了文本就结束会话，
     因为偏移会失效 —— 与其跳错位置，不如老实缩进。 */
  var snipSession = null;

  function endSnippet() { snipSession = null; snippetHint(false); }

  function trySnippet() {
    if (!Code.snippets || !cur) return false;
    var p = store.prefs;
    if (p.snippets === false) return false;
    var ta = el.ta, pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return false;   /* 有选区时不展开 */

    /* 会话进行中：跳下一个占位 */
    if (snipSession) {
      var len = cur.content.length;
      if (len !== snipSession.len) { endSnippet(); return false; }
      var next = snipSession.stops[snipSession.idx];
      if (!next) { endSnippet(); return false; }
      snipSession.idx++;
      try { el.ta.setSelectionRange(next.start, next.end); } catch (e) { }
      paint();
      return true;
    }

    var lang = U.langOf(cur.path);
    var hit = Code.snippets.expand(lang, cur.content, pos);
    if (!hit) return false;

    var unit = indentUnit();
    /* 运算符间距也跟着文件走：x==y 的文件里别插入 x == y */
    var fst = Code.styleAdapt ? Code.styleAdapt.of(cur.path) : null;
    var r = hit.render(unit, fst && fst.spacing);
    pushUndo(false);
    /* 替换触发词 */
    var base = hit.start;
    var after = cur.content.slice(hit.end);
    var newText = cur.content.slice(0, base) + r.text + after;
    /* tabstop 的绝对位置 = 插入点 + 模板内偏移 */
    var stops = (r.stops || []).map(function (t) {
      return { n: t.n, start: base + t.start, end: base + t.end };
    });
    replaceRange(base, hit.end, r.text);
    /* replaceRange 已改了内容，这里重新算一遍长度 */
    snippetHint(true);
    snipSession = {
      stops: stops, idx: 0,
      len: newText.length
    };
    /* 选中第一个占位 */
    if (stops.length) {
      snipSession.idx = 1;
      try { el.ta.setSelectionRange(stops[0].start, stops[0].end); } catch (e) { }
    } else {
      endSnippet();
    }
    paint();
    return true;
  }

  function onKey(e) {
    if (!cur) return;
    var ta = el.ta, s = ta.selectionStart, en = ta.selectionEnd;
    /* E-029：片段会话期间 Tab 被完全接管，用户不知道怎么退出。
       Esc 退出是最直觉的那一个，必须有。 */
    if (e.key === 'Escape' && snipSession) { endSnippet(); e.preventDefault(); return; }

    var mod = e.ctrlKey || e.metaKey;

    /* E-017：Ctrl+S 以前是 flushSave(); U.toast('已保存') —— 无条件、不接 promise。
       写入失败时用户先看到"已保存"，几秒后自动保存的失败告警再弹出来，
       同一份内容先说成功再说失败。手动保存是用户最信任的动作，
       这时候骗他后果比自动保存更重。所以成功才弹 toast，失败立刻说。 */
    if (mod && e.key === 's') {
      e.preventDefault();
      var manualPath = cur ? cur.path : '';
      Promise.resolve()
        .then(function () { return flushSave(); })
        .then(function () {
          U.toast(manualPath ? ('已保存到本地库：' + manualPath) : '已保存到本地库');
        })
        .catch(function (e2) {
          U.toast('保存失败：' + String((e2 && e2.message) || e2), 'err');
          if (Code.app && Code.app.onSaveFail) Code.app.onSaveFail(manualPath, e2);
        });
      return;
    }
    if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (mod && e.key === 'd') { e.preventDefault(); selectWord(); return; }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveLine(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey); return; }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (s !== en && cur.content.slice(s, en).indexOf('\n') >= 0) return blockIndent(e.shiftKey ? -1 : 1);
      if (e.shiftKey) return;
      /* 先试片段展开：敲 for 再按 Tab 直接出骨架 */
      if (trySnippet()) return;
      pushUndo(false);
      replaceRange(s, en, indentUnit());
      return;
    }

    if (e.key === 'Enter') {
      var lb = lineBounds(s), lineText = cur.content.slice(lb[0], s);
      var ind = (lineText.match(/^[ \t]*/) || [''])[0];
      var prev = lineText.trim();
      var unit = indentUnit();
      var extra = '';
      if (/[{([]$/.test(prev)) extra = unit;
      var closing = /^[ \t]*[}\])]/.test(cur.content.slice(s));
      if (closing && /[{([]$/.test(prev)) {
        // 光标停在右括号前：把右括号单独放一行并缩进回退
        pushUndo(false);
        var body = '\n' + ind + unit + '\n' + ind;
        replaceRange(s, s, body, s + 1 + ind.length + unit.length, s + 1 + ind.length + unit.length);
        return;
      }
      pushUndo(false);
      replaceRange(s, en, '\n' + ind + extra);
      return;
    }

    if (e.key === 'Backspace' && s === en && s > 0) {
      var pair = { '(': ')', '[': ']', '{': '}' };
      if (pair[cur.content[s - 1]] && cur.content[s] === pair[cur.content[s - 1]]) {
        e.preventDefault(); pushUndo(false); replaceRange(s - 1, s + 1, '', s - 1, s - 1); return;
      }
      // 空缩进时一次退一个缩进宽度
      var lbB = lineBounds(s);
      if (s === lbB[0] && s > 0 && /^[ \t]+$/.test(cur.content.slice(lbB[0], s))) {
        e.preventDefault(); pushUndo(false); replaceRange(lbB[0], s, '', lbB[0], lbB[0]); return;
      }
    }

    if (e.key.length === 1 && !mod && !e.altKey) {
      var ch = e.key;
      if ('([{'.indexOf(ch) >= 0 && s === en) {
        var close = { '(': ')', '[': ']', '{': '}' }[ch];
        var nextCh = cur.content[s];
        if (!nextCh || /[\s)\]}]/.test(nextCh)) {
          e.preventDefault(); pushUndo(false);
          replaceRange(s, en, ch + close, s + 1, s + 1);
        }
        return;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (cur.content[s] === ch) { e.preventDefault(); pushUndo(false); replaceRange(s, s + 1, ch, s + 1, s + 1); }
        return;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        if (s !== en) {
          e.preventDefault(); pushUndo(false);
          replaceRange(s, en, ch + cur.content.slice(s, en) + ch, s + 1, en + 1);
        } else if (!/[\w'"`]/.test(cur.content[s - 1] || ' ') && cur.content[s] !== ch) {
          e.preventDefault(); pushUndo(false);
          replaceRange(s, en, ch + ch, s + 1, s + 1);
        }
        return;
      }
    }
  }

  function blockIndent(dir) {
    var v = cur.content, s = el.ta.selectionStart, en = el.ta.selectionEnd;
    var a = v.lastIndexOf('\n', s - 1) + 1;
    var b = v.indexOf('\n', en); if (b < 0) b = v.length;
    var block = v.slice(a, b), unit = indentUnit();
    var lines = block.split('\n').map(function (l) {
      if (dir > 0) {
        /* 空行不加缩进 —— 主流编辑器都这么做。
           给空行也加会在行尾留尾随空白，而很多 OJ 与 lint 对此敏感。 */
        if (l.trim() === '') return l;
        return unit + l;
      }
      /* ⚠ tabSize 为 0 时拼出 {1,0} → SyntaxError: numbers out of order
         in {} quantifier，整个反缩进崩溃。默认值 4 所以平时不触发，
         但 localStorage 被改成 0 或未来加了设置项就炸。 */
      return l.replace(new RegExp('^(\\t| {1,' + Math.max(1, store.prefs.tabSize | 0) + '})'), '');
    });
    pushUndo(false);
    var nb = lines.join('\n');
    replaceRange(a, b, nb, a, a + nb.length);
  }

  function toggleComment() {
    var tk = commentToken();
    if (!tk) { U.toast('该语言暂无行注释符号'); return; }
    var v = cur.content, s = el.ta.selectionStart, en = el.ta.selectionEnd;
    var a = v.lastIndexOf('\n', s - 1) + 1;
    var b = v.indexOf('\n', en); if (b < 0) b = v.length;
    var lines = v.slice(a, b).split('\n');
    var allOn = lines.every(function (l) { return l.trim() === '' || l.trim().indexOf(tk) === 0; });
    var out = lines.map(function (l) {
      if (l.trim() === '') return l;
      if (allOn) return l.replace(new RegExp('^(\\s*)' + tk.replace(/[-/]/g, '\\$&') + '\\s?'), '$1');
      var m = l.match(/^\s*/);
      return l.slice(0, m[0].length) + tk + ' ' + l.slice(m[0].length);
    });
    pushUndo(false);
    var nb = out.join('\n');
    replaceRange(a, b, nb, a, a + nb.length);
  }

  function moveLine(dir, copy) {
    var v = cur.content, s = el.ta.selectionStart, en = el.ta.selectionEnd;
    var lines = v.split('\n');
    var i0 = v.slice(0, s).split('\n').length - 1;
    var i1 = v.slice(0, en).split('\n').length - 1;
    if (dir < 0 && i0 === 0) return;
    if (dir > 0 && i1 + 1 >= lines.length) return;
    var blk = lines.slice(i0, i1 + 1);
    pushUndo(false);
    if (copy) {
      lines.splice.apply(lines, [dir < 0 ? i0 : i1 + 1, 0].concat(blk));
    } else {
      lines.splice(i0, blk.length);
      lines.splice.apply(lines, [dir < 0 ? i0 - 1 : i0 + 1, 0].concat(blk));
    }
    var nv = lines.join('\n');
    var delta = (dir < 0 ? -1 : 1) * (nv.length - v.length);
    var ns = Math.max(0, Math.min(nv.length, s + (copy ? (dir < 0 ? nv.length - v.length : 0) : delta)));
    var ne = Math.max(ns, Math.min(nv.length, en + (copy ? (dir < 0 ? nv.length - v.length : 0) : delta)));
    replaceRange(0, v.length, nv, ns, ne);
  }

  function selectWord() {
    var v = cur.content, s = el.ta.selectionStart, en = el.ta.selectionEnd;
    if (s !== en) return;
    var re = /[\w$]/;
    var a = s, b = s;
    while (a > 0 && re.test(v[a - 1])) a--;
    while (b < v.length && re.test(v[b])) b++;
    if (a === b) return;
    try { el.ta.setSelectionRange(a, b); } catch (e) { }
    paint();
  }

  Code.editor = {
    init: init, open: open, close: close, current: current, value: value, setValue: setValue,
    applyPrefs: applyPrefs, on: on, undo: undo, redo: redo, save: flushSave,
    focus: function () { el.ta.focus(); },
    endSnippet: endSnippet,
    caret: caretInfo,
    /* 片段展开需要：读选区、精确替换、手动压撤销栈 */
    sel: function () {
      if (!cur) return [0, 0];
      return [el.ta.selectionStart, el.ta.selectionEnd];
    },
    /* ⚠ 必须先压撤销栈再替换（S-102 / S-103）。
       编辑器自己的按键路径都是 pushUndo + replaceRange 成对出现，
       唯独对外暴露的 replace 没有 —— 于是：
         - AI「插入到光标处」提示"已插入，可撤销"，而这句是假的
         - **虚拟键盘的每一次输入都不可撤销**（移动端全部输入）
       在手机上 Ctrl+Z 会把整段退回打开时的状态，而不是逐字符撤销。 */
    replace: function (a, b, text, sa, se) {
      if (cur) { try { pushUndo(false); } catch (e) { } }
      replaceRange(a, b, text, sa, se);
    },
    pushUndo: pushUndo,
    /* 缩进单元，片段里用它而不是硬编码空格 */
    indentUnit: indentUnit,
    path: function () { return cur ? cur.path : ''; },
    refresh: function () { measure(); paint(); renderGutter(); },
    el: function () { return el; }
  };
})(window);
