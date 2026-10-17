/* ============================================================
   判题面板（界面层）
   ------------------------------------------------------------
   判题逻辑在 judge.js，这里只管界面。

   ---------- 为什么样例要能存下来 ----------
   样例是用户一个字一个字敲的。切个文件回来就没了的话，
   他不会再用第二次 —— 而且**不会告诉你为什么不用**，只会觉得不好用。
   所以按文件存，切回来还在。

   ---------- 为什么"判题"要用真的解释器跑 ----------
   打印一句"看起来对"没有意义。必须真的跑、真的比对。
   所以这里调 Code.judge.judge()，它内部用 Code.cpplite / Code.pylite
   执行代码 —— 跟点"运行"是同一套解释器，不会出现
   "运行是对的、判题却说错"这种自相矛盾。
   ============================================================ */
(function (root) {
  'use strict';
  var Code = root.Code || (root.Code = {});
  var U = Code.util || {};

  var cases = [];          /* [{ in, out }] */
  var curPath = '';

  function el(id) { return document.getElementById(id); }
  function esc(s) { return U.esc ? U.esc(s) : String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /* ---------- 存取：按文件 ---------- */
  function key(p) { return 'code:judge:' + p; }
  function load(p) {
    curPath = p || '';
    var raw = null;
    try { raw = localStorage.getItem(key(curPath)); } catch (e) { /* 隐私模式 */ }
    cases = [];
    if (raw) { try { cases = JSON.parse(raw) || []; } catch (e) { cases = []; } }
    if (!cases.length) cases = [{ in: '', out: '' }];
    render();
  }
  function save() {
    try { localStorage.setItem(key(curPath), JSON.stringify(cases)); }
    catch (e) { /* 存不下不影响判题本身 */ }
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var box = el('judge-cases');
    if (!box) return;
    box.innerHTML = '';
    cases.forEach(function (c, i) {
      var card = document.createElement('div');
      card.className = 'judge-case';
      card.innerHTML =
        '<div class="jc-head"><span>样例 ' + (i + 1) + '</span>' +
        (cases.length > 1
          ? '<button class="btn tiny danger" data-jc-del="' + i + '">删除</button>' : '') +
        '</div>' +
        '<div class="jc-io">' +
        '<textarea class="jc-in" rows="3" spellcheck="false" data-jc="' + i + '" data-k="in" ' +
        'placeholder="输入（stdin）">' + esc(c.in || '') + '</textarea>' +
        '<textarea class="jc-out" rows="3" spellcheck="false" data-jc="' + i + '" data-k="out" ' +
        'placeholder="期望输出">' + esc(c.out || '') + '</textarea>' +
        '</div>';
      box.appendChild(card);
    });
    /* 事件委托：卡片每次重建都重新绑定的话，旧节点上的监听器会残留 */
    box.querySelectorAll('textarea[data-jc]').forEach(function (ta) {
      ta.addEventListener('input', function () {
        var i = +ta.getAttribute('data-jc'), k = ta.getAttribute('data-k');
        cases[i][k] = ta.value; save();
      });
    });
    box.querySelectorAll('[data-jc-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        cases.splice(+b.getAttribute('data-jc-del'), 1);
        if (!cases.length) cases = [{ in: '', out: '' }];
        save(); render();
      });
    });
  }

  /* ---------- 判题 ---------- */
  function run() {
    var out = el('judge-result');
    if (!out) return;
    var path = (Code.app && Code.app.currentPath) ? Code.app.currentPath() : curPath;
    var code = (Code.editor && Code.editor.value) ? Code.editor.value() : '';

    if (!code || !String(code).trim()) {
      out.innerHTML = '<div class="jr-line warn">编辑器是空的，先写代码再判题。</div>';
      return;
    }
    var kind = Code.judge.pick(path);
    if (!kind) {
      out.innerHTML = '<div class="jr-line warn">' +
        '这个文件认不出是哪种语言（' + esc(path || '未命名') + '），判不了。' +
        '目前支持 C / C++ 与 Python。</div>';
      return;
    }

    out.innerHTML = '<div class="jr-line">判题中…</div>';
    /* 让"判题中"先绘制出来再跑 —— 同步跑会阻塞渲染，
       用户看到的是界面卡住，而不是"正在判"。 */
    setTimeout(function () {
      var r = Code.judge.judge(path, code, cases, { timeoutMs: 5000 });
      show(r, out);
    }, 30);
  }

  function show(r, out) {
    if (r.verdict === 'NONE') {
      out.innerHTML = '<div class="jr-line warn">' + esc(r.msg || '还没有样例。') + '</div>';
      return;
    }
    var cls = { AC: 'ok', WA: 'bad', TLE: 'warn', RE: 'bad' }[r.verdict] || '';
    var label = { AC: '全部通过', WA: '答案错误', TLE: '超时', RE: '运行出错' }[r.verdict] || r.verdict;
    var html = '<div class="jr-sum ' + cls + '">' + esc(label) +
      ' · ' + r.passed + '/' + r.total + ' 组通过</div>';

    r.details.forEach(function (d) {
      var c = d.ok ? 'ok' : (d.timeout ? 'warn' : 'bad');
      var v = d.ok ? '通过' : (d.timeout ? '超时' : (d.err ? '出错' : '答案不符'));
      html += '<div class="jr-case ' + c + '">' +
        '<div class="jr-ch">' + esc(d.name) + ' · ' + v + ' · ' + d.ms + ' ms</div>';
      if (d.err) {
        html += '<pre class="jr-err">' + esc(d.err) + '</pre>';
      } else if (!d.ok) {
        html += '<div class="jr-kv"><span>期望</span><pre>' + esc(d.want) + '</pre></div>' +
                '<div class="jr-kv"><span>实得</span><pre>' + esc(d.got) + '</pre></div>';
      }
      html += '</div>';
    });
    out.innerHTML = html;
  }

  function init() {
    var add = el('btn-judge-add'), runB = el('btn-judge-run'), clr = el('btn-judge-clear');
    if (add) add.addEventListener('click', function () {
      cases.push({ in: '', out: '' }); save(); render();
    });
    if (runB) runB.addEventListener('click', run);
    if (clr) clr.addEventListener('click', function () {
      cases = [{ in: '', out: '' }]; save(); render();
      var o = el('judge-result'); if (o) o.innerHTML = '';
    });
  }

  Code.judgeUI = { init: init, load: load, run: run,
    /* 给测试用：看当前样例 */
    _cases: function () { return cases; } };
})(typeof window !== 'undefined' ? window : globalThis);
