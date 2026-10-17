/* drive.js —— 与「加密网盘」（Cloud）互通
 *
 * ---------- 这是两个不同的东西，别混为一谈 ----------
 *   本项目云盘（code_files）  走 Supabase，秒级，存代码原文，按文件同步
 *   加密网盘（Cloud）          走 GitHub Actions，要等几十秒，内容在离开浏览器前就加密好了
 *
 * 两者账号是同一套（都是全站统一身份），但**存储完全独立**，
 * 不会自动互相同步 —— 自动同步没有正确答案，冲突该听谁的只能由人决定。
 *
 * ---------- 为什么用隐藏 iframe ----------
 * Cloud 的接口是**页面内**的 `Cloud.api`（它读本机 localStorage，
 * 不提供任何站外可调用的写入接口 —— Pages 是纯静态托管，没有服务端可代理）。
 * 所以无法 fetch 调用。
 *
 * 但 Cloud 与 Code **同源**（都在 liuyiming2024.github.io），
 * 同源 iframe 的 contentWindow 可以直接访问，不需要 postMessage。
 * 于是把它当作一个"活的模块"加载进来用。
 *
 * ⚠ 三条边界必须写清楚，否则后来的人会误用：
 *   1. 只在浏览器里成立。原生端、非同源部署一律不可用（那时走跳转）。
 *   2. **口令不跨页面传**。专业模式（自己设的口令）不会被记住，
 *      所以在 Code 里必须重新 unlock()；简单模式（账号派生）能自动就绪。
 *   3. 上传下载都要等几十秒（Actions 搬一趟）。界面必须给出等待反馈，
 *      否则用户会以为卡死然后刷新 —— 而刷新丢的是已经等了的那半分钟。
 *
 * ⚠ 整个模块**失败必须静默降级**：加密网盘用不了，项目云盘照样能跑。
 *   绝不能因为它挂了就让云盘视图白屏。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var CLOUD_PAGE = 'https://liuyiming2024.github.io/Cloud/';

  /* ---------- 契约版本 ----------
     对面（Cloud）在 Cloud.api 上声明了 version。**改接口必须跟着 bump**。
     这边记下自己认得的范围，超出就明确报不兼容。
     不查版本的话，对面改了方法名而我们照旧调用，报的是
     "加密网盘没有 xxx 这个方法" —— 看不出是版本问题，只会以为功能坏了。 */
  var MIN_VER = 1, MAX_VER = 99;

  var READY_TIMEOUT = 20000;   /* Cloud 页面要 fetch 账号信息，慢通道也可能在跑 */
  var POLL = 120;

  var frame = null;
  var bootPromise = null;

  function sameOrigin() {
    try {
      return location.origin === new URL(CLOUD_PAGE).origin;
    } catch (e) { return false; }
  }

  /* iframe 不能用 display:none —— 那样部分浏览器会推迟/暂停加载，
     脚本根本不执行。放屏幕外，且尺寸给 1x1（不是 0，0 也可能被优化掉）。 */
  function makeFrame() {
    if (frame && frame.contentWindow) return frame;
    var f = document.createElement('iframe');
    f.src = CLOUD_PAGE;
    f.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0';
    f.setAttribute('aria-hidden', 'true');
    f.setAttribute('tabindex', '-1');
    /* 不给它任何额外权限 —— 它只需要跑自己的脚本 */
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    document.body.appendChild(f);
    frame = f;
    return f;
  }

  /* 等到 Cloud.api 就绪。
     ⚠ 必须等 `ensure()` 跑完（它要 fetch 账号的注册时间来派生口令），
        只等 `Cloud.api` 这个对象出现是不够的 —— 那时 ready() 还是 false，
        调用会得到"还没初始化"。 */
  function boot() {
    if (bootPromise) return bootPromise;
    if (!sameOrigin()) {
      bootPromise = Promise.reject(new Error('不同源，只能跳转到加密网盘使用'));
      return bootPromise;
    }
    bootPromise = new Promise(function (resolve, reject) {
      var f = makeFrame();
      var t0 = Date.now();
      var timer = setInterval(function () {
        var api = null;
        try { api = f.contentWindow && f.contentWindow.Cloud && f.contentWindow.Cloud.api; }
        catch (e) { /* 加载中，跨域还没就绪，继续等 */ }
        if (!api) {
          if (Date.now() - t0 > READY_TIMEOUT) { clearInterval(timer); reject(new Error('加密网盘迟迟没就绪')); }
          return;
        }
        /* api 对象在，但内部 ensure() 可能是异步的 —— 用 ready()/reason() 判 */
        if (api.ready()) {
          clearInterval(timer);
          /* 版本只在就绪后查一次：没就绪时 version 也可能还没定 */
          var v = Number(api.version || 0);
          if (v && (v < MIN_VER || v > MAX_VER)) {
            reject(new Error('加密网盘接口版本 ' + v + ' 不在这边支持的范围内'));
            return;
          }
          resolve(api);
          return;
        }
        var r = '';
        try { r = api.reason() || ''; } catch (e) { }
        /* reason 为 null 表示可用；还在"还没初始化"就继续等 */
        if (r && r !== '还没初始化' && Date.now() - t0 > 3000) {
          clearInterval(timer); reject(new Error(r));
        }
        if (Date.now() - t0 > READY_TIMEOUT) {
          clearInterval(timer);
          reject(new Error(r || '加密网盘迟迟没就绪'));
        }
      }, POLL);
    });
    /* 失败要能重试：换过账号、填过令牌之后应该能再来一次 */
    bootPromise.catch(function () { bootPromise = null; });
    return bootPromise;
  }

  function call(name, args) {
    return boot().then(function (api) {
      if (typeof api[name] !== 'function') throw new Error('加密网盘没有 ' + name + ' 这个方法');
      return api[name].apply(api, args || []);
    });
  }

  var Drive = {
    page: CLOUD_PAGE,
    /* 能不能用（同源 + 有令牌 + 有账号） */
    usable: function () { return sameOrigin(); },

    /* 状态：{ ok, reason } —— 不问用户要任何东西，只是如实报告 */
    status: function () {
      if (!sameOrigin()) return Promise.resolve({ ok: false, reason: '不同源', canJump: true });
      return boot().then(function (api) {
        var ch = 'actions';
        try { if (typeof api.channel === 'function') ch = api.channel() || 'actions'; } catch (e) { }
        return {
          ok: !!api.ready(), reason: api.reason() || null,
          who: api.who(), channel: ch, version: Number(api.version || 0)
        };
      }).catch(function (e) {
        return { ok: false, reason: String((e && e.message) || e), canJump: true };
      });
    },

    list: function () { return call('list', []); },
    remove: function (id) { return call('remove', [id]); },
    limits: function () { return call('limits', []); },

    /* 上传。file 可以是 File/Blob；name 必填 ——
       Blob 自己没名字，不给名字存进去就是一堆认不出的条目。

       proc 是**给对面的建议**：'auto'（压了更小才压，默认）/'gzip'/'none'。

       ⚠⚠ 我们绝不能自己先把内容压一遍再传 ——
         对面的容器是「先压缩，再加密」，压缩发生在它内部。
         我们传过去的是**明文**，它压完再加密；
         下载时它解密完再按密文头里的标记自动解压还原。
         要是我们提前压了，它拿到的是 gzip 二进制当明文存，
         下载出来还是二进制，而 Code 里打开的就是一坨乱码，
         而且**没有任何报错** —— 文件在，只是打不开。
         所以这里只传建议，实际压缩交给对面。 */
    upload: function (file, name, proc) {
      return call('upload', [file, name, proc || 'auto']);
    },

    /* 下载，返回明文 Blob */
    download: function (id) { return call('download', [id]); },

    /* 专业模式：口令不跨页面存，所以每次都要显式交一次。
       只在本次会话的 iframe 里有效，不会写进任何存储。 */
    unlock: function (pass) { return call('unlock', [pass]); },

    /* ---------- 反向：项目云盘 → 加密网盘 ----------
       对面（Cloud）在被嵌进来时会挂上 CloudBridge，
       它借这边的能力去读项目云盘，再把内容转存进加密网盘。
       方向是**单向**的、由人发起的，不是自动同步。 */
    importFromCode: function (path) {
      return boot().then(function () {
        var B = null;
        try { B = frame && frame.contentWindow && frame.contentWindow.CloudBridge; } catch (e) { }
        if (!B || typeof B.importFromCode !== 'function') {
          throw new Error('对面没有提供转存通道（可能不是当模块加载的）');
        }
        return B.importFromCode(path);
      });
    },
    canImport: function () {
      try {
        var B = frame && frame.contentWindow && frame.contentWindow.CloudBridge;
        return !!(B && typeof B.importFromCode === 'function');
      } catch (e) { return false; }
    },

    reset: function () {
      bootPromise = null;
      if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
      frame = null;
    }
  };

  /* 有些失败是**对面代码里的问题**，不是用户操作问题。
     不识别的话，用户看到"上传失败：xxx is not defined"只会以为自己用错了，
     反复重试、甚至去改自己的文件。而真正的原因在另一个仓库里。 */
  function explain(m) {
    m = String(m || '');
    /* 对面 js/pageapi.js 的 upload(file, name, proc) 里，
       调用 encryptBlob 时写的是 procArg —— 而参数名是 proc，
       procArg 从未定义。所以任何一次 upload 都会抛
       ReferenceError: procArg is not defined。
       这个只能由对面改：把 procArg 改成 proc（或删掉第三参走默认）。 */
    if (/procArg/.test(m)) {
      return '加密网盘那边上传接口有个变量名写错了（procArg 未定义），' +
        '得他们改。你这边重试没用。';
    }
    if (/is not defined/.test(m)) return '加密网盘那边脚本报错了，与你的文件无关：' + m;
    return null;
  }
  Drive.explain = explain;

  Code.drive = Drive;
})(typeof window !== 'undefined' ? window : globalThis);
