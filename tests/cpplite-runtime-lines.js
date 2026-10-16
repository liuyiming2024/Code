/* C++ **运行期**错误带行号的回归测试。
   上一轮做的是语法错误（解析期）的行号；这一轮是运行期：
   越界、除零、溢出、未定义函数。
   为什么分开成文件：两者的报错点完全不同，分开才好定位回归。 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
global.window = global; global.Code = {};
eval(fs.readFileSync(path.join(root, 'js/cpplite.js'), 'utf8'));

var P = 0, F = 0;
function err(code, label, line) {
  var out = [];
  var msg = '';
  try {
    var I = Code.cpplite.create(function (s) { out.push(s); }, function () { return ''; });
    I.run(code, { timeout: 5000 });
  } catch (e) { msg = String(e.message); }
  if (!msg) { F++; console.log('  \u274c ' + label + ' \u672a\u62a5\u9519\uff0c\u5b9e\u5f97 ' + JSON.stringify(out.join('').trim())); return; }
  var ok = msg.indexOf('\u7b2c ' + line + ' \u884c') >= 0;
  if (ok) { P++; console.log('  \u2705 ' + label + ' \u2192 ' + msg.slice(0, 52)); }
  else { F++; console.log('  \u274c ' + label + ' \u5b9e\u5f97 ' + msg.slice(0, 50) + ' \u672c\u671b\u7b2c ' + line + ' \u884c'); }
}
function ok(code, label, want) {
  var out = [];
  try {
    var I = Code.cpplite.create(function (s) { out.push(s); }, function () { return ''; });
    I.run(code, { timeout: 5000 });
  } catch (e) { F++; console.log('  \u274c ' + label + ' \u5d29\u6e83: ' + String(e.message).slice(0, 60)); return; }
  var got = out.filter(function (x) { return x.indexOf('[\u63d0\u793a]') < 0; }).join('').trim();
  if (want !== null && got !== want) { F++; console.log('  \u274c ' + label + ' \u5b9e\u5f97 ' + JSON.stringify(got) + ' \u671f\u671b ' + JSON.stringify(want)); return; }
  P++; console.log('  \u2705 ' + label + (want === null ? '' : ' \u2192 ' + JSON.stringify(got)));
}

console.log('=== \u6570\u7ec4\u8d8a\u754c ===');
err('int main(){\n  int a[3];\n  cout << a[10];\n}', '\u8d8a\u754c\u8bfb', 3);
err('int main(){\n  int a[3];\n  int b=1;\n  a[10]=5;\n}', '\u8d8a\u754c\u5199', 4);
err('int main(){\n  vector<int> v;\n  cout << v[5];\n}', 'vector \u8d8a\u754c', 3);
err('#include <iostream>\nusing namespace std;\nint main(){\n  int a[3];\n  for(int i=0;i<3;i++) a[i]=i;\n  cout << a[99];\n}', '\u591a\u884c\u5b9a\u4f4d', 6);

console.log('\n=== \u9664\u96f6 ===');
err('int main(){\n  int x=0;\n  cout << 10/x;\n}', '\u6574\u6570\u9664\u96f6', 3);

console.log('\n=== \u6ea2\u51fa ===');
err('int main(){\n  int a=2147483647;\n  a=a+1;\n}', 'int \u6ea2\u51fa', 3);

console.log('\n=== \u672a\u5b9a\u4e49\u51fd\u6570 ===');
err('int main(){\n  cout << f(1);\n}', '\u672a\u5b9a\u4e49\u51fd\u6570', 2);

console.log('\n=== \u56de\u5f52\u9632\u62a4\uff1a\u6b63\u5e38\u4ee3\u7801\u4e0d\u80fd\u88ab\u6539\u574f ===');
ok('int main(){ cout << 1+1; }', 'cout', '2');
ok('int main(){ int a[3]; a[0]=7; cout << a[0]; }', '\u6570\u7ec4\u6b63\u5e38', '7');
ok('int main(){ int n=8; cout << (n>>1); }', '\u4f4d\u79fb\u4e0d\u88ab\u8bef\u5224', '4');
ok('int main(){ long long x=2147483647; x=x+1; cout<<x; }', 'long long \u4e0d\u8bef\u62a5\u6ea2\u51fa', '2147483648');
ok('int main(){\n  int s=0;\n  for(int i=1;i<=10;i++) s+=i;\n  cout << s;\n}', '\u5faa\u73af', '55');
ok('int main(){\n  int x=1;\n  x=x+1;\n  cout<<x;\n}', '\u8d4b\u503c\u4e0d\u80fd\u5d29\uff08assignTo \u91cc\u6ca1\u6709 node\uff09', '2');
ok('#include <iostream>\n#include <vector>\n#include <algorithm>\nusing namespace std;\nint main(){\n  vector<int> v = {3,1,2};\n  sort(v.begin(), v.end());\n  for(int x : v) cout << x;\n}', 'STL + \u8303\u56f4for', '123');

console.log('\n\u901a\u8fc7 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
