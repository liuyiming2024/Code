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
t(/UI\.setView\('cloud'\)/.test(ui), '点击会切到 cloud 视图');
/* 折叠状态下切视图没有任何视觉变化 → 点了像坏了 */
t(/classList\.contains\('collapsed'\)\)\s*UI\.toggleSide\(\)/.test(ui),
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
t(/if \(!Code\.cloud\) \{ U\.toast/.test(ui), '点击时也要提示用不了');

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

console.log('\n=== 10. 文案：界面上不许出现架构术语 ===');
/* 面向游客的界面，术语只会让人不知道该不该点。
   架构原因写在源码注释里给后来的人看，不该出现在按钮上。 */
var banList = ['全站通用', '统一身份', 'Chat', '聊天室', 'Supabase', 'publishable', 'RPC'];
/* 只查**用户看得见**的文字 —— HTML 注释是给开发者看的，术语该写在那儿。
   不剥注释的话，注释里解释架构原因的用词会误判成界面文案。 */
var visible = html.slice(html.indexOf('<body')).replace(/<!--[\s\S]*?-->/g, '');
banList.forEach(function (w) {
  t(visible.indexOf(w) < 0, '用户看得见的文案里不该出现「' + w + '」');
});
/* 反向确认：注释里**确实**写了原因（不能只删文案不写理由，
   否则后来的人不知道为什么不能各做各的） */
t(/失败冻结|爆破闸门/.test(html), '架构原因要留在注释里（给后来的人看）');
t(/id="btn-cloud-gologin">登录</.test(html), '登录按钮就写「登录」（不要括号补充说明）');
t(html.indexOf('>兑换<') >= 0, '票据按钮写「兑换」');

/* 两处入口共用同一个打开动作，否则会出现"从这里点正常、从那里点没反应" */
t(/UI\.openCloud = function/.test(ui), '要有公用的 UI.openCloud');
t(/ba\.onclick = function \(\) \{ UI\.openCloud\(\); \}/.test(app), '页眉账号走 UI.openCloud');
t(/on\('#btn-goto-cloud', 'click', function \(\) \{ UI\.openCloud\(\); \}\)/.test(app),
  '设置面板「前往云盘」也走 UI.openCloud');

console.log('\n=== 11. 加密网盘（另一个网盘）互通 ===');
var drive = fs.readFileSync(path.join(root, 'js/drive.js'), 'utf8');

t(fs.existsSync(path.join(root, 'js/drive.js')), '有 js/drive.js');
t(html.indexOf('js/drive.js') >= 0, 'index.html 引入 drive.js');
t(html.indexOf('id="drive-state"') >= 0, '云盘视图有加密网盘状态区');

/* 隐藏 iframe 不能用 display:none —— 部分浏览器会推迟加载，脚本根本不跑 */
/* ⚠ 只查**实际写在 style 里的那一段** —— 注释里提到 display:none 是为了解释
   为什么不能用它，全文件搜会把注释当成违规（和 HTML 注释那次同一类误判）。 */
var styleLine = (drive.match(/f\.style\.cssText\s*=\s*'([^']*)'/) || ['', ''])[1];
t(/left:-9999px/.test(styleLine), 'iframe 要移出屏幕（left:-9999px）');
t(!/display:\s*none/.test(styleLine), 'iframe 不能用 display:none（否则脚本不执行）');
/* 等就绪不能只等对象出现 —— ensure() 是异步的 */
t(/api\.ready\(\)/.test(drive), '要等 Cloud.api.ready()（对象出现 ≠ 就绪）');
t(/READY_TIMEOUT/.test(drive), '要有超时（不能无限等）');
/* 失败要能重试：填过令牌之后应该能再来一次 */
t(/bootPromise = null/.test(drive), '启动失败要能重试（换账号/填令牌后）');
t(/sameOrigin/.test(drive), '要先判同源（不同源时走跳转，不能硬来）');

/* 界面与实现不能说谎 */
t(/两块空间|不互通|独立的一块空间/.test(html), '界面要说明两块空间不互通');
/* 取回不能覆盖已有文件 */
t(/重名|不覆盖/.test(ui), '取回重名时不能覆盖本地文件');
t(/fs\.exists\(p\)/.test(ui), '取回前要检查同名文件是否已存在');
/* 上传要用完整路径当名字 */
t(/D\.upload\(blob, path, 'auto'\)/.test(ui), '上传要用完整路径当名字（否则同名互相覆盖）');

console.log('\n=== 12. 对面（Cloud）适配后的契约 ===');
/* 对面给 Cloud.api 加了 version 与 channel()，这边要跟着认。
   不认版本的话，对面改了接口我们照旧调用，报出来的是
   "没有这个方法"，看不出是版本问题。 */
t(/MIN_VER/.test(drive), '要声明支持的契约版本范围');
t(/api\.version/.test(drive), '就绪后要查一次契约版本');
t(/不在这边支持的范围内/.test(drive), '版本不匹配要明确报不兼容');
/* 通道决定等待提示：快通道说"要等一会儿"是误导，慢通道不说会让人以为卡死 */
t(/api\.channel/.test(drive), '要探测通道（快/慢）');
t(/channel === 'worker'/.test(ui), '快通道要能识别出来');
t(/慢通道（每次要等一会儿）/.test(ui), '状态要显示当前是快通道还是慢通道');
/* 查重被拒其实是成功（东西确实在），报成失败会让人反复重试甚至改坏文件 */
t(/已经有完全一样的内容/.test(ui), '查重被拒要翻成"已经在里面了"，不能报成失败');

/* 反向通道：项目云盘 → 加密网盘 */
t(/importFromCode/.test(drive), 'drive.js 要提供反向转存');
t(/CloudBridge/.test(drive), '要访问对面的 CloudBridge');
t(html.indexOf('id="btn-drive-import"') >= 0, '界面有转存入口');
t(/D\.importFromCode\(p\)/.test(app), '转存按钮真的调了 importFromCode');
/* 转存必须手动、单向 —— 说清楚不是自动同步 */
t(/不是自动同步|单向/.test(app) || /不互通/.test(html), '要说清是手动单向，不是自动同步');

console.log('\n=== 13. 对面加了压缩：这边怎么兼容 ===');
/* 关键认知：压缩和解密都在**对面**做完了。
   它的容器是「先 gzip 再加密」，proc 标记写在密文头里，
   下载时它解密完自动按标记 gunzip —— 我们拿到的已经是明文。
   所以这边**不该**自己解压：**多此一举，且必然出错**。 */
t(/D\.upload\(blob, path, 'auto'\)/.test(ui), '上传要给对面传压缩建议（auto）');
t(/绝不能自己先|不能自己把内容压|提前压了/.test(drive) || /先压缩，再加密/.test(drive),
  '注释要写明"不能自己先压"（压了会存成二进制乱码且不报错）');
/* 往返编辑：取回 → 改 → 存回，应该是更新同一条，不是堆副本 */
t(/function bindSet/.test(ui), '要记录"本地路径 → 网盘条目 id"的绑定');
t(/Code\.store\.set\('driveBind'/.test(ui), '绑定要持久化（今天取回、明天存回也认得）');
t(/D\.remove\(old\.id\)/.test(ui), '存回时要删掉旧条目（更新而非新增）');
/* 顺序不能反：先删后传，中途失败就两边都没有 */
t(/顺序不能反|最坏情况是留一条重复/.test(ui), '要先传后删（反了中途失败就真丢了）');
/* 文本判断：二进制不能往编辑器里塞 */
t(/function isTextPath/.test(ui), '要有文本判断');
t(/BIN_EXT/.test(ui), '要有一份二进制扩展名表');
t(/这不是文本文件，Code 里改不了/.test(ui), '非文本要如实拒绝，不能塞乱码进编辑器');
/* 对面的已知 bug 要能识别出来，别让用户对着自己的文件反复重试 */
t(/function explain/.test(drive), '要能识别"对面代码的问题"');
t(/procArg/.test(drive), '要认得对面的 procArg 未定义错误');

console.log('\n\u901a\u8fc7 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
