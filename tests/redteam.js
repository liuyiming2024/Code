#!/usr/bin/env node
/* 红队报告（2026-10-18）修复验证。
   每条对应报告里一个编号，且都要能反向验证 ——
   "改了"和"真的拦住"是两回事。 */
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..');
const proxy = fs.readFileSync(path.join(R, 'supabase/functions/oj-proxy/index.ts'), 'utf8');
const canary = fs.readFileSync(path.join(R, 'code/supabase/canary.sql'), 'utf8');
const rate = fs.readFileSync(path.join(R, 'code/supabase/oj_rate.sql'), 'utf8');
const oj = fs.readFileSync(path.join(R, 'js/oj.js'), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const pc = strip(proxy), cc = strip(canary), rc = strip(rate), oc = strip(oj);

let P = 0, F = 0;
const t = (n, ok, e) => { ok ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

console.log('红队报告修复验证');

/* ---------- P0-1：canary 第②层不能写死 ---------- */
t('第②层不再有固定诱饵值', !/canary_db_[^\s']*'/.test(cc) || !/canary_db_测试密钥/.test(cc));
t('第②层改为随机生成', /md5\(random\(\)::text/.test(cc) || /md5\(random\(\)/.test(cc));
t('用 clock_timestamp 再叠加一层随机', /clock_timestamp/.test(cc));
/* 关键：整份文件里不能再出现那个可被引用的固定串 */
t('全文件不含旧固定值 canary_db_测试密钥', !/canary_db_测试密钥/.test(canary));
t('说明了部署者要自己取值比对', /部署者|取出这次生成的值/.test(canary));
t('说明了正常路径必须读不到', /期望 NULL|读不到/.test(canary));

/* ---------- P0-2：oj-proxy 鉴权 ---------- */
t('校验 Bearer 前缀', /!auth\.startsWith\("Bearer "\)/.test(pc));
t('未带 token 返回 401', /未登录/.test(pc) && /401/.test(pc));
/* ⚠ 只检查前缀等于没鉴权：anon key 也是 Bearer 开头 */
t('用 getUser 解析真实身份（不是只看前缀）', /auth\.getUser\(\)/.test(pc));
t('身份无效时拒绝', /登录态无效/.test(pc));
t('用调用者 token 建客户端（不用 service role）', /authorization:\s*auth/.test(pc));
t('没有 SERVICE_ROLE 字样', !/SERVICE_ROLE/i.test(pc));

/* ---------- P0-2 配套：限流 ---------- */
t('oj-proxy 调用了限流函数', /code_oj_rate_allow/.test(pc));
t('超限返回 429', /429/.test(pc));
t('超限提示说明是为保护他人', /不牵连其他人|保护.*代提交/.test(pc));
t('限流记账在数据库里（不是内存）', /oj_submit_log/.test(rc));
t('限流函数有门禁', /auth_require\(\)/.test(rc) && /code_gate_require\(\)/.test(rc));
t('限流表撤权 + RLS', /revoke all on public\.oj_submit_log/.test(rc) && /enable row level security/.test(rc));
t('限流函数用 security definer', /security definer/.test(rc));
/* 这条最隐蔽：超限也记账，否则持续刷每次都算"第一次" */
/* ⚠ 上一版用 [\s\S]{0,200}? 是**错的**：它会跨过 end if，
   一直吃到后面"正常路径"那个 insert —— 于是断言恒真，
   我把超限分支的 insert 删掉了它还照样通过。
   （这是本项目第 9 次栽在"断言写松了等于没写"上。）
   正确做法：只截 then ... end if 这一段，在段内查。 */
const overBlock = /if n >= p_budget\s+then[\s\S]*?end if;/.exec(rc);
t('取到超限分支', !!overBlock);
t('超限也记账（否则限流形同虚设）',
  !!overBlock && /insert into public\.oj_submit_log/.test(overBlock[0]),
  overBlock ? overBlock[0].slice(0, 80) : '没取到');

/* ---------- P1：pid 白名单 ---------- */
t('定义了题号正则', /PID_RE\s*=\s*\/\^\\d\{1,4\}\[A-Za-z\]\?\$/.test(pc));
t('提交前校验 pid', /validPid\(a\.pid\)/.test(pc));
t('格式不对返回 400', /题号格式不对/.test(pc) && /400/.test(pc));
/* 白名单要真的拒绝掉注入形态 */
const re = /^\d{1,4}[A-Za-z]?$/;
t('拒绝 1A?x=../../ 这类注入', re.test('1A?x=../../') === false);
t('接受 4A / 2000B / 1234', re.test('4A') && re.test('2000B') && re.test('1234'));
t('拒绝超长 pid', re.test('1'.repeat(500)) === false);

/* ---------- P2：decryptStr 不再原样返回 ---------- */
t('非 enc1 不再原样返回', !/indexOf\('enc1:'\) !== 0\)\s*return Promise\.resolve\(env\)/.test(oc));
t('非 enc1 改为拒绝（提示重填）',
  /indexOf\('enc1:'\) !== 0\)[\s\S]{0,120}?CRED_UNREADABLE/.test(oc));

/* ---------- 别误改的（红队点名说写对了） ---------- */
t('（保留）non-extractable 密钥', /generateKey\([\s\S]{0,80}?false/.test(oc));
t('（保留）无 WebCrypto 不落盘明文', /NO_WEBCRYPTO/.test(oc));
t('（保留）IV 随机 12 字节', /getRandomValues/.test(oc) && /new Uint8Array\(12\)/.test(oc));
t('（保留）canary 拒绝在 atob 之前', /CANARY_KEY_REFUSED/.test(fs.readFileSync(path.join(R,'supabase/functions/oj-cred/index.ts'),'utf8')));
t('（保留）全程不 console.log 凭据', !/console\.log\([^)]*cred/i.test(pc));

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
