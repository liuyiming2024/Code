#!/usr/bin/env node
/* 代提交的接线与判定归一测试。
   真提交需要部署 Supabase Edge Function + 真实凭据，沙箱里做不到；
   但"归一错了会把 WA 显示成 AC""该拦的没拦"这类，
   静态 + 纯函数能查 —— 而前者是最糟的一种错。 */
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..');
const oj = fs.readFileSync(path.join(R, 'js/oj.js'), 'utf8');
const fn = fs.readFileSync(path.join(R, 'supabase/functions/oj-proxy/index.ts'), 'utf8');
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(R, 'js/app.js'), 'utf8');
const doc = fs.readFileSync(path.join(R, 'docs/做题平台.md'), 'utf8');

let P = 0, F = 0;
const t = (n, ok, e) => { ok ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

console.log('代提交接线测试');

/* ---------- 1. 免责声明必须真的在 ---------- */
t('文档有免责声明标题', /免责声明/.test(doc));
t('声明里写明风险由用户承担', /后果由你自行承担|由你自己承担/.test(doc));
t('声明里写明封号风险', /封禁|封号/.test(doc));
t('声明里说明凭据不保存', /不写库|不保存|无状态/.test(doc));
t('声明里说了浏览器跨域做不了（不隐瞒转发层）', /CORS|跨域|同源/.test(doc));
t('声明里说明默认关闭', /默认关闭/.test(doc));

/* ---------- 2. 必须先勾选才能提交 ---------- */
t('未勾选时拦截提交', /!state\.agreed[\s\S]{0,80}?请先勾选/.test(oj));
t('勾选状态会被记住', /saveAgree/.test(oj) && /loadAgree/.test(oj));
t('界面上有勾选框', /oj-agree/.test(oj));
t('界面上有风险提示文字', /限流或封号的风险由你自己承担/.test(oj));

/* ---------- 3. 转发层必须无状态 ---------- */
/* ⚠ 代理源码必须先剥注释再查。
   文件头为了说明"为什么不能打印凭据"，注释里写了 console.log(a.cred) 这个**反例**，
   全文搜索会命中它 —— 于是**真实代码里真写了也会被认为没写**。
   这是本项目第 6 次栽在同一个坑上（Python 断言、HTML 注释、flags、
   Kotlin WebView、C 中断回调、以及这里）。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const fnCode = strip(fn);
t('剥完注释还剩内容（剥离没写坏）', fnCode.length > 1500 && fnCode.length < fn.length);
t('代理不写库（没有 insert/update 语句）', !/\b(insert|update)\s+into\b/i.test(fnCode));
/* 这条最关键：一旦 console.log 了 cred，凭据就进日志 = 等于我们持有它 */
t('代理不打印凭据（不能进日志）', !/console\.log\([^)]*cred/i.test(fnCode));
t('代理明确声明不落库', /不写库|不落库|不保存/.test(fn));
t('错误回显里不带凭据', !/error:\s*a\.cred/.test(fn));
t('代理带 CORS 头（否则浏览器照样拿不到）', /Access-Control-Allow-Origin/.test(fn));

/* ---------- 4. 判定归一：错把 WA 显示成 AC 是最糟的 ---------- */
/* 直接把源码里的归一逻辑抽出来跑 */
const mapBlock = /const VERDICT_MAP[^=]*=\s*\{([\s\S]*?)\};/.exec(fn);
const normSrc = /function normalizeVerdict[\s\S]*?\n\}/.exec(fn);
t('解析到判定映射表', !!mapBlock);
t('解析到归一函数', !!normSrc);

if (mapBlock && normSrc) {
  const vm = require('vm');
  const ctx = { VERDICT_MAP: vm.runInNewContext('({' + mapBlock[1] + '})') };
  vm.createContext(ctx);
  /* 源码是 TS，带类型注解 —— 直接 eval 会 SyntaxError。
     只去掉函数签名里的 : 类型，不动字符串内容。 */
  const jsFn = normSrc[0]
    .replace(/\(raw:\s*string\)\s*:\s*string/, '(raw)')
    .replace(/:\s*string\b/g, '');
  vm.runInContext(jsFn, ctx);
  const nv = ctx.normalizeVerdict;
  t('归一函数能被求出来（类型剥离没写坏）', typeof nv === 'function');

  const cases = [
    ['OK', 'AC'], ['Accepted', 'AC'], ['答案正确', 'AC'],
    ['WRONG_ANSWER', 'WA'], ['答案错误', 'WA'], ['Wrong Answer', 'WA'],
    ['TIME_LIMIT_EXCEEDED', 'TLE'], ['时间超限', 'TLE'],
    ['MEMORY_LIMIT_EXCEEDED', 'MLE'], ['内存超限', 'MLE'],
    ['RUNTIME_ERROR', 'RE'], ['运行错误', 'RE'],
    ['COMPILATION_ERROR', 'CE'], ['编译错误', 'CE'],
    /* 带测试点编号的真实文本（这类最容易匹配不上） */
    ['Wrong answer on test 3', 'WA'],
    ['Time limit exceeded on test 12', 'TLE'],
    ['Compilation error', 'CE'],
  ];
  let bad = [];
  cases.forEach(([i, o]) => { const g = nv(i); if (g !== o) bad.push(i + '→' + g + '(期望' + o + ')'); });
  t('判定归一全对（含带测试点编号的真实文本）', bad.length === 0, bad.join(' '));

  /* 反向：绝不能把错的判成对 */
  t('WA 不会被归一成 AC', nv('Wrong Answer') !== 'AC');
  t('TLE 不会被归一成 AC', nv('Time limit exceeded') !== 'AC');
  t('CE 不会被归一成 AC', nv('Compilation error') !== 'AC');
  t('未知输入返回 UNKNOWN（不假装通过）', nv('') === 'UNKNOWN' && nv('xyz') === 'UNKNOWN');
}

/* ---------- 5. 不支持的平台要明确说 ---------- */
t('没实现的平台明确报错（不假装支持）', /暂不支持/.test(fn));
t('支持列表来自实际注册的 PROVIDERS', /Object\.keys\(PROVIDERS\)/.test(fn));

/* ---------- 6. 语言与文件要匹配 ---------- */
t('Python 文件按 C++ 提交会被拦下', /文件是 Python[\s\S]{0,120}?请改选 Python/.test(oj));
t('C++ 文件按 Python 提交会被拦下', /文件是 C\/C\+\+[\s\S]{0,120}?请改选 G\+\+/.test(oj));

/* ---------- 7. 网络失败要说清"没提交出去" ---------- */
t('连不上时明确说代码没被提交', /没有\*\*被提交|没有被提交/.test(oj));

/* ---------- 8. 接线 ---------- */
t('引入了 oj.js', /js\/oj\.js/.test(html));
t('oj.init 真的被调用', /Code\.oj\.init\(\)/.test(app));
t('界面有容器 #oj-box', /id="oj-box"/.test(html));
t('凭据存本机 localStorage（不上传）', /localStorage/.test(oj));

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
