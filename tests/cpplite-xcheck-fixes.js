#!/usr/bin/env node
/* ============================================================
   C++ 与真 g++ 对拍差异的四项修复（锁死，防回归）
   ------------------------------------------------------------
   这四项都是"**输出看着合理、实际是错的**"那类：
   不报错、不崩溃，值也像个正常值 —— 但在竞赛里就是 WA，
   而用户根本不会怀疑是解释器错了。

   ① sizeof(a)/sizeof(a[0])   旧 1  → 应为 5
      数组返回的是元素个数而不是字节数，差一个数量级。
   ② char c=65; cout<<c       旧 65 → 应为 A
      输出时没按声明类型解释（类型一直在 scope.t 里，只是没查）。
   ③ 重载 f(1)                旧 2  → 应为 1
      同名函数单槽互相覆盖，只剩最后定义的那个。
   ④ while(ss>>x) 求和        旧 3  → 应为 6
      流状态用"还剩几个 token"预判，读完最后一个就提前变假，
      最后一个数被读出却没进循环体。

   ⚠ 与 tests/xcheck.js 的分工：
     xcheck 需要本机装 g++，装不了就整体跳过；
     这个文件**不依赖 g++**，纯自研解释器可跑，
     所以在没有编译器的环境里这四项仍然被守着。
   ============================================================ */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');

global.window = global; global.Code = {};
eval(fs.readFileSync(path.join(root, 'js/cpplite.js'), 'utf8'));

function run(src, input) {
  var out = [];
  try {
    Code.cpplite.create(function (t) { out.push(t); }, function () { return input || ''; }).run(src);
  } catch (e) { return { err: String(e.message || e), out: out.join('') }; }
  return { err: null, out: out.join('') };
}

var P = 0, F = 0;
function eq(name, src, want, input) {
  var r = run(src, input);
  if (r.err) { F++; console.log('  ❌ ' + name + '  抛错：' + r.err); return; }
  if (r.out === String(want)) { P++; console.log('  ✅ ' + name + '  → ' + JSON.stringify(r.out)); }
  else { F++; console.log('  ❌ ' + name + '  实得 ' + JSON.stringify(r.out) + ' 期望 ' + JSON.stringify(String(want))); }
}

console.log('C++ 对拍差异修复：');

console.log('\n[① sizeof 返回字节数]');
eq('int a[5] 取长度', 'int main(){ int a[5]; cout<<sizeof(a)/sizeof(a[0]); }', 5);
eq('char a[5] 取长度', 'int main(){ char a[5]; cout<<sizeof(a)/sizeof(a[0]); }', 5);
eq('sizeof(int)', 'int main(){ cout<<sizeof(int); }', 4);
/* memset 依赖 sizeof，改字节数后它必须仍然只清真实元素，不能越界 */
eq('memset 仍正确',
  '#include <cstring>\nusing namespace std;\nint main(){ int a[5]; memset(a,0,sizeof(a)); a[2]=5; cout<<a[0]<<a[2]; }',
  '05');
/* 没写过的话会静默把 20 个元素全写 0 —— 数组越界但不报错 */
eq('memset 不越界',
  '#include <cstring>\nusing namespace std;\nint main(){ int a[3]={1,1,1}; memset(a,0,sizeof(a)); cout<<a[2]; }',
  0);

console.log('\n[② char 输出字符]');
eq('char c=65', 'int main(){ char c=65; cout<<c; }', 'A');
eq("char c='A'", "int main(){ char c='A'; cout<<c; }", 'A');
/* 反向：int 不能被误转成字符，否则 65 会变成 A */
eq('int 不误转', 'int main(){ int c=65; cout<<c; }', 65);
/* c+1 走整型提升，结果是 int，必须仍是数字 */
eq('char 运算提升为 int', 'int main(){ char c=65; cout<<c+1; }', 66);

console.log('\n[③ 重载决议]');
eq('f(1) 选 int 版',
  'int f(int a){ return 1; }\nint f(double a){ return 2; }\nint main(){ cout<<f(1); }', 1);
eq('f(1.5) 选 double 版',
  'int f(int a){ return 1; }\nint f(double a){ return 2; }\nint main(){ cout<<f(1.5); }', 2);
eq('两参数重载',
  'int g(int a,int b){ return 1; }\nint g(double a,double b){ return 2; }\nint main(){ cout<<g(1,2); }', 1);
/* 反例：不能因为加了重载就把单函数搞坏 */
eq('单函数不受影响', 'int f(int n){ return n*n; }\nint main(){ cout<<f(5); }', 25);
eq('递归不受影响',
  'int f(int n){ if(n<2) return n; return f(n-1)+f(n-2); }\nint main(){ cout<<f(10); }', 55);

console.log('\n[④ stringstream 流状态]');
eq('while(ss>>x) 求和',
  'int main(){ stringstream ss("1 2 3"); int x,s=0; while(ss>>x) s+=x; cout<<s; }', 6);
/* 空流不能进循环 —— 否则 s 会被加上一个 NaN 或空串 */
eq('空流不进循环',
  'int main(){ stringstream ss; int x,s=0; while(ss>>x) s+=x; cout<<s; }', 0);
eq('逐个读三个',
  'int main(){ stringstream ss("1 2 3"); int x,y,z; ss>>x; ss>>y; ss>>z; cout<<x<<y<<z; }', '123');
/* 链式 << 必须写进流里，不能打到 stdout */
eq('链式 << 写入流',
  'int main(){ stringstream ss; ss<<"a"<<1; cout<<ss.str(); }', 'a1');
eq('cout 链式不受影响', 'int main(){ cout<<1<<2; }', '12');

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
