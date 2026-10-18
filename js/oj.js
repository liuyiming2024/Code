/* ============================================================
   远程判题（代提交）—— 前端
   ------------------------------------------------------------
   浏览器**无法**带你的 OJ cookie 访问别的网站（CORS + Cookie 同源策略），
   所以提交必须经过 supabase/functions/oj-proxy 转发。
   转发函数**不保存**任何凭据（见那个文件的说明）。

   ---------- 凭据存在哪、怎么取 ----------
   凭据（cookie 串）存在**你自己的浏览器** localStorage 里，不上传服务器存储。
   取的方法写在界面上：登录目标 OJ → F12 → 复制 cookie。
   这是唯一需要你手动做一次的事。

   ---------- 为什么要先勾选"我已知悉" ----------
   平台可能认为自动化提交违反其服务条款，后果（限流、封号）由用户承担。
   不做确认就提交，等于我们替你做了这个决定 —— 那不该由我们来做。
   ============================================================ */
(function (root) {
  'use strict';
  var Code = root.Code || (root.Code = {});
  var U = Code.util || {};

  var SUPPORTED = [
    { id: 'codeforces', name: 'Codeforces', langs: [
      { id: '54', name: 'GNU G++17' }, { id: '61', name: 'GNU G++20' },
      { id: '50', name: 'GNU C11' }, { id: '31', name: 'Python 3' }] }
  ];

  var PROXY = (Code.SUPABASE_URL || '') + '/functions/v1/oj-proxy';
  var KEY = 'code:oj:';

  function esc(s) { return U.esc ? U.esc(s) : String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var state = { agreed: false, oj: 'codeforces', pid: '', lang: '54', cred: '' };

  /* ---------- 凭据存取 ---------- */
  function loadCred(oj) {
    try { return localStorage.getItem(KEY + 'cred:' + oj) || ''; } catch (e) { return ''; }
  }
  function saveCred(oj, v) {
    try { localStorage.setItem(KEY + 'cred:' + oj, v); } catch (e) { /* 隐私模式 */ }
  }
  function loadAgree() {
    try { return localStorage.getItem(KEY + 'agreed') === '1'; } catch (e) { return false; }
  }
  function saveAgree(v) {
    try { localStorage.setItem(KEY + 'agreed', v ? '1' : '0'); } catch (e) { }
  }

  /* ---------- 提交 ---------- */
  function submit(cb) {
    var path = (Code.app && Code.app.currentPath) ? Code.app.currentPath() : '';
    if (U && U.$) {
      var p = U.$('#oj-pid'), l = U.$('#oj-lang'), o = U.$('#oj-site');
      var c = U.$('#oj-cred'), a = U.$('#oj-agree');
      if (p) state.pid = p.value.trim();
      if (l) state.lang = l.value;
      if (o) state.oj = o.value;
      if (c) state.cred = c.value.trim();
      if (a) { state.agreed = a.checked; saveAgree(a.checked); }
    }

    function say(cls, text) {
      var o = U && U.$ ? U.$('#oj-result') : null;
      if (o) o.innerHTML = '<div class="jr-line ' + cls + '">' + esc(text) + '</div>';
      if (cb) cb(cls, text);
    }

    /* 三项必填，缺哪个说哪个 —— 笼统说"提交失败"会让人反复重试 */
    if (!state.agreed) return say('warn', '请先勾选「我已知悉风险」。');
    if (!state.pid) return say('warn', '还没填题号（比如 4A）。');
    if (!state.cred) return say('warn', '还没填账号凭据（cookie），填法见下方说明。');

    var code = (Code.editor && Code.editor.value) ? Code.editor.value() : '';
    if (!String(code).trim()) return say('warn', '编辑器是空的。');

    /* 语言要跟文件匹配：拿着 .py 的源码按 G++ 提交必然编译错误，
       而这个错看起来像"平台判错"，用户会去查平台。 */
    var ext = String(path).split('.').pop().toLowerCase();
    if (ext === 'py' && /G\+\+|C\d/.test(langName())) {
      return say('warn', '文件是 Python，但选的提交语言是 ' + langName() + '，会编译失败。请改选 Python。');
    }
    if ((ext === 'cpp' || ext === 'c') && /Python/.test(langName())) {
      return say('warn', '文件是 C/C++，但选的提交语言是 Python，会判错。请改选 G++。');
    }

    saveCred(state.oj, state.cred);
    say('', '提交中…');

    fetch(PROXY, {
      method: 'POST',
      headers: { 'content-type': 'application/json',
        'apikey': Code.SUPABASE_KEY || '', 'authorization': 'Bearer ' + (Code.SUPABASE_KEY || '') },
      body: JSON.stringify({ oj: state.oj, pid: state.pid, code: code, lang: state.lang, cred: state.cred })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) return say('bad', j.error || '提交失败');
      var v = j.verdict || 'UNKNOWN';
      var cls = v === 'AC' ? 'ok' : (v === 'UNKNOWN' ? 'warn' : 'bad');
      var txt = verdictText(v);
      if (j.timeMs) txt += ' · ' + j.timeMs + ' ms';
      if (j.memKb) txt += ' · ' + Math.round(j.memKb / 1024) + ' MB';
      if (j.remoteId) txt += ' · 提交号 ' + j.remoteId;
      say(cls, txt);
    }).catch(function (e) {
      /* 网络失败要说清"没提交出去"，否则用户会以为判题结果是真的 */
      say('bad', '连不上提交服务：' + (e.message || e) + '。你的代码**没有**被提交。');
    });
  }

  function langName() {
    var s = (SUPPORTED.filter(function (x) { return x.id === state.oj; })[0] || {}).langs || [];
    var m = s.filter(function (x) { return x.id === state.lang; })[0];
    return m ? m.name : state.lang;
  }
  function verdictText(v) {
    return ({ AC: '通过', WA: '答案错误', TLE: '超时', MLE: '内存超限',
      RE: '运行错误', CE: '编译错误', UNKNOWN: '结果未知' })[v] || v;
  }

  function init() {
    var box = (U && U.$) ? U.$('#oj-box') : null;
    if (!box) return;
    var agreed = loadAgree();
    state.agreed = agreed;

    box.innerHTML =
      '<div class="oj-note">' +
        '<b>这个功能是代提交，用你自己的账号发到目标平台。</b>' +
        '平台可能认为自动化提交违反其服务条款，' +
        '<b>限流或封号的风险由你自己承担</b>。' +
        '凭据只存在你这台设备，转发服务不保存。' +
      '</div>' +
      '<div class="oj-row"><label>平台</label><select id="oj-site">' +
        SUPPORTED.map(function (s) {
          return '<option value="' + s.id + '">' + esc(s.name) + '</option>';
        }).join('') +
      '</select>' +
      '<label>题号</label><input id="oj-pid" placeholder="如 4A" spellcheck="false">' +
      '<label>语言</label><select id="oj-lang">' +
        SUPPORTED[0].langs.map(function (l) {
          return '<option value="' + l.id + '">' + esc(l.name) + '</option>';
        }).join('') +
      '</select></div>' +
      '<div class="oj-row"><label>凭据</label>' +
        '<input id="oj-cred" placeholder="登录 OJ 后复制的 cookie" spellcheck="false">' +
      '</div>' +
      '<div class="oj-help">取法：登录目标平台 → 按 F12 → Console 里执行 ' +
        '<code>document.cookie</code> → 把输出粘贴到上面。</div>' +
      '<div class="oj-row"><label class="oj-check">' +
        '<input type="checkbox" id="oj-agree"' + (agreed ? ' checked' : '') + '>' +
        '我已知悉风险，自愿使用' +
      '</label>' +
      '<button class="btn tiny primary" id="oj-submit">提交</button></div>' +
      '<div id="oj-result" class="judge-result"></div>';

    var site = U.$('#oj-site');
    site.addEventListener('change', function () {
      state.oj = site.value;
      var c = U.$('#oj-cred');
      if (c) c.value = loadCred(state.oj);
    });
    U.$('#oj-submit').addEventListener('click', function () { submit(); });
    var c0 = U.$('#oj-cred');
    if (c0) c0.value = loadCred(state.oj);
  }

  Code.oj = { init: init, submit: submit, SUPPORTED: SUPPORTED,
    verdictText: verdictText, state: state };
})(typeof window !== 'undefined' ? window : globalThis);
