/* tree.js —— 文件树与工程内搜索
   数据源只有 fs.js 一份，树只是它的视图；不做第二套文件状态。 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});
  var U = Code.util;

  var root = null, resBox = null, expanded = {}, selPath = '';
  var hooks = { open: null, rename: null, remove: null, jump: null };

  function init(h) {
    root = U.$('#tree'); resBox = U.$('#search-results');
    hooks.open = h.open; hooks.rename = h.rename; hooks.remove = h.remove; hooks.jump = h.jump;
    root.addEventListener('click', onTreeClick);
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
      expanded[p] = expanded[p] === false ? true : false;
      render();
      return;
    }
    if (Code.fs.stat(p) && Code.fs.stat(p).type === 'dir') {
      expanded[p] = expanded[p] === false ? true : false;
      render();
      return;
    }
    select(p);
    hooks.open && hooks.open(p);
  }

  function select(p) { selPath = p; if (root) Array.prototype.forEach.call(root.querySelectorAll('.tree-row'), function (r) { r.classList.toggle('sel', r.dataset.path === p); }); }
  function reveal(p) { var i = p.lastIndexOf('/'); if (i > 0) expanded[p.slice(0, i)] = true; select(p); render(); }

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
    files.forEach(function (p) {
      if (total >= cap) return;
      var text = Code.fs.read(p) || '';
      if (text.length > 400000) return;
      var lines = text.split('\n'), hits = [];
      for (var i = 0; i < lines.length && hits.length < 40; i++) {
        var ln = lines[i];
        var ok = word ? (pat.lastIndex = 0, pat.test(ln)) : (cs ? ln.indexOf(needle) >= 0 : ln.toLowerCase().indexOf(needle) >= 0);
        if (ok) hits.push({ n: i + 1, text: ln });
      }
      if (!hits.length) return;
      html += '<div class="res-file">' + U.esc(p) + '（' + hits.length + '）</div>';
      hits.forEach(function (h) {
        total++;
        var shown = h.text.length > 160 ? h.text.slice(0, 160) + '…' : h.text;
        html += '<div class="res-line" data-path="' + U.esc(p) + '" data-line="' + h.n + '" title="跳转到该行">' +
          h.n + ': ' + mark(shown, q, cs, word) + '</div>';
      });
    });
    if (!html) html = '<div class="res-file">没有找到「' + U.esc(q) + '」。</div>';
    else if (total >= cap) html += '<div class="res-file">结果过多，只显示前 300 条。</div>';
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
