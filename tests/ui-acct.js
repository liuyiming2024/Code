/* 页眉账号 + 云盘白屏 的静态一致性测试。
 *
 * 这两个都是**用户能直接看到**的界面问题，而 jsdom 在本环境装不上，
 * 跑不了真实渲染，所以退而求其次：查接线是否闭合。
 * 查的是"会不会必然出错"，不是"长得好不好看"。 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
var ui = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
var app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
var css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');

var P = 0, F = 0;
function t(ok, msg, extra) {
  if (ok) { P++; console.log('  \u2705 ' + msg); }
  else { F++; console.log('  \u274c ' + msg + (extra ? '\n       ' + extra : '')); }
}

console.log('=== 1. 云盘白屏：视图名单必须覆盖 activitybar 上每个 data-view ===');
/* 从 HTML 里取出 activitybar 上的所有 data-view */
var views = [], re = /<button[^>]*data-view="([^"]+)"/g, m;
while ((m = re.exec(html))) views.push(m[1]);
console.log('     activitybar 上的视图: ' + views.join(', '));

/* 旧写法是硬编码数组 ['files','search','run','settings'] —— 漏了 cloud 就白屏。
   现在必须改成从 DOM 读。 */
t(!/\['files', 'search', 'run', 'settings'\]/.test(ui),
  '不能再用硬编码视图名单（漏一个就白屏）');
t(/U\.\$\$\('#activitybar \[data-view\]'\)/.test(ui) &&
  /e\.classList\.toggle\('hidden', v !== name\)/.test(ui),
  'setView 要遍历 activitybar 上实际的 data-view 来切换 hidden');

/* 每个视图都要有对应的容器 */
views.forEach(function (v) {
  t(html.indexOf('id="view-' + v + '"') >= 0, '有 #view-' + v + ' 容器');
});
t(/cloud: '/.test(ui), "names 映射要有 cloud（否则侧栏标题空白）");

console.log('\n=== 2. 页眉账号按钮 ===');
t(html.indexOf('id="btn-acct"') >= 0, '页眉有账号按钮');
t(html.indexOf('id="acct-label"') >= 0, '有账号文字标签');
t(html.indexOf('id="i-user"') >= 0, '有 i-user 图标（否则按钮是空的）');
t(app.indexOf("U.$('#btn-acct')") >= 0, 'app.js 绑定了点击');
t(/UI\.setView\('cloud'\)/.test(app), '点击会切到 cloud 视图');
/* 折叠状态下切视图没有任何视觉变化 → 点了像坏了 */
t(/classList\.contains\('collapsed'\)\)\s*UI\.toggleSide\(\)/.test(app),
  '侧栏折叠时要先展开（否则点了没反应）');

console.log('\n=== 3. 页眉与侧栏云盘状态必须同步 ===');
t(/UI\.refreshAcct = function/.test(ui), '有 refreshAcct（页眉专用刷新）');
['未登录分支', '登录成功分支', '失败分支'].forEach(function () { });
t(/UI\.refreshAcct\(null\)/.test(ui), '未登录时要清掉页眉的登录态');
t(/UI\.refreshAcct\(m\)/.test(ui), '登录成功时页眉要显示昵称');
var cnt = (ui.match(/UI\.refreshAcct\(/g) || []).length;
t(cnt >= 3, '三条分支都要同步页眉（当前 ' + cnt + ' 处）',
  '只更新一处会出现"页眉已登录、点进去未登录"的分裂状态');

console.log('\n=== 4. cloud.js 未加载时的降级 ===');
t(/if \(!Code\.cloud\)/.test(ui), 'refreshCloud 要处理 cloud 缺失');
t(/b0\.disabled = true/.test(ui), '未启用时按钮要禁用（不是点了没反应的坏按钮）');
t(/if \(!Code\.cloud\) \{ U\.toast/.test(app), '点击时也要提示未配置');

console.log('\n=== 5. 样式 ===');
t(css.indexOf('.acct-btn') >= 0, '有 .acct-btn 样式');
t(/text-overflow: ellipsis/.test(css), '昵称过长要省略（不能把顶栏挤歪）');
t(/\.acct-btn\.on/.test(css), '已登录要有视觉区分');

console.log('\n=== 6. 统一身份：登录不能在 Code 里自己实现 ===');
var cloud = fs.readFileSync(path.join(root, 'js/cloud.js'), 'utf8');
var util = fs.readFileSync(path.join(root, 'js/util.js'), 'utf8');
var sql = '';
(function () {
  var cands = ['code/supabase/cloud.sql', 'supabase/cloud.sql'];
  for (var i = 0; i < cands.length; i++) {
    var f = path.join(root, cands[i]);
    if (fs.existsSync(f)) { sql = fs.readFileSync(f, 'utf8'); return; }
  }
})();

/* 为什么必须统一：失败冻结、爆破闸门、记住账号、桥接票据 ——
   这四条在 A 项目改了 B 项目不会跟着改，于是安全边界取决于从哪个入口进。 */
t(html.indexOf('/assets/identity.js') >= 0, 'index.html 引入全站统一身份服务');
t(html.indexOf('onerror="window.__identityFailed=1"') >= 0,
  'identity.js 要有加载失败标记（离线时不能静默变成坏按钮）');
/* Code 里不该再有密码输入框 —— 密码只能交给统一登录页 */
t(html.indexOf('id="cloud-pwd"') < 0, 'Code 里不再有密码输入框（密码只交统一登录页）');
t(html.indexOf('id="btn-cloud-gologin"') >= 0, '云盘有「去登录」按钮');
t(/SI\.goLogin\(location\.href\)/.test(app), '点击走 SiteIdentity.goLogin（不是自己拼 URL）');
/* 开放重定向：next 必须由 goLogin 内部白名单校验 */
t(!/login\.html\?next=/.test(app), '不能自己拼 login.html?next=（那是开放重定向）');

console.log('\n=== 7. 离线 ≠ 未登录 ===');
t(/state\.offline/.test(ui), 'refreshAcct 要区分离线与未登录');
t(/\u79bb\u7ebf/.test(ui), '要有"离线"这个独立状态');
t(/SI0\.ready\.then/.test(app), '要等统一身份服务首次探测完成（否则会闪一下错误状态）');
t(/UI\.watchIdentity/.test(app) && /SI\.onChange/.test(ui),
  '要订阅状态变化（跨标签登录后本页要跟上）');

console.log('\n=== 8. 退出标记与统一登录不能打架 ===');
t(/function syncOptOut/.test(cloud), 'cloud.js 要有 syncOptOut');
t(/ls\(OPT_OUT_KEY, null\)/.test(cloud), '重新登录过要销掉退出标记');
/* 只许在"确实有 token"时销账，否则退出形同虚设（回到 S-047） */
t(/loggedIn && ls\(CHAT_TOKEN_KEY\)/.test(cloud),
  '销账必须以"确实有会话"为前提（否则退出是假的）');

console.log('\n=== 9. 安全简报的修复项 ===');
/* D-1：RLS 作第二层 */
t(/alter table code_files enable row level security/.test(sql),
  'D-1 code_files 要启用 RLS（与 revoke 形成双层）');
/* 启用 RLS 但**不建 policy** —— 建了反而是开口子 */
t(!/create policy/i.test(sql), 'D-1 启用 RLS 但不建 policy（补 policy 反而是开新口子）');
t(/revoke all on code_files from anon, authenticated/.test(sql), '表级 DML 仍是 revoke 状态');
/* D-3：昵称是用户输入，拼进 innerHTML 必须转义 */
t(/U\.esc\(m\.nick/.test(ui), 'D-3 昵称拼进 innerHTML 必须转义（否则是存储型 XSS）');
t(/U\.esc = function/.test(util), 'util 要有公用的 U.esc');
t(/U\.safeURL = function/.test(util), 'util 要有 U.safeURL（esc 挡不住 javascript:）');

console.log('\n\u901a\u8fc7 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
