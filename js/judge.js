/* ============================================================
   本地判题器
   ------------------------------------------------------------
   做这件事的起因：竞赛选手真正需要的不是"跑一下看看输出"，
   而是**拿样例验证对不对** —— 一组一组喂进去，逐条比对，
   第几组错了、期望什么、实得什么。

   全部在本机完成，**不联网、不涉及任何外部平台**。

   ---------- 为什么不做"爬题 + 代提交" ----------
   那个想法（Vjudge 式）这里明确写下来，免得以后再绕回来：

     · 主流 OJ 都有反爬与人机验证（Cloudflare / 验证码），
       爬虫本身就是持续对抗，且随时失效
     · 用用户自己的账号密码代提交，多数平台的服务条款不允许
     · 更要紧的是凭据：一旦我们存了用户的 OJ 密码，
       它就变成一个有价值的攻击目标 —— 而本项目是纯前端、无后端，
       本来没有任何东西值得偷
   所以不做。本地判题 + 自己粘题面，是既合规又真正有用的部分。

   ---------- 三个必须做对的比对细节 ----------
   ① 行尾空格要忽略：选手手敲的样例几乎都带，判成 WA 纯属折磨
   ② 末尾换行要忽略：有人多敲一个空行，跟算法对不对毫无关系
   ③ \r\n 要归一：Windows 复制过来的样例带回车符

   这三条不处理，判题器会大量误报 WA ——
   用户会去查根本不存在的算法错误，这是最浪费时间的一类。
   ============================================================ */
(function (root) {
  'use strict';
  var Code = root.Code || (root.Code = {});

  /* ---------- 归一化：见文件头三条 ---------- */
  function norm(s) {
    if (s == null) return '';
    return String(s)
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .split('\n')
      .map(function (l) { return l.replace(/[ \t]+$/, ''); })
      .join('\n')
      .replace(/\n+$/, '');
  }
  /* 严格模式：只归一换行，不动空格（有些题确实在意空格） */
  function normStrict(s) {
    if (s == null) return '';
    return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
  }

  /* ---------- 挑解释器 ---------- */
  /* 认不出就返回 null。拿默认值硬跑会得到一堆莫名其妙的语法错误，
     用户会以为是自己的代码错了。 */
  function pick(path) {
    var ext = String(path || '').split('.').pop().toLowerCase();
    if (ext === 'c' || ext === 'cc' || ext === 'cpp' || ext === 'cxx') return 'cpplite';
    if (ext === 'py') return 'pylite';
    return null;
  }

  /* ---------- 跑一个样例 ----------
     返回 { out, err, timeout, ms }。
     ⚠ 直接调底层解释器而不是走 Code.runner.run()：
       后者是往面板上打印的，拿不回结构化结果 ——
       而判题必须能**逐条比对**，只看打印是做不到的。 */
  function runCase(kind, code, stdin, timeoutMs) {
    var out = [];
    var err = '';
    var t0 = Date.now();
    var I;
    try {
      var lib = kind === 'cpplite' ? Code.cpplite : Code.pylite;
      if (!lib) return { out: '', err: '解释器没加载（' + kind + '）', timeout: false, ms: 0 };
      var s = String(stdin == null ? '' : stdin);
      var pos = 0;
      /* ⚠ 输入必须一次给全，不能逐字符回调。
         逐字符的话 scanf("%d") 会在读到第一个数字后就"吃掉"后续 ——
         因为解释器按行/按 token 取，回调式读会被多次触发。 */
      I = lib.create(function (x) { out.push(String(x)); }, function () {
        var v = s.slice(pos); pos = s.length; return v;
      });
      I.run(code, { timeout: timeoutMs || 5000 });
    } catch (e) {
      err = String((e && e.message) || e);
      /* 解释器用 "超时" 表达超时，但也可能用户程序真的报了这句话。
         所以以**耗时**为准：真超时耗时一定接近上限。 */
      var ms = Date.now() - t0;
      var isTimeout = /超时|timeout|TLE/i.test(err) && ms >= (timeoutMs || 5000) * 0.8;
      return { out: out.join(''), err: isTimeout ? '' : err, timeout: isTimeout, ms: ms };
    }
    return { out: out.join(''), err: '', timeout: false, ms: Date.now() - t0 };
  }

  /* ---------- 判一组 ----------
     cases: [{ in: '...', out: '...', name: '样例1' }]
     返回 { verdict, passed, total, details[] }
     verdict: AC / WA / TLE / RE / NONE（没有样例） */
  function judge(path, code, cases, opts) {
    opts = opts || {};
    var kind = pick(path);
    if (!kind) {
      return { verdict: 'NONE', passed: 0, total: 0, details: [],
        msg: '认不出这是哪种语言，没法判题。目前支持 C/C++ 与 Python。' };
    }
    var list = (cases || []).filter(function (c) {
      /* 空样例（输入输出都空）不参与 —— 否则新建一条就被判 WA，
         用户会以为自己代码有问题。 */
      return c && (String(c.in || '').length || String(c.out || '').length);
    });
    if (!list.length) {
      return { verdict: 'NONE', passed: 0, total: 0, details: [],
        msg: '还没有样例。至少填一组「输入 + 期望输出」再判。' };
    }
    var strict = !!opts.strict;
    var lim = opts.timeoutMs || 5000;
    var f = strict ? normStrict : norm;
    var details = [], passed = 0, verdict = 'AC';

    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var r = runCase(kind, code, c.in, lim);
      var got = f(r.out), want = f(c.out);
      var ok = !r.timeout && !r.err && got === want;
      var d = {
        name: c.name || ('样例 ' + (i + 1)),
        ok: ok, timeout: !!r.timeout, ms: r.ms,
        err: r.err || '', got: r.out, want: String(c.out || '')
      };
      if (ok) passed++;
      else if (verdict === 'AC') verdict = r.timeout ? 'TLE' : (r.err ? 'RE' : 'WA');
      /* ⚠ 第一个失败的样例之后**继续跑完**其余样例：
         只报第一个的话，用户改完再判又冒出第二个，来回跑很多趟。
         但 TLE 之后要停 —— 继续跑只会再耗一个超时周期。 */
      details.push(d);
      if (r.timeout && !opts.keepGoing) break;
    }
    return { verdict: verdict, passed: passed, total: details.length, details: details };
  }

  Code.judge = { norm: norm, normStrict: normStrict, pick: pick, runCase: runCase, judge: judge };
})(typeof window !== 'undefined' ? window : globalThis);
