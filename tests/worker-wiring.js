/* rt-worker.js 的**接线一致性**测试。
 *
 * 为什么要这个测试：
 *   本文件反复栽在同一个坑上 —— "注册了 A 却漏了 B"。
 *   ① RUNNERS 只注册 'sql'，而 langs.js 里 SQL 的 wasm.id 是 'sqlite'
 *      → 用户实测报「没有这个运行时」，而文件明明已经下载好了。
 *   ② 我补别名时写了 `quickjs: runQuickJS`，而 runQuickJS **从未声明**。
 *      RUNNERS 是 Worker 顶层的对象字面量，求值它就会去读标识符，
 *      于是 ReferenceError 发生在**脚本求值阶段** ——
 *      整个 Worker 一行都跑不起来，SQL/Python/Lua/PHP/Ruby 全部陪葬，
 *      界面上只有一句 "Worker 错误"，完全看不出是哪一行。
 *   ③ RUNNERS 补了 'pyodide'，PROBES 却没补 → 自检报「没有写探针」。
 *
 * 这三类都是**静态就能查出来**的，不需要真跑运行时。
 * 所以在这里一并挡住：坏接线绝不能推送出去。 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var w = fs.readFileSync(path.join(root, 'js/rt-worker.js'), 'utf8');
var langs = fs.readFileSync(path.join(root, 'js/langs.js'), 'utf8');

var P = 0, F = 0;
function t(ok, msg, extra) {
  if (ok) { P++; console.log('  \u2705 ' + msg); }
  else { F++; console.log('  \u274c ' + msg + (extra ? '\n       ' + extra : '')); }
}
function block(name) {
  var m = new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\n\\};').exec(w);
  if (!m) { F++; console.log('  \u274c \u627e\u4e0d\u5230 ' + name + ' \u5757'); return ''; }
  return m[1];
}
function keys(src, name) {
  var b = block(name);
  var ks = [];
  /* 两种写法都认：`key: {`（多行）与 `key: { ... }`（单行） */
  var re = /(?:^|\s)(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{/g, m;
  while ((m = re.exec(b))) ks.push(m[1] || m[2] || m[3]);
  var re2 = /(?:^|\s)(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*[A-Za-z_$][\w$]*/g;
  while ((m = re2.exec(b))) {
    var k = m[1] || m[2] || m[3];
    if (ks.indexOf(k) < 0) ks.push(k);
  }
  return ks;
}

console.log('=== 1. RUNNERS 里的每个值都必须是本文件里真实声明的函数 ===');
var declared = {}, m;
var dre = /^function\s+([A-Za-z_$][\w$]*)/gm;
while ((m = dre.exec(w))) declared[m[1]] = true;
var rb = block('RUNNERS');
var vre = /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g, miss = [];
while ((m = vre.exec(rb))) { if (!declared[m[2]]) miss.push(m[1] + ' -> ' + m[2]); }
t(miss.length === 0, 'RUNNERS 没有指向未声明的函数',
  miss.length ? '未声明：' + miss.join('、') +
    '\n       （写错一个名字会让整个 Worker 在求值阶段就崩，所有运行时一起死）' : '');

console.log('\n=== 2. RUNNERS 与 PROBES 的键要一一对应 ===');
var rk = keys(w, 'RUNNERS'), pk = keys(w, 'PROBES');
rk.forEach(function (k) {
  t(pk.indexOf(k) >= 0, 'PROBES 有 "' + k + '"（否则自检报「没有写探针」）');
});
pk.forEach(function (k) {
  t(rk.indexOf(k) >= 0, 'RUNNERS 有 "' + k + '"（否则自检报「没有这个运行时」）');
});

console.log('\n=== 3. langs.js 里可下载语言的 wasm.id 都要能查到 ===');
/* 取 langs.js 里所有 wasm:{id:'xxx'} */
var ids = [], ire = /wasm:\s*\{[^}]*id:\s*'([^']+)'/g;
while ((m = ire.exec(langs))) ids.push(m[1]);
ids = ids.filter(function (x, i) { return ids.indexOf(x) === i; });
ids.forEach(function (id) {
  /* quickjs 目前没有实现执行器，不注册是**正确**的（报"没有这个运行时"可追）；
     一旦注册就必须两个表都有。 */
  if (id === 'quickjs') {
    t(rk.indexOf(id) < 0 || (pk.indexOf(id) >= 0 && declared[(/quickjs: (\w+)/.exec(rb) || [])[1]]),
      'quickjs：要么不注册，要么 RUNNERS+PROBES 都有且函数存在');
    return;
  }
  t(rk.indexOf(id) >= 0, 'RUNNERS 认得 langs.js 的 wasm.id "' + id + '"');
  t(pk.indexOf(id) >= 0, 'PROBES 认得 langs.js 的 wasm.id "' + id + '"');
});

console.log('\n=== 4. NEED 里的文件名都要能在 runtimes.json 清单里找到 ===');
var man = JSON.parse(fs.readFileSync(path.join(root, 'api/runtimes.json'), 'utf8'));
var list = man.runtimes || [];
var allFiles = {};
list.forEach(function (rt) { (rt.files || []).forEach(function (f) { allFiles[f.name] = true; }); });
var nb = block('NEED'), fre = /'([^']+\.(?:js|wasm|zip|tar|json))'/g, want = [];
while ((m = fre.exec(nb))) if (want.indexOf(m[1]) < 0) want.push(m[1]);
var lacking = want.filter(function (f) { return !allFiles[f]; });
t(lacking.length === 0, 'NEED 引用的文件都在清单里',
  lacking.length ? '清单里没有：' + lacking.join('、') : '');

console.log('\n\u901a\u8fc7 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
