#!/usr/bin/env node
/* 诱饵（canary）测试。
   核心要防的是**诱饵被当成真密钥用** ——
   那等于用一把全世界都知道的密钥加密所有人的凭据，
   而且界面上还写着"已加密"。所以这条必须反向验证。 */
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..');
const env = fs.readFileSync(path.join(R, 'security/canary.env'), 'utf8');
const fn = fs.readFileSync(path.join(R, 'supabase/functions/oj-cred/index.ts'), 'utf8');
const sql = fs.readFileSync(path.join(R, 'code/supabase/canary.sql'), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const fnCode = strip(fn), sqlCode = strip(sql);

let P = 0, F = 0;
const t = (n, ok, e) => { ok ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

console.log('诱饵（canary）测试');

/* ---------- 1. 三层诱饵都要存在且可区分 ---------- */
t('第①层 仓库层诱饵存在', /canary_repo_/.test(env));
t('第②层 数据库层诱饵存在', /canary_db_/.test(sql));
t('第③层 环境变量层诱饵存在', /canary_env_/.test(env));
t('三层值互不相同（才能区分摸到哪层）',
  /canary_repo_/.test(env) && /canary_db_/.test(sql) && /canary_env_/.test(env));

/* ---------- 2. 诱饵必须都能被机器识别 ---------- */
/* 识别不了的话，真的报上来你也不知道是哪个 */
const vals = [...env.matchAll(/canary_[^\s]+/g)].map(m => m[0])
  .concat([...sql.matchAll(/canary_[^\s']+/g)].map(m => m[0]));
t('所有诱饵都带 canary_ 前缀', vals.length > 0 && vals.every(v => v.startsWith('canary_')), vals.join(' '));

/* ---------- 3. 硬保护：诱饵不能被用来加密 ---------- */
t('定义了 canary 前缀常量', /CANARY_PREFIX\s*=\s*"canary_"/.test(fnCode));
t('取密钥时检查前缀', /startsWith\(CANARY_PREFIX\)/.test(fnCode));
t('命中时抛出专用错误', /CANARY_KEY_REFUSED/.test(fnCode));
t('错误会明确告诉用户换真密钥', /换成真密钥/.test(fnCode));
/* ⚠ 顺序很关键：必须在 base64 解码**之前**拒绝。
   放在解码之后的话，诱饵值（含中文、下划线）会先让 atob 抛异常，
   报出来的是解码错误而不是"诱饵被拒绝" ——
   用户看到"密钥格式不对"会去查编码，想不到是诱饵。 */
const keyFn = /async function key[\s\S]*?\n\}/.exec(fnCode);
t('拒绝发生在解码之前（报错才对得上）',
  !!keyFn && keyFn[0].indexOf('CANARY_KEY_REFUSED') < keyFn[0].indexOf('atob'),
  keyFn ? '' : '没取到函数');

/* ---------- 4. 数据库诱饵的设计要成立 ---------- */
/* 假 user_id 必须没有真实用户对应，否则就变成了某人的真数据 */
t('诱饵用专用 user_id', /00000000-0000-0000-0000-00000000cafe/.test(sqlCode));
t('诱饵 oj 名是 canary（不会撞真平台）', /'canary'/.test(sqlCode));
t('诱饵值不是合法密文（不会被当成真凭据解密）',
  !/enc1:/.test(/cred_enc[\s\S]{0,200}?canary_db/.exec(sqlCode) ? '' : 'canary'));
t('提供了清理语句（测完能删）', /delete from public\.oj_cred/.test(sql));
t('说明了正常路径应读不到', /读不到|返回 null/.test(sql));

/* ---------- 5. 必须写清各层含义（否则会误判） ---------- */
t('说明第①层只代表能读公开仓库', /公开仓库/.test(env) && /这不叫攻破|不算攻破/.test(env));
t('说明真正的信号是②③层', /第 ② 层|数据库.*环境变量|真正的信号/.test(env));
t('说明诱饵非真密钥', /全是假|不是真密钥|do_not_use/.test(env));

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
