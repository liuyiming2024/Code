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

console.log('\n\u901a\u8fc7 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
