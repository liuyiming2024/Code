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

  /* 预置服务商。改地址前先想清楚：免费额度政策变得快，
     这里的地址和模型名是写这份代码时的状态，用户可自己改。 */
  var PRESETS = [
    {
      id: 'zhipu',
      name: '智谱 GLM（推荐 · 永久免费）',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.7-flash',
      keyURL: 'https://open.bigmodel.cn/usercenter/apikeys',
      note: 'GLM-4.7-Flash 官方标注永久免费、无 Token 上限（免费版限 1 并发，响应偏慢）。国内手机号注册。',
      free: true
    },
    {
      id: 'siliconflow',
      name: '硅基流动（快 · 并发高）',
      baseURL: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen3-8B',
      keyURL: 'https://cloud.siliconflow.cn/me/account/ak',
      note: '部分小模型永久免费（7B–9B），1000 RPM 并发大。需实名。模型名以控制台为准。',
      free: true
    },
    {
      id: 'nvidia',
      name: 'NVIDIA（模型多 · 不绑卡）',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      model: 'deepseek-ai/deepseek-v3.2',
      keyURL: 'https://build.nvidia.com/settings/api-keys',
      note: '100+ 模型免费、不绑卡、国内可直连，约 40 RPM。模型可能临时下线。',
      free: true
    },
    {
      id: 'deepseek',
      name: 'DeepSeek（强 · 需充值）',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      keyURL: 'https://platform.deepseek.com/api_keys',
      note: '新用户赠约 500 万 tokens（30 天有效），之后按量付费。模型能力强。',
      free: false
    },
    {
      id: 'custom',
      name: '自定义（任何 OpenAI 兼容端点）',
      baseURL: '',
      model: '',
      keyURL: '',
      note: '填你自己的地址与模型名。也可用本地 Ollama（如 http://localhost:11434/v1）。',
      free: null
    }
  ];

  var cfg = null;

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
      return r;
    }, function (e) {
      clearTimeout(timer);
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
    _pickText: pickText
  };
})(typeof window !== 'undefined' ? window : globalThis);
