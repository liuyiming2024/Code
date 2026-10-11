/* pwa.js —— 注册离线缓存 + 新版本提示
 *
 * 两件事：
 *   1. 注册 sw.js，让装到桌面/主屏之后断网也能用。
 *   2. 有新版本时提示用户刷新。
 *
 * 为什么不在新版本装好时直接接管：
 *   用户可能正在写代码。skipWaiting 会让页面立刻切到新代码，
 *   正在编辑的内容有可能丢。所以先等，让他自己决定什么时候刷新。
 *
 * 为什么全程要防御：
 *   file:// 下没有 serviceWorker，localhost 之外的 http 也不行。
 *   注册只是锦上添花，**失败绝不能影响编辑器启动**。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  function supported() {
    try {
      return !!(navigator.serviceWorker && 'caches' in global);
    } catch (e) {
      return false;   /* 某些环境访问 navigator 本身就会抛 */
    }
  }

  /* 只在安全上下文注册：https 或 localhost。file:// 直接跳过。 */
  function canRegister() {
    try {
      var p = location.protocol;
      if (p === 'file:') return false;
      if (p === 'https:') return true;
      /* localhost 算安全上下文，本地起服务时用得上 */
      return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  /* ---------- 安装到桌面 / 手机主屏 ----------
     浏览器只在满足条件时才给 beforeinstallprompt 事件，
     所以按钮默认隐藏，能装才显示 —— 显示一个点了没反应的按钮是误导。 */
  var deferredPrompt = null;

  function isInstalled() {
    try {
      if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) return true;
      if (global.navigator && navigator.standalone) return true;   /* iOS */
    } catch (e) { }
    return false;
  }

  function bindInstall() {
    var btn = document.getElementById('btn-install');
    if (!btn) return;

    if (isInstalled()) { btn.classList.remove('can'); return; }

    global.addEventListener('beforeinstallprompt', function (e) {
      /* 阻止默认的小横幅，改由我们的按钮触发 */
      e.preventDefault();
      deferredPrompt = e;
      btn.classList.add('can');
    });

    global.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      btn.classList.remove('can');
    });

    btn.addEventListener('click', function () {
      if (!deferredPrompt) {
        /* 没有事件可用（比如 iOS Safari）：如实告诉用户怎么手动装 */
        tipManualInstall();
        return;
      }
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;
        btn.classList.remove('can');
      });
    });
  }

  function tipManualInstall() {
    var msg = /iPhone|iPad|iPod/i.test(navigator.userAgent || '')
      ? 'iPhone/iPad：用 Safari 打开本页，点底部「分享」→「添加到主屏幕」。'
      : '请在浏览器菜单里找「安装此站点」或「添加到桌面」。' +
        '（桌面版 Chrome / Edge 地址栏右侧通常有安装图标）';
    try {
      if (Code.ui && Code.ui.modal) {
        Code.ui.modal({
          title: '如何安装',
          body: '<p class="about-p">' + msg + '</p>',
          actions: [{ label: '知道了', primary: true }]
        });
      } else {
        global.alert(msg);
      }
    } catch (e) { }
  }

  function register() {
    bindInstall();
    if (!supported() || !canRegister()) return Promise.resolve(false);
    return navigator.serviceWorker.register('sw.js', { scope: './' })
      .then(function (reg) {
        watchUpdate(reg);
        return true;
      })
      .catch(function () {
        /* 注册失败只是没有离线能力，编辑器照常用 */
        return false;
      });
  }

  /* 监听新版本。装好后不立即接管，提示用户。 */
  function watchUpdate(reg) {
    if (!reg) return;

    /* 已经有一个在等待（比如上次刷新前就装好了） */
    if (reg.waiting) return promptUpdate(reg.waiting);

    reg.addEventListener('updatefound', function () {
      var nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', function () {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          /* controller 存在说明当前是被旧版控制的，确实是有更新 */
          promptUpdate(nw);
        }
      });
    });
  }

  var prompted = false;

  function promptUpdate(worker) {
    if (prompted) return;
    prompted = true;

    var doReload = function () {
      if (!worker) return location.reload();
      /* 让 SW 接管，然后刷新 */
      var channel = new MessageChannel();
      worker.postMessage({ type: 'SKIP_WAITING' });
      /* 等 controllerchange 再刷新，否则可能刷新后还是旧的 */
      var done = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (done) return;
        done = true;
        location.reload();
      });
      /* 兜底：万一事件没来，2 秒后也刷新 */
      setTimeout(function () { if (!done) { done = true; location.reload(); } }, 2000);
      return channel;
    };

    try {
      if (Code.ui && Code.ui.modal) {
        Code.ui.modal({
          title: '有新版本',
          body: '<p class="about-p">新版本已在后台准备好。刷新后生效。</p>' +
            '<p class="about-p">当前正在编辑的内容会先保存，刷新不影响文件。</p>',
          actions: [
            { label: '稍后', primary: true },
            { label: '立即刷新', onClick: doReload }
          ]
        });
      } else {
        if (global.confirm('有新版本，是否刷新？')) doReload();
      }
    } catch (e) {
      /* 提示失败就算了，不能因为弹窗出错影响别的 */
    }
  }

  Code.pwa = {
    register: register,
    supported: supported,
    canRegister: canRegister,
    isInstalled: isInstalled
  };
})(typeof window !== 'undefined' ? window : globalThis);
