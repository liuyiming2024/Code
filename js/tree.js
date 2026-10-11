/* tree.js —— 文件树与工程内搜索
   数据源只有 fs.js 一份，树只是它的视图；不做第二套文件状态。 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});
  var U = Code.util;

  var root = null, resBox = null, expanded = {}, selPath = '';
  var LS_EXP = 'code.tree.expanded';
  var hooks = { open: null, rename: null, remove: null, jump: null };

  /* 展开状态存本机。E-056：以前纯内存，刷新后全部合上，
     用户把工程整理成几个目录并展开，每次重开都要一个个重新点开。 */
  function loadExpanded() {
    try {
      var raw = localStorage.getItem(LS_EXP);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach(function (p) { if (typeof p === 'string') expanded[p] = true; });
    } catch (e) { }
  }
  function saveExpanded() {
    try { localStorage.setItem(LS_EXP, JSON.stringify(Object.keys(expanded).filter(function (k) { return expanded[k]; }))); }
    catch (e) { }
  }

  function init(h) {
    root = U.$('#tree'); resBox = U.$('#search-results');
    loadExpanded();
    hooks.open = h.open; hooks.rename = h.rename; hooks.remove = h.remove; hooks.jump = h.jump;
    root.addEventListener('click', onTreeClick);
    /* E-052：每个 .tree-row 都有 role="treeitem" tabindex="0"（可 Tab 聚焦），
       但以前只绑了 click —— div 不是 button，聚焦后按 Enter 浏览器不会合成 click，
       键盘用户 Tab 到某个文件上按回车毫无反应。而 role="tree" 的标准键盘交互
       （↑↓ 移动、→ 展开、← 折叠）也一个都没有。这是核心导航入口。 */
    root.addEventListener('keydown', onTreeKey);
    root.addEventListener('contextmenu', function (e) {
      var row = e.target.closest && e.target.closest('.tree-row');
      if (!row) return;
      e.preventDefault();
      var p = row.dataset.path;
      U.menu(e.clientX, e.clientY, [
        { label: '重命名', act: function () { hooks.rename && hooks.rename(p); } },
        { label: '删除', act: function () { hooks.remove && hooks.remove(p); } }
      ]);
    });
    var si = U.$('#search-input');
    if (si) si.addEventListener('input', function () { doSearch(si.value); });
    ['search-case', 'search-word'].forEach(function (id) {
      var el = U.$('#' + id); if (el) el.addEventListener('change', function () { doSearch(si ? si.value : ''); });
    });
  }

  function icon(kind, open) {
    var id = kind === 'dir' ? (open ? '#i-folder-open' : '#i-folder') : '#i-file';
    return '<svg><use href="' + id + '"/></svg>';
  }

  function render() {
    if (!root) return;
    var items = Code.fs.list().map(function (r) { return r.path; }).sort();
    var byDir = {}, roots = [];
    items.forEach(function (p) {
      var i = p.lastIndexOf('/');
      var dir = i < 0 ? '' : p.slice(0, i);
      var node = { path: p, name: i < 0 ? p : p.slice(i + 1), dir: dir, kind: Code.fs.stat(p).type };
      (byDir[dir] || (byDir[dir] = [])).push(node);
      if (dir === '') roots.push(node);
      var seg = dir;
      while (seg) {
        var j = seg.lastIndexOf('/');
        var parent = j < 0 ? '' : seg.slice(0, j);
        var nm = j < 0 ? seg : seg.slice(j + 1);
        if (!byDir[parent]) byDir[parent] = [];
        if (!byDir[parent].some(function (x) { return x.path === seg; })) {
          byDir[parent].push({ path: seg, name: nm, dir: parent, kind: 'dir' });
        }
        seg = parent;
      }
    });
    function sortNodes(a) {
      a.sort(function (x, y) {
        if (x.kind !== y.kind) return x.kind === 'dir' ? -1 : 1;
        return x.name < y.name ? -1 : (x.name > y.name ? 1 : 0);
      });
      return a;
    }
    var html = '';
    function walk(dir, depth) {
      var nodes = sortNodes(byDir[dir] || []);
      nodes.forEach(function (n) {
        var isDir = n.kind === 'dir';
        var open = isDir && expanded[n.path] !== false;
        var pad = 4 + depth * 12;
        html += '<div class="tree-row' + (n.path === selPath ? ' sel' : '') + '" data-path="' + U.esc(n.path) + '"' +
          /* 标出类型，键盘交互（E-052）要靠它判断展开还是打开 */
          ' data-type="' + (n.kind === 'dir' ? 'dir' : 'file') + '"' +
          ' style="padding-left:' + pad + 'px" role="treeitem" tabindex="0">';
        if (isDir) {
          html += '<span class="tw" data-tw="1"><svg><use href="#i-chevron-right"/></svg></span>';
        } else html += '<span class="tw"></span>';
        html += '<span class="ic">' + icon(n.kind, open) + '</span>';
        html += '<span class="name">' + U.esc(n.name) + '</span>';
        html += '<span class="row-actions">' +
          '<button class="icon-btn sm" data-ra="rename" title="重命名" aria-label="重命名"><svg><use href="#i-rename"/></svg></button>' +
          '<button class="icon-btn sm" data-ra="del" title="删除" aria-label="删除"><svg><use href="#i-trash"/></svg></button>' +
          '</span></div>';
        if (isDir && open) walk(n.path, depth + 1);
      });
    }
    walk('', 0);
    root.innerHTML = html || '<div class="tree-empty">还没有文件。用上方加号新建，或导入 ZIP。</div>';
  }

  function onTreeClick(e) {
    var row = e.target.closest && e.target.closest('.tree-row');
    if (!row) return;
    var p = row.dataset.path;
    var ra = e.target.closest && e.target.closest('[data-ra]');
    if (ra) {
      e.stopPropagation();
      if (ra.dataset.ra === 'rename') hooks.rename && hooks.rename(p);
      else hooks.remove && hooks.remove(p);
      return;
    }
    if (e.target.closest && e.target.closest('.tw')) {
      expanded[p] = expanded[p] === false ? true : false; saveExpanded();
      render();
      return;
    }
    if (Code.fs.stat(p) && Code.fs.stat(p).type === 'dir') {
      expanded[p] = expanded[p] === false ? true : false; saveExpanded();
      render();
      return;
    }
    select(p);
    hooks.open && hooks.open(p);
  }

  /* 树的标准键盘交互：↑↓ 移动焦点、→ 展开、← 折叠、Enter/Space 打开 */
  function onTreeKey(e) {
    var row = e.target && e.target.closest ? e.target.closest('.tree-row') : null;
    if (!row) return;
    var rows = Array.prototype.slice.call(root.querySelectorAll('.tree-row'));
    var idx = rows.indexOf(row);
    var p = row.dataset.path || '';
    var isDir = row.dataset.type === 'dir' ||
      (!row.dataset.type && Code.fs && Code.fs.stat && (Code.fs.stat(p) || {}).type === 'dir');

    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (isDir) { expanded[p] = expanded[p] === false ? true : false; saveExpanded(); render(); }
      else { hooks.open && hooks.open(p); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (idx < rows.length - 1) rows[idx + 1].focus();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx > 0) rows[idx - 1].focus();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (isDir && !expanded[p]) { expanded[p] = true; saveExpanded(); render(); focusPath(p); }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isDir && expanded[p]) { expanded[p] = false; saveExpanded(); render(); focusPath(p); }
      else {
        /* 焦点移到父节点：与常见文件树一致 */
        var i = p.lastIndexOf('/');
        if (i > 0) focusPath(p.slice(0, i));
      }
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); if (rows.length) rows[0].focus(); return; }
    if (e.key === 'End') { e.preventDefault(); if (rows.length) rows[rows.length - 1].focus(); }
  }

  function focusPath(p) {
    var el = root.querySelector('.tree-row[data-path="' + String(p).replace(/"/g, '\\"') + '"]');
    if (el) { try { el.focus(); } catch (e) { } }
  }

  function select(p) { selPath = p; if (root) Array.prototype.forEach.call(root.querySelectorAll('.tree-row'), function (r) { r.classList.toggle('sel', r.dataset.path === p); }); }
  function reveal(p) { var i = p.lastIndexOf('/'); if (i > 0) expanded[p.slice(0, i)] = true; saveExpanded(); select(p); render(); }

  function doSearch(q) {
    if (!resBox) return;
    q = (q || '').trim();
    if (q.length < 1) { resBox.innerHTML = '<div class="res-file">输入关键词开始搜索。</div>'; return; }
    var cs = U.$('#search-case') && U.$('#search-case').checked;
    var word = U.$('#search-word') && U.$('#search-word').checked;
    var needle = cs ? q : q.toLowerCase();
    var pat = word ? new RegExp('(^|[^\\w])' + escapeRe(q) + '(?=$|[^\\w])', cs ? 'g' : 'gi') : null;
    var files = Code.fs.list().filter(function (p) { var s = Code.fs.stat(p); return s && s.type !== 'dir'; });
    var html = '', total = 0, cap = 300;
    /* E-027：同一个搜索里有三种截断，以前只有"总数超 300"有提示，
       另外两种是静默的 —— 用户明明记得某个大文件里有这个词却搜不到，
       会以为自己记错了。所以被跳过的文件单独记下来，最后列出来。 */
    var skipped = [], truncated = [];
    files.forEach(function (p) {
      if (total >= cap) return;
      var text = Code.fs.read(p) || '';
      if (text.length > 400000) { skipped.push(p.path || p); return; }
      var lines = text.split('\n'), hits = [];
      for (var i = 0; i < lines.length && hits.length < 40; i++) {
        var ln = lines[i];
        var ok = word ? (pat.lastIndex = 0, pat.test(ln)) : (cs ? ln.indexOf(needle) >= 0 : ln.toLowerCase().indexOf(needle) >= 0);
        if (ok) hits.push({ n: i + 1, text: ln });
      }
      if (!hits.length) return;
      /* 每文件 40 条上限：显示成「≥40」而不是「40」，
         否则用户看到正好 40 会以为就这么多。 */
      var label = hits.length >= 40 ? '≥' + hits.length : String(hits.length);
      if (hits.length >= 40) truncated.push(p);
      html += '<div class="res-file">' + U.esc(p) + '（' + label + '）</div>';
      hits.forEach(function (h) {
        total++;
        var shown = h.text.length > 160 ? h.text.slice(0, 160) + '…' : h.text;
        html += '<div class="res-line" data-path="' + U.esc(p) + '" data-line="' + h.n + '" title="跳转到该行">' +
          h.n + ': ' + mark(shown, q, cs, word) + '</div>';
      });
    });
    if (!html) html = '<div class="res-file">没有找到「' + U.esc(q) + '」。</div>';
    else if (total >= cap) html += '<div class="res-file">结果过多，只显示前 300 条。</div>';
    /* 大文件被跳过、命中被截断，都必须说出来 ——
       否则用户搜不到会以为自己记错了，而不是工具没搜。 */
    if (skipped.length) {
      html += '<div class="res-file">以下 ' + skipped.length + ' 个文件过大（>400000 字符）未搜索：' +
        U.esc(skipped.join('、')) + '</div>';
    }
    if (truncated.length) {
      html += '<div class="res-file">以下文件命中超过 40 条，只显示前 40：' +
        U.esc(truncated.join('、')) + '</div>';
    }
    resBox.innerHTML = html;
    resBox.onclick = function (e) {
      var el = e.target.closest && e.target.closest('.res-line');
      if (!el) return;
      hooks.jump && hooks.jump(el.dataset.path, parseInt(el.dataset.line, 10));
    };
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function mark(text, q, cs, word) {
    var out = '', i = 0;
    if (word) {
      var re = new RegExp('(^|[^\\w])(' + escapeRe(q) + ')(?=$|[^\\w])', cs ? 'g' : 'gi');
      return U.esc(text).replace(re, function (m, a, b) { return U.esc(a) + '<mark>' + U.esc(b) + '</mark>'; });
    }
    var hay = cs ? text : text.toLowerCase(), n = cs ? q : q.toLowerCase();
    while (true) {
      var k = hay.indexOf(n, i);
      if (k < 0) { out += U.esc(text.slice(i)); break; }
      out += U.esc(text.slice(i, k)) + '<mark>' + U.esc(text.slice(k, k + q.length)) + '</mark>';
      i = k + q.length;
    }
    return out;
  }

  Code.tree = { init: init, render: render, select: select, reveal: reveal, search: doSearch };
})(window);
