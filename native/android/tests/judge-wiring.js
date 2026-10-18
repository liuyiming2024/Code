#!/usr/bin/env node
/* 原生端判题接线检查。
   Kotlin 编不了（没 Android SDK），查的是"逻辑对了但接不上线"：
   引用不存在的方法、页签加了没同步、键盘转投漏一个。
   反向验证必须能报红，否则这检查就是摆设。 */
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..');
const B = path.join(R, 'app/src/main/java/io/code/app');
const read = (p) => fs.readFileSync(path.join(B, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const judgeOps = read('judge/JudgeOps.kt');
const runner = read('judge/JudgeRunner.kt');
const panel = read('ui/JudgePanel.kt');
const screen = read('ui/EditorScreen.kt');
const editorOps = read('editor/EditorOps.kt');
const co = strip(judgeOps), cr = strip(runner), cp = strip(panel), cs = strip(screen);

let P = 0, F = 0;
const t = (n, ok, e) => { ok ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

console.log('原生端判题接线');

/* ---------- 1. 每组必须新建引擎（组间污染） ---------- */
t('每组调用 create 新建引擎', /QuickJsRunner\.create\(/.test(cr));
/* 最关键：无条件释放。只在成功路径释放的话，超时/出错会泄漏 */
const fin = /\} finally \{[\s\S]*?\n    \}/.exec(cr);
t('有 finally 块', !!fin);
t('finally 里无条件关闭引擎', !!fin && /engine\.close\(\)/.test(fin[0]),
  fin ? fin[0].slice(0, 60) : '');
t('close 用 runCatching 包住（关闭失败不能崩）', /runCatching \{ engine\.close\(\) \}/.test(cr));

/* ---------- 2. 判题不走 RunHost ---------- */
t('判题不引用 RunHost（它复用引擎，与判题冲突）', !/RunHost/.test(cr));

/* ---------- 3. 引用的 EditorOps 函数必须真的存在 ---------- */
const used = [...new Set([...cp.matchAll(/io\.code\.app\.editor\.(\w+)\(/g)].map(m => m[1]))];
t('样例区复用了编辑器操作函数', used.length > 0, used.join(','));
used.forEach(fnName => {
  t('  引用 ' + fnName + ' 确实存在于 EditorOps',
    new RegExp('fun ' + fnName + '\\s*\\(').test(editorOps));
});

/* ---------- 4. 页签不能写死 ---------- */
t('定义了 PanelTab 枚举', /enum class PanelTab/.test(screen));
t('UI 从 values() 遍历（不硬编码名单）', /PanelTab\.values\(\)/.test(cs));
t('两个面板按页签切换 visible',
  /run\.visible = panelTab == PanelTab\.Run/.test(cs) &&
  /judge\.visible = panelTab == PanelTab\.Judge/.test(cs));

/* ---------- 5. 键盘转投：三个框都要 ---------- */
t('代码区（默认路径）', /history\.undo/.test(cs));
t('输入区 stdin 转投', /run\.stdinFocused/.test(cs) && /applyToStdin/.test(cs));
t('样例区 cases 转投', /judge\.casesFocused/.test(cs) && /applyToCases/.test(cs));
/* 顺序：cases 必须在 stdin 之后、其它之前，否则按键会同时进两个框 */
t('cases 分派在 stdin 之后',
  cs.indexOf('run.stdinFocused') < cs.indexOf('judge.casesFocused'));
t('cases 分派在 Undo 之前',
  cs.indexOf('judge.casesFocused') < cs.indexOf('EditAction.Undo'));

/* ---------- 6. 空样例必须拦 ---------- */
t('样例为空时不跑（不假称通过）', /cases\.isEmpty\(\)[\s\S]{0,120}?没有样例|样例为空/.test(screen));
t('代码为空时不跑', /code\.isBlank\(\)/.test(screen));
t('认不出语言时明确提示', /runnerId == null/.test(screen));

/* ---------- 7. 换文件清空 ---------- */
t('换文件清判题结果', /judge\.reset\(\)/.test(cs));

/* ---------- 8. 样例持久化 ---------- */
t('按文件存样例', /casesPathFor/.test(cs) && /store\.write\(casesPath/.test(cs));
t('打开时读回样例', /store\.exists\(casesPath\)/.test(cs) && /store\.read\(casesPath\)/.test(cs));

/* ---------- 9. JudgeRunner 释放 ---------- */
t('DisposableEffect 里释放判题引擎', /DisposableEffect\(Unit\)[\s\S]{0,80}?judgeRunner\.close\(\)/.test(cs));

/* ---------- 10. 判定语义 ---------- */
t('TLE 单独判定（不和 WA 混）', /Verdict\.TLE/.test(cr));
t('超时后不算通过', /r\.timeout ->/.test(cr));
/* ⚠ 上一版写 /Verdict\.UNKNOWN/ 是错的：
   UNKNOWN 在 enum 里定义时**不带** Verdict. 前缀，
   于是正确的代码被判成失败 —— 这是本项目第 10 次栽在
   "断言照着想象写，没去看实际源码长什么样"。 */
t('枚举里定义了 UNKNOWN', /^\s*UNKNOWN[,;]/m.test(co));
t('UNKNOWN 有中文名（不显示枚举名）', /UNKNOWN -> "结果未知"/.test(co));
/* 真正的语义保证在 allPassed：只要不是 AC 就不算通过 */
t('非 AC 一律不算通过（UNKNOWN 自然被排除）',
  /results\.all \{ it\.verdict == Verdict\.AC \}/.test(co));
t('全 AC 才算通过', /all \{ it\.verdict == Verdict\.AC \}/.test(co));

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
