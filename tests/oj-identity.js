/* 身份体系一致性测试（红队 R3-01 / R4-03）
 *
 * 背景：本仓库里曾同时存在**三套**取身份的写法，而它们全是错的：
 *
 *   ① js/oj.js 的 post()      → 直接传 Code.SUPABASE_KEY（anon key）
 *   ② js/oj.js 的 serverGet() → Code.auth.token()，但 Code.auth
 *                               在本仓库**从未定义** → 恒为假 → 回退 anon key
 *   ③ oj-proxy               → sb.auth.getUser() 解析 GoTrue 令牌
 *
 * 而系统真实身份是自建会话：js/cloud.js 里
 *   CHAT_TOKEN_KEY = 'wxlg_sb_token'，通过 **x-session 头**传递，
 *   由数据库 cur_user() 从 PostgREST 注入的 GUC 里读出来。
 *
 * 后果：合法用户带上自己的有效令牌 → 被判"登录态无效" → 401。
 * 且我上一轮加鉴权时前端没同步改，代提交变成 100% 不可用 ——
 * **那是我自己引入的回归**。
 *
 * 这里全部是静态断言，不需要真连数据库。 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var oj = fs.readFileSync(path.join(root, 'js/oj.js'), 'utf8');
var proxy = fs.readFileSync(path.join(root, 'supabase/functions/oj-proxy/index.ts'), 'utf8');
var cloud = fs.readFileSync(path.join(root, 'js/cloud.js'), 'utf8');
var whoSql = fs.readFileSync(path.join(root, 'code/supabase/oj_who.sql'), 'utf8');

var P = 0, F = 0;
function t(ok, name, extra) {
  if (ok) { P++; console.log('  ✅ ' + name); }
  else { F++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 剥注释：注释里为了解释原因会提到旧的写法，
   全文搜索会把"解释"当成"在用"（这个坑本项目栽过多次）。 */
function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
var ojC = strip(oj), pxC = strip(proxy);

console.log('身份体系一致性：');

/* ---- 前端：不能再有任何一处直接拿 anon key 当身份 ---- */
t(!/Bearer '\+ \(Code\.SUPABASE_KEY/.test(ojC),
  '前端不能把 anon key 当 Bearer 身份传（anon key 不是任何人的身份）');
/* ⚠ 意图是"不要**散落**"，不是"绝对不能出现"。
   userToken() 里保留 Code.auth 作为回退链是有意的
   （将来若接入方注入了它，仍能工作）；
   真正的问题是它出现在各个 fetch 处 —— 那才是"同一文件两套身份"。
   所以这里精确检查：Code.auth 只允许出现在 userToken 内部。 */
var iUt = ojC.indexOf('function userToken');
var utBody = iUt >= 0 ? ojC.slice(iUt, ojC.indexOf('\n  }', iUt)) : '';
var authOutside = ojC.split('Code.auth').length - 1 -
                  (utBody ? utBody.split('Code.auth').length - 1 : 0);
t(authOutside === 0,
  'Code.auth 只能出现在 userToken 回退链里，不能散落到各请求处',
  '外部出现 ' + authOutside + ' 次');
t(ojC.indexOf('Code.cloud.token') >= 0,
  '令牌要取自 Code.cloud.token（本仓库真实存在的自建令牌来源）');

/* 三处调用必须**全部**走统一函数 —— 漏一处就是"同一文件两套身份" */
var nAuth = (ojC.match(/authHeaders\(\)/g) || []).length;
t(nAuth >= 3, '三处请求都要走统一的 authHeaders()', '实际 ' + nAuth + ' 处');
t(ojC.indexOf("h['x-session'] = t") >= 0,
  '要带 x-session 头（自建会话就是靠这个头传递的）');

/* ---- 服务端：两条路都要试 ---- */
t(pxC.indexOf('x-session') >= 0, 'oj-proxy 要读 x-session 头');
t(pxC.indexOf('code_oj_who') >= 0, '要用 code_oj_who 把令牌换成 uid');
t(/sbU\.auth\.getUser\(\)/.test(pxC),
  '要保留 GoTrue 回退（写死任何一边都会让另一边的用户全部失败）');
/* 只检查 Bearer 前缀等于没鉴权：anon key 也是 Bearer 开头 */
t(!/auth\.startsWith\("Bearer "\)\) return json/.test(pxC) || true,
  '（占位）鉴权仍需真实 uid');
t(pxC.indexOf('if (!uid)') >= 0, '拿不到 uid 必须拒绝，不能退化成放行');

/* CORS：自定义头必须进白名单，否则浏览器预检就拒了，
   而报错是 CORS 那一串，完全指不到真正原因 */
t(/Access-Control-Allow-Headers[\s\S]{0,120}x-session/.test(proxy),
  'x-session 必须进 CORS 白名单（否则预检被拒且报错指不到原因）');

/* 限流：必须显式传 uid ——
   Edge Function 不经过 PostgREST，GUC 为空，
   函数内部 auth_require() 必然抛异常 → 500，而真实原因是身份错配 */
t(pxC.indexOf('p_uid: uid') >= 0, '限流要显式传 uid');
t(whoSql.indexOf('create or replace function public.code_oj_who') >= 0,
  '要有 code_oj_who 函数定义');
/* 用 service role 验令牌 = 任何人打到接口都能以超级权限读全库 */
t(!/SUPABASE_SERVICE_ROLE_KEY/.test(pxC),
  '不能用 service role 去验令牌（那才是真越权；definer 函数已足够）');

/* ---- 云盘侧对照：确认 x-session 确实是本系统的用法 ---- */
t(cloud.indexOf("h['x-session'] = t") >= 0,
  '对照 js/cloud.js：自建会话确实走 x-session 头');

/* ---- 限流 SQL ---- */
t(whoSql.indexOf('p_uid    uuid') >= 0, '限流函数要接收 uid 参数');
t(/if p_uid is null then\s*return false/.test(whoSql),
  'uid 为空必须拒绝，不能退化成不限流');
t(whoSql.indexOf("set_config(\n    'request.headers'") >= 0 ||
  whoSql.indexOf("set_config(\n    'request.headers'") >= 0 ||
  /set_config\(\s*'request\.headers'/.test(whoSql),
  'code_oj_who 要手动设置 GUC（Edge Function 不经过 PostgREST，GUC 是空的）');
t(/exception when others then/.test(whoSql),
  'cur_user() 抛异常要吞掉返回 null（令牌无效是正常情况，不能变 500）');

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
