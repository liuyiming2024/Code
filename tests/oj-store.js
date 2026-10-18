#!/usr/bin/env node
/* 三档开关测试。
   三档的安全性质**不同**，最怕的是：
   ① 用户以为选了 A 实际存到了 B（切档不重新取）
   ② server 档被说成"我们拿不到"（那是 local 档才有的性质）
   ③ 选了"不存"却还留着旧的
   这三条都是"看起来没问题、实际违背用户选择"，必须钉住。 */
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(R, 'js/oj.js'), 'utf8');
const fn = fs.readFileSync(path.join(R, 'supabase/functions/oj-cred/index.ts'), 'utf8');
const sql = fs.readFileSync(path.join(R, 'code/supabase/oj_cred.sql'), 'utf8');
const doc = fs.readFileSync(path.join(R, 'docs/做题平台.md'), 'utf8');

let P = 0, F = 0;
const t = (n, ok, e) => { ok ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

/* ⚠ 先剥注释：注释里为了解释规则会提到反例原文
   （比如"不能说我们拿不到"这句话本身就带这几个字）。
   不剥的话断言会永远为真 —— 这是本项目第 7 次栽这个坑。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('三档开关测试');
/* ⚠ code 必须在所有用到它的断言之前定义，否则 ReferenceError */
const code = strip(src);

/* ---------- 1. 三档定义 ---------- */
/* 常量是大写键（NONE/LOCAL/SERVER），值是小写。
   第一次我按小写键写正则，于是**正确的定义被判成失败** ——
   这是本项目第 8 次这样栽跟头：断言写错，冤枉对的代码。 */
t('定义了 none / local / server 三档',
  /NONE:\s*'none'/.test(src) && /LOCAL:\s*'local'/.test(src) && /SERVER:\s*'server'/.test(src));
t('三档都有界面说明文案',
  /none:\s*'[^']*'/.test(src) && /local:\s*'[^']*'/.test(src) && /server:\s*'[^']*'/.test(src));
t('默认是 local 而不是 server',
  /store:\s*STORE\.LOCAL/.test(src));

/* ---------- 2. 每档含义必须写清（不能只写名字） ---------- */
t('界面说明 none 档', /什么都不存/.test(src));
t('界面说明 local 档：我们拿不到明文', /我们拿不到明文/.test(src));
t('界面说明 server 档：拖库拿不到但服务端能解密',
  /拖库拿不到明文/.test(src) && /但服务端能解密|但<b>服务端能解密/.test(src));
/* 这条最关键：server 档绝不能被描述成"我们拿不到" */
const noteFn = /function showStoreNote[\s\S]*?\n  \}/.exec(src);
t('取到 showStoreNote 函数体', !!noteFn);
if (noteFn) {
  /* 只取 server 这一档的文案，不能跨行吃到后面别档的 ——
     上一版用 [\s\S]*? 跨行匹配，把 local 档的"我们拿不到明文"
     一起吃了进来，于是**正确的代码被判成失败**。 */
  /* 两个备选正则都要带捕获组，否则 serverLine[1] 是 undefined ——
     直接用会 TypeError。用 [0] 兜底，再判断是不是真取到了。 */
  let m1 = /server:\s*'([\s\S]*?)'\s*\n\s*\}/.exec(noteFn[0]);
  if (!m1) m1 = /server:\s*'([^']*(?:'\s*\+[^']*)*)'/.exec(noteFn[0]);
  const serverLine = m1;
  t('取到 server 档说明文案', !!serverLine);
  /* 反向验证时我把 STORE_DESC 改了却没触发报红 ——
     因为用户看到的是 showStoreNote 里的文案，不是 STORE_DESC。
     断言查错对象 = 测试是摆设。这里明确查给用户看的那份。 */
  t('server 档说明里不出现"我们拿不到"',
    !!serverLine && !/我们拿不到/.test(serverLine[1]),
    serverLine ? serverLine[1].slice(0, 50) : '');
  t('server 档说明里必须写服务端能解密',
    !!serverLine && /服务端能解密/.test(serverLine[1]));
}

/* ---------- 3. 切档必须重新取 ---------- */
/* 不重新取的话：从 local 切到 server，输入框还是旧的本地凭据，
   保存时会存到服务端 —— 用户以为存这，实际存那。 */
/* 只查"有没有 fillCred"太松：中间插个 return 就永远到不了，
   而断言还是真 —— 反向验证时正是这样漏掉的。
   所以去掉 return / 提前退出语句后再查，确保它**真的可达**。 */
const chg = /sel\.addEventListener\('change',[\s\S]*?\n    \}\);/.exec(code);
t('取到切档处理块', !!chg);
/* ⚠ 上一版写反了：我"去掉 return 后再查 fillCred"，
   结果**插了 return 反而照样通过** —— 反例验证时正是这样漏掉的。
   正确方向：取"切档处理开始 → fillCred"之间的片段，
   断言这段里**没有**提前退出（return / throw）。 */
const between = chg
  ? (/showStoreNote\(\);[\s\S]*?fillCred\(/.exec(chg[0]) || [''])[0]
  : '';
t('切档后真的会重新取凭据（路径上没有提前退出）',
  !!chg && /fillCred\(/.test(between) && !/\breturn\b|\bthrow\b/.test(between),
  chg ? (between ? between.slice(0, 120) : '没走到 fillCred') : '没取到块');
t('切档会记住选择', /localStorage\.setItem\(KEY \+ 'store'/.test(src));
t('启动时读回档位', /getItem\(KEY \+ 'store'\)/.test(src));

/* ---------- 4. 选"不存"要真的清掉 ---------- */
t('none 档清空本地残留', /STORE\.NONE[\s\S]{0,300}?removeItem/.test(code));
t('切到 server 档也清掉本地（避免两处各留一份）',
  /STORE\.SERVER[\s\S]{0,300}?removeItem/.test(code));

/* ---------- 5. 保存失败不阻断提交 ---------- */
t('保存失败仍提交', /保存失败一律不阻断提交|不阻断提交/.test(src));

/* ---------- 6. 服务端函数：密钥不在库里 ---------- */
t('密钥来自环境变量', /Deno\.env\.get\(["']OJ_CRED_KEY["']\)/.test(fn));
t('没配密钥就明确报错（不绝不明文存）', /KEY_NOT_CONFIGURED/.test(fn));
t('没配密钥时提示改用存本机', /请改用「存本机」/.test(fn));
t('服务端用调用者 token（不用 service role）',
  /authorization:\s*auth/.test(fn) && !/SERVICE_ROLE/.test(fn));
t('未登录直接 401', /未登录/.test(fn) && /401/.test(fn));
t('IV 每次随机', /getRandomValues/.test(fn));
t('IV 12 字节', /new Uint8Array\(12\)/.test(fn));
t('错误回显不带凭据', !/error:\s*b\.cred/.test(fn));
t('空凭据等于删除', /action === "save"[\s\S]{0,200}?!b\.cred[\s\S]{0,200}?p_enc: ""/.test(fn));

/* ---------- 7. SQL：跟云盘同一套收口 ---------- */
t('表撤权（第一层）', /revoke all on public\.oj_cred/.test(sql));
t('启用 RLS（第二层）', /alter table public\.oj_cred enable row level security/.test(sql));
t('不建 policy（零 policy 是最严）', !/create policy/i.test(sql));
t('函数用 security definer', /security definer/.test(sql));
t('函数设 search_path', /set search_path/.test(sql));
t('函数里有门禁', /auth_require\(\)/.test(sql) && /code_gate_require\(\)/.test(sql));
/* 这条关键：只认密文，否则"客户端忘加密"会静默变成库里存明文 */
t('数据库层拒绝明文（只认 enc1: 前缀）', /not like 'enc1:%'/.test(sql));

/* ---------- 8. 文档 ---------- */
t('文档说明三档', /三档|存服务端|存本地/.test(doc));
t('文档说明 server 档服务端能解密', /服务端能解密|服务端本身能解密/.test(doc));

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
