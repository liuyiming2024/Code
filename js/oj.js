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

  /* ============================================================
     凭据的本地加密存储
     ------------------------------------------------------------
     为什么加密：明文 cookie 躺在 localStorage 里，
     任何人打开 DevTools 扫一眼就能拿走 —— 而它等价于你在 OJ 的登录态。

     ---------- 密钥怎么来：随机生成 + 不可导出 ----------
     用 AES-GCM 256 位密钥，generateKey 的第二个参数传 false =
     **不可导出**（non-extractable）。含义是：连我们自己的代码
     都调不出密钥本体（crypto.subtle.exportKey 会直接抛错）。

     所以密钥存在 IndexedDB 里也只是个"黑盒句柄"：
     能用来加解密，但没人能把它读出来抄走。
     这比"再硬编码一个密钥去加密"强 —— 硬编码的密钥写在源码里，
     随页面一起下发，等于没加密。这一点是决定性的。

     ---------- 必须说清的局限（不能吹） ----------
     本地加密**挡不住**在你的页面里执行的 XSS：
     恶意脚本可以直接调 decrypt 拿到明文，跟它直接读 localStorage 一样。
     它真正挡住的是：
       · 别人打开 DevTools / 导走 localStorage 文件看明文
       · 别的扩展或脚本批量扫 localStorage 收集 cookie
       · 备份、同步、导出时明文外泄
     这是 Web 端本地加密的固有上限，如实写在这里。

     ---------- 代价：密钥丢了凭据就作废 ----------
     清浏览器数据会把 IndexedDB 一起清掉，那时旧密文解不开，
     必须重新填一次凭据。这个代价换来上面的收益，我认为值得，
     所以解不开时**明确提示重新填**，不静默当成"没填过"。
     ============================================================ */
  var WC = (root.crypto && root.crypto.subtle) ? root.crypto : null;
  var DBP = null;

  function idb() {
    if (DBP) return DBP;
    DBP = new Promise(function (res, rej) {
      var q = indexedDB.open('code-oj-cred', 1);
      q.onupgradeneeded = function () { q.result.createObjectStore('k'); };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error || new Error('IndexedDB 打不开')); };
    });
    return DBP;
  }

  /* 取（或首次生成）密钥。non-extractable，见上。 */
  function getKey() {
    if (!WC) return Promise.reject(new Error('NO_WEBCRYPTO'));
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('k', 'readwrite'), st = tx.objectStore('k'), g = st.get('k1');
        g.onsuccess = function () {
          if (g.result) return res(g.result);
          WC.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
            .then(function (k) { try { st.put(k, 'k1'); } catch (e) { } res(k); }, rej);
        };
        g.onerror = function () { rej(g.error || new Error('读密钥失败')); };
      });
    });
  }

  function b64e(u8) {
    var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64d(str) {
    var b = atob(str), u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }

  /* 密文格式：enc1:<iv>:<ct>
     ⚠ IV 必须每次随机 —— AES-GCM 复用 IV 会直接泄露明文，
       这是 GCM 最致命的误用，所以绝不缓存 IV。 */
  function encryptStr(plain) {
    return getKey().then(function (k) {
      var iv = new Uint8Array(12);
      (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(iv)
        : (function () { for (var i = 0; i < 12; i++) iv[i] = Math.floor(Math.random() * 256); })();
      return WC.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k,
        new TextEncoder().encode(plain)).then(function (ct) {
          return 'enc1:' + b64e(iv) + ':' + b64e(new Uint8Array(ct));
        });
    });
  }

  function decryptStr(env) {
    if (!env) return Promise.resolve('');
    if (env.indexOf('enc1:') !== 0) return Promise.resolve(env); /* 旧明文，见 migrate */
    return getKey().then(function (k) {
      var parts = env.split(':');
      if (parts.length !== 3) return Promise.reject(new Error('密文格式不对'));
      return WC.subtle.decrypt({ name: 'AES-GCM', iv: b64d(parts[1]) }, k, b64d(parts[2]))
        .then(function (pt) { return new TextDecoder().decode(pt); });
    });
  }

  /* 旧的明文凭据：读到就自动升级成密文，不能让老用户莫名其妙失效 */
  function migrate(oj, raw) {
    if (!raw || raw.indexOf('enc1:') === 0) return Promise.resolve();
    return saveCred(oj, raw).then(function () { }, function () { });
  }

  function loadCred(oj) {
    /* 同步返回"这一刻能拿到的明文"，加密版本随后填回输入框。
       不能让调用方等 Promise —— 界面初始化是同步的。 */
    try { return localStorage.getItem(KEY + 'cred:' + oj) || ''; } catch (e) { return ''; }
  }
  function loadCredText(oj) {
    var raw = loadCred(oj);
    if (!raw) return Promise.resolve('');
    return decryptStr(raw).catch(function () {
      /* 解不开：多半是密钥被清了。**抛出而不是返回空** ——
         返回空的话用户会以为自己从没填过，于是反复填，
         而每次填完又立刻被覆盖成读不出的状态。 */
      var e = new Error('CRED_UNREADABLE'); e.raw = raw; throw e;
    });
  }
  function saveCred(oj, v) {
    if (!WC) {
      /* 没有 WebCrypto 就**绝不落盘明文**。
         静默写明文 = 用户以为加密了其实没有，这比不加密更糟。 */
      return Promise.reject(new Error('NO_WEBCRYPTO'));
    }
    if (!v) {
      try { localStorage.removeItem(KEY + 'cred:' + oj); } catch (e) { }
      return Promise.resolve();
    }
    return encryptStr(v).then(function (env) {
      try { localStorage.setItem(KEY + 'cred:' + oj, env); } catch (e) { }
    });
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

    say('', '提交中…');
    /* 加密保存。失败**不阻断提交** —— 存不下只是下次要重填，
       而阻断提交会让用户以为功能坏了。但要如实告知。 */
    saveCred(state.oj, state.cred).then(post, function (e) {
      if (e && e.message === 'NO_WEBCRYPTO') {
        var w = U && U.$ ? U.$('#oj-result') : null;
        if (w) w.innerHTML += '<div class="jr-line warn">' +
          '这台设备不支持本地加密，凭据**没有保存**（下次要重填）。' +
          '提交照常进行。</div>';
      }
      return post();
    });
    return;

    function post() {
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
  }

  /* 把解密后的凭据填回输入框。
     三条分支必须分开报，不能都当成"没填过"：
       · 空        → 正常的"还没填"
       · 旧明文    → 悄悄升级成密文，用户无感
       · 解不开    → 密钥丢了，必须明确说"请重新填"，
                     否则用户会以为自己从没填过而反复填 */
  function fillCred(input, oj) {
    if (!input) return;
    var raw = loadCred(oj);
    if (!raw) { input.value = ''; return; }
    if (raw.indexOf('enc1:') !== 0) {
      input.value = raw;                     /* 旧明文：先照常显示 */
      migrate(oj, raw);                      /* 再悄悄升级 */
      return;
    }
    input.value = '';
    input.placeholder = '正在解密…';
    loadCredText(oj).then(function (t) {
      input.value = t;
      input.placeholder = '登录 OJ 后复制的 cookie';
    }, function (e) {
      input.placeholder = '之前的凭据读不出来了（密钥丢了），请重新填';
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
        '凭据<b>加密后</b>存在你这台设备（密钥不可导出），转发服务不保存。' +
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
      fillCred(U.$('#oj-cred'), state.oj);
    });
    U.$('#oj-submit').addEventListener('click', function () { submit(); });
    fillCred(U.$('#oj-cred'), state.oj);
  }

  Code.oj = { init: init, submit: submit, SUPPORTED: SUPPORTED,
    verdictText: verdictText, state: state,
    encryptStr: encryptStr, decryptStr: decryptStr, loadCredText: loadCredText };
})(typeof window !== 'undefined' ? window : globalThis);
