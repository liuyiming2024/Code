/* ai.js —— AI 辅助（用户自带密钥）
 *
 * 三条不能破的规矩：
 *   1. **密钥只存本机 localStorage**，仓库里没有、也不经过任何中间服务器。
 *   2. **没有密钥就不渲染入口**——不是"渲染了点下去报错"，那样是误导。
 *   3. **请求直连用户选的服务商**，本项目不经手。
 *
 * 为什么预置智谱：它是唯一在官方定价页写明"永久免费、无 Token 上限"的
 * （GLM-4.7-Flash，仅限制并发数）。新用户另送 2000 万 tokens。
 * 预置配置只是省得手抄地址，密钥依然要用户自己去拿。
 *
 * 兼容 OpenAI 的 /v1/chat/completions 格式，
 * 所以换任何一家都只需要改 baseURL 和 model。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var LS_KEY = 'code-ai-config';
  var LS_LOG = 'code-ai-log';

  /* 政策探测：不问官网，看你自己的调用记录。
     静态页面没法跨域去读服务商官网（会被 CORS 拦），
     所以与其做一个永远失败的"检测"，不如记录真实调用结果：
     上次成功是什么时候、连续失败几次、错在哪。
     这反映的是你这个 key 的真实处境，比网上任何说法都准。 */
  function loadLog() {
    try {
      var raw = localStorage.getItem(LS_LOG);
      if (raw) return JSON.parse(raw);
    } catch (e) { }
    return { ok: 0, lastOk: null, lastErr: null, fails: 0, model: '', base: '' };
  }

  function saveLog(next) {
    var cur = Object.assign(loadLog(), next || {});
    try { localStorage.setItem(LS_LOG, JSON.stringify(cur)); } catch (e) { }
    return cur;
  }

  /* 判断当前配置是否还健康。
     连续失败 3 次以上就明确提示——不是猜，是证据。 */
  function health() {
    var L = loadLog();
    var c = load();
    /* 换了服务商或模型，旧记录就不算数了 */
    if (L.model !== c.model || L.base !== c.baseURL) {
      return { state: 'unknown', text: '（当前配置尚无调用记录）' };
    }
    if (L.lastOk && L.fails === 0) {
      var days = Math.floor((Date.now() - L.lastOk) / 86400000);
      var when = days === 0 ? '今天' : days === 1 ? '昨天' : days + ' 天前';
      return { state: 'ok', text: '上次成功：' + when };
    }
    if (L.fails >= 3) {
      return {
        state: 'bad',
        text: '连续失败 ' + L.fails + ' 次' + (L.lastErr ? '（' + L.lastErr + '）' : '') +
          '。可能是密钥失效或该模型已不再免费，请核对官方定价页。'
      };
    }
    if (L.fails > 0) {
      return {
        state: 'warn',
        text: '失败 ' + L.fails + ' 次' + (L.lastErr ? '（' + L.lastErr + '）' : '') +
          (L.lastOk ? '；上次成功 ' + Math.floor((Date.now() - L.lastOk) / 86400000) + ' 天前' : '')
      };
    }
    return { state: 'unknown', text: '（尚无调用记录）' };
  }

  /* 预置服务商。改地址前先想清楚：免费额度政策变得快，
     这里的地址和模型名是写这份代码时的状态，用户可自己改。 */
  var PRESETS = [
    {
      id: 'zhipu',
      name: '智谱 GLM（推荐 · 永久免费）',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.7-flash',
      keyURL: 'https://open.bigmodel.cn/usercenter/apikeys',
      note: 'GLM-4.7-Flash 输入/输出/缓存均免费，不会产生费用。免费版限 1 并发，响应偏慢。',
      billing: 'free',
      /* 智谱没有官方余额接口。但它每次调用的响应头里带剩余额度，
         所以靠响应头判断，而不是去猜一个可能变动的非官方接口。 */
      quota: 'header',
      warn: '不要改成 GLM-5.3 等付费型号（8 元/百万输入、28 元/百万输出）——那才会扣钱。'
    },
    {
      id: 'siliconflow',
      name: '硅基流动（快 · 并发高）',
      baseURL: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen3-8B',
      keyURL: 'https://cloud.siliconflow.cn/me/account/ak',
      note: '指定小模型（如 Qwen/Qwen3-8B）永久免费，1000 RPM 并发大。需实名。',
      billing: 'free',
      balanceURL: 'https://api.siliconflow.cn/v1/user/info',
      warn: '注意带 Pro/ 前缀的同名模型是付费版，别选错。'
    },
    {
      id: 'nvidia',
      name: 'NVIDIA（模型多 · 不绑卡）',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      model: 'deepseek-ai/deepseek-v3.2',
      keyURL: 'https://build.nvidia.com/settings/api-keys',
      note: '100+ 模型免费、不绑卡、国内可直连，约 40 RPM。模型可能临时下线。',
      billing: 'unknown',
      warn: '未确认是否有公开余额接口，请自行在控制台确认。'
    },
    {
      id: 'deepseek',
      name: 'DeepSeek（强 · 需充值）',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      keyURL: 'https://platform.deepseek.com/api_keys',
      note: '新用户赠额度（30 天有效），之后按量付费。模型能力强。',
      billing: 'paid',
      balanceURL: 'https://api.deepseek.com/user/balance',
      warn: '这个会扣钱。用前建议先查余额。'
    },
    {
      id: 'custom',
      name: '自定义（任何 OpenAI 兼容端点）',
      baseURL: '',
      model: '',
      keyURL: '',
      note: '填你自己的地址与模型名。也可用本地 Ollama（如 http://localhost:11434/v1）。',
      billing: 'unknown',
      warn: '计费情况由你填的那家决定，本工具无法判断。'
    }
  ];

  var cfg = null;

  /* ============ 防欠费：模型白/黑名单 ============
   *
   * 用户担心的不是"能不能用"，是"会不会不知不觉欠费"。
   * 所以这里做三件事：
   *   1. 已知免费的模型 → 静默放行
   *   2. 已知付费的模型 → **明确拦下**，要用户再确认一次
   *   3. 不认识的 → 如实说"不知道"，绝不假装安全
   *
   * 为什么必须拦：智谱的 GLM-4.7-Flash 免费，但 GLM-5.3 是
   * 8 元/百万输入、28 元/百万输出。名字都差不多，手滑选错就扣钱。
   *
   * 名单会过时。所以每条都带 asOf 日期，过期后语气变弱（提示核对），
   * 但仍然拦——宁可多问一句，也不能让人欠费。
   */

  /* 已知免费：精确匹配，命中就放行 */
  var FREE_MODELS = [
    'glm-4.7-flash',
    'glm-4-flash-250414',
    'glm-4.5-flash',
    'glm-4.6v-flash',
    'glm-4.1v-thinking-flash',
    'glm-4v-flash',
    'qwen/qwen3-8b',
    'qwen/qwen2.5-7b-instruct',
    'thudm/glm-4-9b-0414',
    'thudm/glm-z1-9b-0414'
  ];

  /* 已知付费：命中就拦。可以只写片段（小写包含匹配），
     因为同一系列往往整系收费。 */
  var PAID_PATTERNS = [
    'glm-5',            /* GLM-5.3 / 5.3-Flash / 5.2 … 整系收费 */
    'glm-4-plus',
    'glm-4-air',
    'glm-4-long',
    'glm-4.6',
    'deepseek-chat',    /* DeepSeek 官方:按量计费 */
    'deepseek-reasoner',
    'deepseek-r1',
    'pro/',             /* 硅基流动的 Pro/ 前缀是付费版 */
    'gpt-',             /* OpenAI 系 */
    'claude'
  ];

  /* 这个名单的核对日期。超过 90 天后提示"请重新核对"，但仍然拦。 */
  var LIST_ASOF = '2026-10-11';

  function isListStale() {
    try {
      var t = new Date(LIST_ASOF).getTime();
      if (isNaN(t)) return false;
      return (Date.now() - t) > 90 * 86400000;
    } catch (e) { return false; }
  }

  /* 判定一个模型名的计费状态。返回 'free' | 'paid' | 'unknown' */
  function billingOf(model) {
    var m = String(model || '').trim().toLowerCase();
    if (!m) return 'unknown';
    /* 先查免费白名单（精确） */
    for (var i = 0; i < FREE_MODELS.length; i++) {
      if (m === FREE_MODELS[i]) return 'free';
    }
    /* 再查付费特征（包含匹配） */
    for (var k = 0; k < PAID_PATTERNS.length; k++) {
      if (m.indexOf(PAID_PATTERNS[k]) >= 0) return 'paid';
    }
    return 'unknown';
  }

  /* 给用户的说明文字。付费的要说得直白，别绕。 */
  function billingText(model) {
    var st = billingOf(model);
    if (st === 'free') {
      return { state: 'free', text: '免费型号，不会产生费用。' };
    }
    if (st === 'paid') {
      return {
        state: 'paid',
        text: '【注意】这是<b>付费型号</b>，调用会扣你的钱。' +
          (isListStale() ? '<br>（名单核对于 ' + LIST_ASOF + '，已超过 90 天，请以服务商官网为准）' : '') +
          '<br>想不花钱，请改用 <code>glm-4.7-flash</code>。'
      };
    }
    return {
      state: 'unknown',
      text: '【注意】无法判断这个型号的计费情况。' +
        '<br>本工具只认识少数几个确认免费的型号，其余一律<b>不敢替你保证</b>。' +
        '<br>请在服务商官网确认后再用。'
    };
  }

  /* 付费型号是否允许发送。返回 Promise<boolean>。
     交给界面弹确认框，这里不自己决定——改需求不是我的活。 */
  function confirmPaid(model) {
    var st = billingOf(model);
    if (st === 'free') return Promise.resolve(true);
    return new Promise(function (resolve) {
      var info = billingText(model);
      var body = '<p class="about-p">' + info.text + '</p>' +
        '<p class="about-p">型号：<code>' + String(model).replace(/</g, '&lt;') + '</code></p>';
      if (window.Code && window.Code.ui && window.Code.ui.modal) {
        window.Code.ui.modal({
          title: st === 'paid' ? '这个型号要花钱' : '计费情况不明',
          body: body,
          actions: [
            { label: '取消', primary: true, onClick: function () { resolve(false); } },
            {
              label: st === 'paid' ? '我确定，继续' : '我已知情，继续',
              onClick: function () { resolve(true); }
            }
          ]
        });
      } else {
        resolve(window.confirm(info.text.replace(/<[^>]+>/g, '')));
      }
    });
  }

  function defaults() {
    return {
      enabled: false,
      preset: 'zhipu',
      baseURL: PRESETS[0].baseURL,
      model: PRESETS[0].model,
      apiKey: ''
    };
  }

  function load() {
    if (cfg) return cfg;
    cfg = defaults();
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
    } catch (e) { /* 读不到就用默认，不阻断 */ }
    return cfg;
  }

  function save(next) {
    cfg = Object.assign(load(), next || {});
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { }
    return cfg;
  }

  /* 是否可用：必须有 key 和地址。这是"能不能点"的唯一判据。 */
  function ready() {
    var c = load();
    return !!(c.enabled && c.apiKey && c.baseURL);
  }

  function preset(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  /* 端点拼接：用户填的地址可能带也可能不带 /v1，也可能已带 /chat/completions。
     统一处理，避免"填对了却 404"这种最让人抓狂的失败。 */
  function endpoint(base) {
    var b = String(base || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    if (/\/chat\/completions$/.test(b)) return b;
    if (/\/v\d+$/.test(b)) return b + '/chat/completions';
    return b + '/v1/chat/completions';
  }

  /* ---------- 调用 ---------- */
  /* messages: OpenAI 格式数组。onDelta 用于流式（可选）。 */
  function chat(messages, opts) {
    opts = opts || {};
    var c = load();
    if (!ready()) return Promise.reject(new Error('尚未配置 AI：请先填入密钥'));

    /* 付费型号先问一次。skipPaidCheck 只在测试连接时用——
       测试发的是极短请求，且用户刚点过"测试"，重复弹窗烦人。
       真正的代码解释/改写一律要确认。 */
    if (!opts.skipPaidCheck && billingOf(c.model) !== 'free') {
      return confirmPaid(c.model).then(function (ok) {
        if (!ok) throw new Error('已取消（未发送，未产生费用）');
        return doChat(c, messages, opts);
      });
    }
    return doChat(c, messages, opts);
  }

  function doChat(c, messages, opts) {
    var url = endpoint(c.baseURL);
    var body = {
      model: c.model || 'glm-4.7-flash',
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      stream: !!opts.onDelta
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, opts.timeout || 60000);

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + c.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('AI 请求失败：HTTP ' + res.status + ' ' + readable(res.status) +
            '\n' + String(t || '').slice(0, 400));
        });
      }
      if (!opts.onDelta) {
        return res.json().then(function (j) {
          return {
            text: pickText(j),
            raw: j
          };
        });
      }
      /* 流式 SSE */
      return readStream(res, opts.onDelta);
    }).then(function (r) {
      clearTimeout(timer);
      /* 成功：清零失败计数，记下时间 */
      saveLog({ ok: (loadLog().ok || 0) + 1, lastOk: Date.now(), fails: 0,
                lastErr: null, model: c.model, base: c.baseURL });
      return r;
    }, function (e) {
      clearTimeout(timer);
      var msg = (e && e.name === 'AbortError') ? '超时' : String(e && e.message || e).split('\n')[0];
      saveLog({ fails: (loadLog().fails || 0) + 1, lastErr: msg.slice(0, 80),
                model: c.model, base: c.baseURL });
      if (e && e.name === 'AbortError') throw new Error('AI 请求超时（已中止）');
      throw e;
    });
  }

  /* 不同家返回结构略有差异，逐个兜底 */
  function pickText(j) {
    if (!j) return '';
    if (j.choices && j.choices[0]) {
      var m = j.choices[0].message;
      if (m && typeof m.content === 'string') return m.content;
      /* 有些家把思考过程放在 reasoning_content，正文在 content */
      if (m && typeof m.reasoning_content === 'string' && !m.content) return m.reasoning_content;
    }
    if (typeof j.content === 'string') return j.content;
    return '';
  }

  function readable(code) {
    var map = {
      401: '（密钥不对或已失效）',
      403: '（没有权限，可能是未实名或未开通该模型）',
      404: '（地址不对，检查接口地址）',
      429: '（触发限流，稍后再试）',
      500: '（服务端错误）',
      503: '（服务不可用或模型已下线）'
    };
    return map[code] || '';
  }

  function readStream(res, onDelta) {
    if (!res.body || !res.body.getReader) {
      return res.json().then(function (j) {
        var t = pickText(j);
        onDelta(t);
        return { text: t, raw: j };
      });
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', full = '';
    return pump();
    function pump() {
      return reader.read().then(function (step) {
        if (step.done) return { text: full, raw: null };
        buf += dec.decode(step.value, { stream: true });
        var lines = buf.split('\n');
        buf = lines.pop() || '';
        lines.forEach(function (ln) {
          ln = ln.trim();
          if (!ln || ln.indexOf('data:') !== 0) return;
          var d = ln.slice(5).trim();
          if (d === '[DONE]') return;
          try {
            var j = JSON.parse(d);
            var delta = (j.choices && j.choices[0] && j.choices[0].delta) || {};
            var piece = typeof delta.content === 'string' ? delta.content : '';
            if (piece) { full += piece; onDelta(piece); }
          } catch (e) { /* 半包或注释行，跳过 */ }
        });
        return pump();
      });
    }
  }

  /* ---------- 预设任务 ---------- */
  var SYS = '你是嵌在代码编辑器里的助手。回答要简洁、直接给代码或结论，不要客套。' +
    '除非用户说明，否则不要改变代码的整体风格（缩进、运算符间距都要跟原文一致）。';

  function askAbout(codeText, question, langName) {
    var prompt = '语言：' + (langName || '未知') + '\n\n代码：\n```\n' + codeText + '\n```\n\n' + question;
    return chat([
      { role: 'system', content: SYS },
      { role: 'user', content: prompt }
    ], {});
  }

  function explain(codeText, langName) {
    return askAbout(codeText, '用中文简要解释这段代码做什么，指出可能的问题。', langName);
  }

  function rewrite(codeText, instruction, langName) {
    var p = '语言：' + (langName || '未知') + '\n\n原代码：\n```\n' + codeText + '\n```\n\n' +
      '要求：' + instruction + '\n\n' +
      '只输出改写后的完整代码，不要解释，不要 markdown 代码块标记。' +
      '缩进与运算符间距必须与原代码一致。';
    return chat([{ role: 'system', content: SYS }, { role: 'user', content: p }], {});
  }

  /* 删除密钥 */
  function clearKey() {
    return save({ apiKey: '', enabled: false });
  }

  Code.ai = {
    PRESETS: PRESETS,
    load: load,
    save: save,
    ready: ready,
    preset: preset,
    endpoint: endpoint,
    chat: chat,
    explain: explain,
    rewrite: rewrite,
    askAbout: askAbout,
    clearKey: clearKey,
    billingOf: billingOf,
    billingText: billingText,
    confirmPaid: confirmPaid,
    isListStale: isListStale,
    FREE_MODELS: FREE_MODELS,
    PAID_PATTERNS: PAID_PATTERNS,
    health: health,
    loadLog: loadLog,
    resetLog: function () { saveLog({ ok: 0, lastOk: null, lastErr: null, fails: 0 }); },
    _pickText: pickText
  };
})(typeof window !== 'undefined' ? window : globalThis);
