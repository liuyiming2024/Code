/* 原生端（Android）导入导出与生命周期接线测试
 *
 * ⚠ 本环境没有 Android SDK / kotlinc，**一行都编译不了**。
 *   所以这里只能查"逻辑对了但接不上线"的那类问题 ——
 *   而恰恰是这类问题在编译通过之后才暴露，
 *   而且报错往往指不到真正原因。
 *
 * 本轮修的两个真问题：
 *
 * ① **onDestroy 放错了地方**（编译不过 + 引擎泄漏）
 *    它原本写在 `PreviewEditor()` —— 一个**顶层** @Composable 函数里。
 *    在那里 `override` 不合法、`super` 不存在、`runHost` 不在作用域，
 *    即这段代码根本编译不过。
 *    更糟的是后果：引擎从来没被释放，QuickJS Runtime
 *    每次重建 Activity 泄漏一个 —— 症状正是它自己注释里写的
 *    "来回切几次就越来越卡"。注释警告的正是它没能生效的那件事。
 *
 * ② **导入导出是单向的**
 *    FileStore.exportZip 早就写了，但**全仓零调用** ——
 *    写了没接上，等于没有。而且根本没有 importZip：
 *    工程能导出、搬不进来。
 *    手机上写的代码搬不出去、已有的工程也搬不进来。
 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var dir = path.join(root, 'native/android/app/src/main/java/io/code/app');

var main = fs.readFileSync(path.join(dir, 'MainActivity.kt'), 'utf8');
var store = fs.readFileSync(path.join(dir, 'data/FileStore.kt'), 'utf8');
var drawer = fs.readFileSync(path.join(dir, 'ui/FileDrawer.kt'), 'utf8');

var P = 0, F = 0;
function t(ok, name, extra) {
  if (ok) { P++; console.log('  ✅ ' + name); }
  else { F++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
/* 剥注释：注释里为了解释原因会复述旧写法，全文搜会把"解释"当成"在用"。
   这个坑本项目栽过很多次。 */
function strip(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
var mainC = strip(main), drawerC = strip(drawer), storeC = strip(store);

console.log('原生端导入导出与生命周期：');

/* ---- ① onDestroy 必须在 Activity 类里 ---- */
/* 判据：onDestroy 的位置要在 MainActivity 类的闭合括号之前，
   而不是落在后面的顶层 PreviewEditor 里。 */
var iClass = main.indexOf('class MainActivity');
var iDestroy = main.indexOf('override fun onDestroy');
var iPreview = main.indexOf('fun PreviewEditor');
t(iClass >= 0 && iDestroy > iClass && iDestroy < iPreview,
  'onDestroy 必须在 MainActivity 类内（原来落在顶层 PreviewEditor 里，编译不过）',
  'class=' + iClass + ' destroy=' + iDestroy + ' preview=' + iPreview);
t(!/fun PreviewEditor\(\)[\s\S]{0,400}?override fun onDestroy/.test(main),
  'PreviewEditor 里不能再有 override fun onDestroy');
t(/override fun onDestroy\(\)[\s\S]{0,200}?runHost\.close\(\)/.test(mainC),
  'onDestroy 要真的释放引擎（不释放则每次重建泄漏一个 Runtime）');

/* ---- ② 导入导出都要有，且都要接上 ---- */
t(storeC.indexOf('fun importZip') >= 0, 'FileStore 要有 importZip（原来只有导出）');
t(storeC.indexOf('fun exportZip') >= 0, 'FileStore 要有 exportZip');
/* 关键：exportZip 不能只是"定义了" —— 之前它就是零调用的死代码 */
t(/exportLauncher/.test(mainC), 'MainActivity 要注册导出选择器');
t(/importLauncher/.test(mainC), 'MainActivity 要注册导入选择器');
t(drawerC.indexOf('onExport') >= 0 && drawerC.indexOf('onImport') >= 0,
  'FileDrawer 要有导入导出入口（不然用户点不到）');
/* 两侧要对得上：抽屉的回调必须被 Activity 真正传进去 */
t(/onExport = \{/.test(mainC) && /onImport = \{/.test(mainC),
  'MainActivity 要把 onExport/onImport 传进 FileDrawer（传漏了按钮就是死的）');
t(/importLauncher\.launch\(/.test(mainC), '导入要真的 launch 选择器');
t(/exportLauncher\.launch\(/.test(mainC), '导出要真的 launch 选择器');

/* ---- ③ Zip Slip：zip 里的名字必须过 PathNorm ---- */
/* 这是真漏洞：entry 名是别人给的，可以写成 ../../etc/passwd */
t(/PathNorm\.norm\(e\.name\)/.test(storeC),
  '导入时每条 entry 名都要过 PathNorm（否则能把文件写到应用目录外）');
t(/if \(rel == null\)[\s\S]{0,120}?continue/.test(storeC),
  '名字非法的条目要跳过，不能截断后写入（截断会静默写到错误位置）');
/* 不能先清空再导入：清完再失败，用户原来的文件也一起没了 */
t(!/deleteRecursively/.test(storeC),
  '导入不能先清空目录（清完再失败会连原文件一起丢）');

/* ---- ④ import ---- */
t(main.indexOf('import java.io.File') >= 0,
  'MainActivity 要 import java.io.File（导出用到临时文件）');
t(drawer.indexOf('icons.filled.Share') >= 0 && drawer.indexOf('icons.filled.Download') >= 0,
  'FileDrawer 要 import Share / Download 图标（漏了是 Unresolved reference）');

/* ---- ⑤ 导入后必须刷新列表 ---- */
t(/onFilesChanged[\s\S]{0,80}?invoke\(\)/.test(mainC),
  '导入完成后要刷新文件列表（不刷新界面仍显示旧列表，用户以为导入失败）');

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
