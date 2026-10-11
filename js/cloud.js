/* cloud.js —— 账号与云盘（接 Chat 的同一套后端）
 *
 * 这不是给 Code 单独建一套账号，而是**复用 Chat 已有的库**：
 *   - 同一个 Supabase 项目
 *   - 同一个 users 表、同一套 session、同一个站点保护密码
 *   - 数据只多一张 code_files（见 code/supabase/cloud.sql）
 *
 * 所以在 Chat 注册过的账号，在这里直接能登；反之亦然。
 *
 * ---------- 为什么可以直接读到登录态 ----------
 * Chat 与 Code 都挂在 liuyiming2024.github.io 下，**同源**。
 * 同源页面共享 localStorage，而 Chat 为了"聊天室/贴吧跨页面统一身份"，
 * 把会话 token 写在了 localStorage（它自己的注释里写了原因）。
 * 于是这里可以直接读到：在 Chat 登过，打开 Code 就已经是同一个人。
 *
 * 这条便利有个前提和代价，必须写清楚：
 *   前提：两个应用同源。将来若把 Code 挪到独立域名，这条路立刻断，
 *         那时只剩「手动登录」与「票据兑换」两条路，代码已同时实现。
 *   代价：读不到不能报错，要静默回退到自己的登录流程。
 *        把"没检测到"当成错误提示出来，对没用过 Chat 的人是骚扰。
 *
 * ---------- 三条硬规矩 ----------
 *   1. 不引入任何 SDK，纯 fetch（PostgREST）。理由同 Chat 的 sb.js：
 *      版权、离线、体积。
 *   2. 明文只出不进：密码交给服务端 bcrypt，前端不碰任何人的 pwd_hash。
 *   3. 只放 publishable key（按设计就是公开的，等价于 anon key）。
 *      **绝不**放 service_role / secret key —— 那个绕过一切权限。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  /* 内置后端：打开即用。
     与 Chat 的 sb.js 用同一个项目、同一把 publishable key。
     它按设计公开（任何前端项目的 JS 包里都躺着一个，DevTools 能翻出来），
     真正的边界是账号密码 + 服务端函数内的鉴权。 */
  var DEFAULT_URL = 'https://pimryrsxkwyafmponegp.supabase.co';
  var DEFAULT_KEY = 'sb_publishable_jPrK6j5l9NGbnLKcytTegg_di1njO8t';

  /* 与 Chat 共享的键名 —— 这是"同一个账号"的技术基础。
     读不到就走自己的流程，绝不因此报错。 */
  var CHAT_TOKEN_KEY = 'wxlg_sb_token';
  var CHAT_UID_KEY = 'wxlg_sb_uid';
  var CHAT_CFG_KEY = 'wxlg_sb_cfg';

  /* 自己的键名：只在没有共享会话、用户在本页单独登录时才用 */
  var OWN_TOKEN_KEY = 'code_cloud_token';
  var OWN_UID_KEY = 'code_cloud_uid';
  var CFG_KEY = 'code_cloud_cfg';

  var url = null, key = null, cfgLoaded = false;
  var self = null;    /* 缓存的个人信息 */

  /* ---------------- 存储 ---------------- */
  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch (e) { }
    return null;
  }

  function loadCfg() {
    if (cfgLoaded) return !!url && !!key;
    cfgLoaded = true;
    try {
      /* 优先用 Chat 已配好的后端 —— 那样两边一定指向同一个库，
         不会出现"Code 写进 A 库、Chat 读 B 库"的错位。 */
      var c = JSON.parse(ls(CHAT_CFG_KEY) || 'null');
      if (c && c.url && c.key) { url = String(c.url).replace(/\/+$/, ''); key = c.key; return true; }
    } catch (e) { }
    try {
      var c2 = JSON.parse(ls(CFG_KEY) || 'null');
      if (c2 && c2.url && c2.key) { url = String(c2.url).replace(/\/+$/, ''); key = c2.key; return true; }
    } catch (e) { }
    url = DEFAULT_URL; key = DEFAULT_KEY;
    return true;
  }

  function configure(u, k) {
    url = String(u || '').replace(/\/+$/, '');
    key = k || '';
    ls(CFG_KEY, JSON.stringify({ url: url, key: key }));
    return !!url && !!key;
  }

  function isOn() { loadCfg(); return !!url && !!key; }

  /* ---------------- 会话 ----------------
     读的顺序：自己本页登的 → Chat 共享的。
     写的时候两边都写，这样在 Code 登录，回到 Chat 也是同一个人。 */
  function token() {
    return ls(OWN_TOKEN_KEY) || ls(CHAT_TOKEN_KEY) || null;
  }
  function uid() {
    return ls(OWN_UID_KEY) || ls(CHAT_UID_KEY) || null;
  }
  function setSession(tok, id) {
    ls(OWN_TOKEN_KEY, tok || null);
    ls(OWN_UID_KEY, id || null);
    /* 同步给 Chat：让它那边也认出这次登录 */
    if (tok) {
      ls(CHAT_TOKEN_KEY, tok);
      if (id) ls(CHAT_UID_KEY, id);
    }
  }
  function dropSession() {
    ls(OWN_TOKEN_KEY, null); ls(OWN_UID_KEY, null);
    /* 只清自己写的。Chat 的会话由 Chat 自己管，
       这里不越权删——用户可能只是想在 Code 退出，而不是退出全部。 */
    self = null;
  }

  /* 是否"借"到了 Chat 的登录态（自己没单独登过） */
  function isSharedSession() {
    return !ls(OWN_TOKEN_KEY) && !!ls(CHAT_TOKEN_KEY);
  }

  /* ---------------- HTTP ---------------- */
  function headers(json) {
    var h = { apikey: key };
    var t = token();
    if (t) h['x-session'] = t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function rpc(name, params) {
    if (!isOn()) return Promise.reject(new Error('未配置云端后端'));
    return fetch(url + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: headers(true), body: JSON.stringify(params || {})
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
          var msg = m ? m[1].replace(/\\"/g, '"') : ('请求失败 ' + r.status);
          /* 401/403 多半是会话过期，提示要说人话 */
          if (r.status === 401 || r.status === 403) msg = '登录已失效，请重新登录';
          throw new Error(msg);
        });
      }
      var ct = r.headers.get('content-type') || '';
      if (r.status === 204 || !ct) return null;
      if (ct.indexOf('json') < 0) return r.text();
      return r.json();
    });
  }

  /* 统一包一层：把 {ok:false,err} 变成 reject，调用方只写 happy path */
  function okRpc(name, params) {
    return rpc(name, params).then(function (j) {
      if (j && j.ok === false) throw new Error(j.err || '操作失败');
      return j;
    });
  }

  /* ---------------- 站点与账号 ---------------- */
  function siteReady() {
    if (!isOn()) return Promise.reject(new Error('未配置云端后端'));
    return rpc('site_ready', {});
  }

  function gateCheck(pwd) {
    return rpc('gate_check', { p: pwd }).then(function (t) {
      if (!t) throw new Error('保护密码错误');
      /* 过门禁也会拿到一个 token（gate_only），一并存下 */
      setSession(t, null);
      return t;
    });
  }

  function login(nick, pwd) {
    return rpc('user_login', { p_nick: nick, p_pwd: pwd }).then(function (r) {
      if (!r || !r.token) throw new Error('昵称或密码错误');
      setSession(r.token, r.uid);
      self = null;
      return r;
    });
  }

  function register(nick, pwd, realName) {
    return okRpc('user_register', { p_nick: nick, p_pwd: pwd, p_real: realName || '' });
  }

  /* 票据兑换：在 Chat 里申领一串码，在这里换会话，免输密码。
     因为两边同源，票据自带的 origin 校验天然通过。 */
  function redeem(code) {
    var origin = '';
    try { origin = location.origin || ''; } catch (e) { }
    return rpc('bridge_ticket_redeem', { p_code: code, p_origin: origin }).then(function (j) {
      if (!j || j.ok === false) throw new Error((j && j.err) || '票据无效');
      if (j.token) setSession(j.token, j.uid);
      self = null;
      return j;
    });
  }

  /* E-047：退出登录以前只清自己的 token，而共享会话（从 Chat 沿用）的 token
     还在 localStorage 里 —— 刷新页面后又被"沿用"回来，等于退不掉。
     用户以为退出了，实际会话还在，而云盘里存的是他的代码。
     所以退出时若检测到是沿用态，明确告知真正退出的地方在哪。 */
  function logout() {
    var shared = isSharedSession();
    return rpc('logout', {}).then(function () { dropSession(); }, function () { dropSession(); })
      .then(function () {
        if (shared) {
          /* Chat 的 token 我们无权删（那是另一个应用的会话），只能如实说明 */
          if (Code.util && Code.util.modal) {
            Code.util.modal({
              title: '已退出（但登录态来自 Chat）',
              body: '<p class="about-p">Code 与 Chat 在同一域名下，共用同一份登录态。</p>' +
                '<p class="about-p">刚才退出的是 Code 自己这一侧；' +
                '<b>Chat 的登录信息仍在本机</b>，刷新后会被自动沿用回来，看起来像"没退出"。</p>' +
                '<p class="about-p">要真正退出，请到 Chat 里退出登录。</p>',
              actions: [{ label: '知道了', primary: true }]
            });
          }
        }
      });
  }

  function me(force) {
    if (self && !force) return Promise.resolve(self);
    return rpc('code_me', {}).then(function (j) {
      if (!j || j.ok === false) { self = null; throw new Error((j && j.err) || '未登录'); }
      self = j;
      return j;
    });
  }

  /* ---------------- 云盘 ---------------- */
  function fileList() { return okRpc('code_file_list', {}); }
  function fileGet(p) { return okRpc('code_file_get', { p_path: p }); }
  function fileSave(p, content) { return okRpc('code_file_save', { p_path: p, p_content: content }); }
  function fileDelete(p) { return okRpc('code_file_delete', { p_path: p }); }
  function cloudReset() { return okRpc('code_cloud_reset', { p_confirm: 'DELETE' }); }

  /* ---------- 批量：上传 / 下载 ----------
   *
   * 为什么不做"自动双向同步"：
   *   两端都能改的时候，冲突该听谁的没有正确答案。
   *   自作主张挑一个，代价是用户某次修改被静默覆盖 —— 这是最坏的结果。
   *   所以把方向交给用户明确选择，且下载前弹确认。
   *
   * 为什么逐个串行而不并发：
   *   一是免费版后端有并发限制，二是中途失败时已经传了多少一目了然。
   */
  function txt_len(t) { try { return t == null ? 0 : String(t).length; } catch (e) { return 0; } }

  function pushAll(onProgress) {
    var files = [];
    try {
      var all = (global.Code.fs && global.Code.fs.list) ? global.Code.fs.list() : [];
      files = all.filter(function (r) { return r && r.type === 'file'; });
    } catch (e) { return Promise.reject(new Error('读取本地文件失败')); }

    if (!files.length) return Promise.resolve({ pushed: 0, failed: 0, total: 0 });

    /* 进度按字节算，不按文件数。
       以前回调的是 (第几个/共几个)，传一个 2 MB 大文件时
       状态栏会一直停在"传输中 3/10"不动 —— 用户看到的是卡死，
       于是刷新，前功尽弃。文件数进度对小文件够用，对大文件毫无意义，
       而这里恰恰是大文件最需要反馈。
       所以先量总字节，回调带上"已传字节 / 总字节"。 */
    var pushed = 0, failed = 0, lastErr = '';
    var i = 0, doneBytes = 0;
    var totalBytes = 0;
    try {
      files.forEach(function (r) {
        var t = (global.Code.fs && global.Code.fs.read) ? global.Code.fs.read(r.path) : '';
        totalBytes += (t == null ? 0 : String(t).length);
      });
    } catch (e) { totalBytes = 0; }

    function report(name) {
      if (!onProgress) return;
      onProgress({
        done: doneBytes, total: totalBytes,
        index: i, count: files.length, name: name
      });
    }

    function step() {
      if (i >= files.length) {
        return Promise.resolve({ pushed: pushed, failed: failed, total: files.length, lastErr: lastErr });
      }
      var p = files[i].path;
      i++;
      return Promise.resolve()
        .then(function () {
          return (global.Code.fs && global.Code.fs.read) ? global.Code.fs.read(p) : '';
        })
        .then(function (txt) {
          report(p);
          var len = txt_len(txt);
          return fileSave(p, txt == null ? '' : String(txt))
            .then(function () { pushed++; doneBytes += len; report(p); });
        }, function (e) {
          failed++; lastErr = String((e && e.message) || e);
        })
        .then(step);
    }
    return step();
  }

  function pullAll(onProgress) {
    return fileList().then(function (list) {
      var arr = Array.isArray(list) ? list : [];
      if (!arr.length) return { pulled: 0, failed: 0, total: 0 };

      var pulled = 0, failed = 0, lastErr = '';
      var i = 0, doneBytes = 0;
      /* 与 pushAll 同一套口径：按字节算。size 是云端记的字节数，
         取不到就按 0 计入 —— 宁可进度条走得慢一点，也不要报一个假数字。 */
      var totalBytes = 0;
      arr.forEach(function (r) { totalBytes += Number(r && r.size) || 0; });

      function report(name) {
        if (!onProgress) return;
        onProgress({ done: doneBytes, total: totalBytes, index: i, count: arr.length, name: name });
      }

      function step() {
        if (i >= arr.length) {
          return Promise.resolve({ pulled: pulled, failed: failed, total: arr.length, lastErr: lastErr });
        }
        var item = arr[i];
        i++;
        var p = item && item.path;
        if (!p) return step();
        report(p);
        return fileGet(p).then(function (r) {
          var content = (r && r.content != null) ? r.content : '';
          if (global.Code.fs && global.Code.fs.write) {
            return global.Code.fs.write(p, content)
              .then(function () { doneBytes += txt_len(content); });
          }
          return null;
        }).then(function () {
          pulled++;
          report(p);
        }, function (e) {
          failed++; lastErr = String((e && e.message) || e);
        }).then(step);
      }
      return step();
    });
  }

  Code.cloud = {
    loadCfg: loadCfg, configure: configure, isOn: isOn,
    siteReady: siteReady,
    gateCheck: gateCheck, login: login, register: register, redeem: redeem, logout: logout,
    me: me,
    fileList: fileList, fileGet: fileGet, fileSave: fileSave, fileDelete: fileDelete,
    cloudReset: cloudReset, pushAll: pushAll, pullAll: pullAll,
    token: token, uid: uid, setSession: setSession, dropSession: dropSession,
    isSharedSession: isSharedSession,
    rpc: rpc,
    /* 给设置面板显示用 */
    endpoint: function () { loadCfg(); return url; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
