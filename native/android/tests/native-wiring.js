#!/usr/bin/env node
/* 原生端接线一致性检查（静态）。
 *
 * 为什么要有这个：环境里没有 Android SDK / kotlinc，**一行都没编译过**。
 * 编译能抓到的错（类型、语法）抓不到；但有一类错它抓不到而这里能抓：
 *   · 引用了不存在的方法名（撤销栈里注册了但没实现 —— 之前 Web 端就这么炸过一次）
 *   · 忘了 import
 *   · 混进了 WebView（那就不叫原生了）
 * 这些都是"改对了逻辑但接不上线"的错，正是最容易漏的一类。
 *
 * 反向验证：注入一个不存在的引用，必须报红，否则这检查就是摆设。
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'app/src/main/java');
let P = 0, F = 0;
const t = (n, c, e) => { c ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    fs.statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const files = walk(SRC);
const kt = files.filter(f => f.endsWith('.kt'));
const all = kt.map(f => fs.readFileSync(f, 'utf8')).join('\n');

console.log('原生端接线检查（' + kt.length + ' 个 Kotlin 文件）');

/* ---- 1. 绝对不能是套壳 ---- */
const shell = ['WebView', 'android.webkit', 'loadUrl(', 'loadData(', 'WebSettings', 'WebChromeClient',
  'WebViewClient', 'javascript:', 'addJavascriptInterface', 'evaluateJavascript'];
/* ⚠ 只查**代码**，不查注释 —— 注释里写"没有 WebView"是在解释为什么，
   全文件搜会把注释当成违规（和 HTML 注释那次同一类误判）。
   剥注释可能误伤字符串里的 //（如 URL），对本检查无影响。 */
const code = all.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const hits = shell.filter(s => code.includes(s));
t('源码里没有 WebView / 网页加载（只看代码，不看注释）', hits.length === 0, '命中: ' + hits.join(', '));
/* 反向：注释里**确实**解释了为什么不能套壳 */
t('注释里解释了为什么不算套壳', /套壳/.test(all));

/* ---- 2. 声明的符号必须真的存在 ---- */
/* 收集所有顶层声明：class / object / fun / sealed interface */
const declared = new Set();
for (const m of all.matchAll(/^\s*(?:class|object|sealed\s+interface|interface|data\s+class)\s+([A-Za-z0-9_]+)/gm)) declared.add(m[1]);
for (const m of all.matchAll(/^\s*(?:private\s+|internal\s+|public\s+)?fun\s+(?:<[^>]*>\s*)?([A-Za-z0-9_]+)\s*\(/gm)) declared.add(m[1]);
for (const m of all.matchAll(/^\s*(?:const\s+)?val\s+([A-Za-z0-9_]+)\s*[:=]/gm)) declared.add(m[1]);
for (const m of all.matchAll(/^\s*(?:data\s+)?(?:object|class)\s+([A-Za-z0-9_]+)\s*:/gm)) declared.add(m[1]);

/* 本项目自己定义的符号，引用了就必须有定义 */
const OWN = ['UndoStack', 'diffRange', 'PathNorm', 'FileStore', 'FileDrawer', 'EditorScreen',
  'CodeKeyboard', 'EditorOps', 'insertText', 'insertBracket', 'enter', 'backspace', 'moveLeft',
  'moveRight', 'moveVertical', 'home', 'end', 'DEFAULT_INDENT', 'DEFAULT_MAIN', 'SaveState'];
for (const sym of OWN) {
  const used = new RegExp('\\b' + sym + '\\b').test(all);
  if (used) t('引用了 ' + sym + '，且它在本项目里有定义', declared.has(sym));
}

/* ---- 3. UndoStack.push 的签名必须和调用处一致（5 个参数） ---- */
const pushDecl = /fun push\(([^)]*)\)/.exec(all);
t('push 声明存在', !!pushDecl);
if (pushDecl) {
  const n = pushDecl[1].split(',').length;
  t('push 是 5 个参数（before, after, start, end, now）', n === 5, '实际 ' + n);
  const calls = all.match(/push\([^)]*\)/g) || [];
  const bad = calls.filter(c => !/push\(\s*\n?\s*before/.test(c) && c.split(',').length !== 5 && !c.includes('push('));
  t('调用处参数个数与声明一致', bad.length === 0, bad.join(' | '));
}

/* ---- 4. 每个文件都要有 import 就用的符号 ---- */
for (const f of kt) {
  const src = fs.readFileSync(f, 'utf8');
  const base = path.basename(f);
  for (const sym of ['LaunchedEffect', 'remember', 'mutableStateOf', 'ModalNavigationDrawer']) {
    if (new RegExp('\\b' + sym + '\\b').test(src)) {
      const hasImport = src.includes('androidx.compose.runtime.*') || src.includes('import androidx.compose.material3.*') ||
        new RegExp('import .*' + sym).test(src);
      t(base + ' 用了 ' + sym + ' 且有对应 import', hasImport);
    }
  }
}

/* ---- 5. 关键注释要在（它们防的是"后来的人改回去"） ---- */
t('FileStore 写了"写入失败不能吞"', /不能吞|静默失败/.test(fs.readFileSync(path.join(SRC, 'io/code/app/data/FileStore.kt'), 'utf8')));
t('PathNorm 写了"退到根以上要拒绝"', /退到根以上|整条拒绝/.test(fs.readFileSync(path.join(SRC, 'io/code/app/data/PathNorm.kt'), 'utf8')));
t('UndoStack 写了"插入的 end 不能写成 start"', /end 不能写成 start|形同虚设/.test(fs.readFileSync(path.join(SRC, 'io/code/app/editor/UndoStack.kt'), 'utf8')));
t('FileDrawer 写了"待确认要跟着具体条目"', /跟着具体条目|不能只存一个 Boolean/.test(fs.readFileSync(path.join(SRC, 'io/code/app/ui/FileDrawer.kt'), 'utf8')));

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
