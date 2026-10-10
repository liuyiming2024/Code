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

  function renderGutter() {
    if (!cur) return;
    var total = cur.content.split('\n').length;
    var view = Math.ceil(el.area.clientHeight / lineH) + 40;
    var top = Math.floor(el.ta.scrollTop / lineH);
    var start = Math.max(0, top - 20), end = Math.min(total, start + view);
    var curLine = cur.content.slice(0, el.ta.selectionStart).split('\n').length;
    var html = '';
    if (start > 0) html += '<div style="height:' + (start * lineH) + 'px"></div>';
    for (var i = start; i < end; i++) {
      html += '<div' + (i + 1 === curLine ? ' class="cur"' : '') + '>' + (i + 1) + '</div>';
    }
    if (end < total) html += '<div style="height:' + ((total - end) * lineH) + 'px"></div>';
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
  /* 缩进方式：tab / space / smart（沿用当前行首字符） */
  function indentUnit() {
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

  function onKey(e) {
    if (!cur) return;
    var ta = el.ta, s = ta.selectionStart, en = ta.selectionEnd;
    var mod = e.ctrlKey || e.metaKey;

    if (mod && e.key === 's') { e.preventDefault(); flushSave(); U.toast('已保存到本地库'); return; }
    if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (mod && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (mod && e.key === 'd') { e.preventDefault(); selectWord(); return; }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveLine(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey); return; }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (s !== en && cur.content.slice(s, en).indexOf('\n') >= 0) return blockIndent(e.shiftKey ? -1 : 1);
      if (e.shiftKey) return;
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
      if (dir > 0) return unit + l;
      return l.replace(new RegExp('^(\\t| {1,' + (store.prefs.tabSize | 0) + '})'), '');
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
    caret: caretInfo,
    refresh: function () { measure(); paint(); renderGutter(); },
    el: function () { return el; }
  };
})(window);
