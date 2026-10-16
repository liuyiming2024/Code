/* C++ 报错行号的回归测试。
   与 tests/pylite-gaps.js 对齐：Python 侧先做了同样的事，C++ 补上。
   为什么单独成文件：这些都能真跑验证，不依赖大文件下载。 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
global.window = global; global.Code = {};
eval(fs.readFileSync(path.join(root, 'js/cpplite.js'), 'utf8'));

var P = 0, F = 0;
function run(code, label, el) {
  var out = [];
  try {
    var I = Code.cpplite.create(function (s) { out.push(s); }, function () { return ''; });
    I.run(code, { timeout: 5000 });
    if (el) { F++; console.log('  \u274c ' + label + ' \u672a\u62a5\u9519\uff0c\u5b9e\u5f97 ' + JSON.stringify(out.join('').trim())); return; }
    P++; console.log('  \u2705 ' + label + ' \u2192 ' + JSON.stringify(out.join('').trim()));
  } catch (e) {
    var m = String(e.message);
    if (!el) { F++; console.log('  \u274c ' + label + ' \u5e94\u8be5\u80fd\u8dd1\u5374\u62a5\u9519: ' + m.slice(0, 60)); return; }
    if (m.indexOf('\u7b2c ' + el + ' \u884c') >= 0) { P++; console.log('  \u2705 ' + label + ' \u2192 ' + m.slice(0, 62)); }
    else { F++; console.log('  \u274c ' + label + ' \u5b9e\u5f97 ' + m.slice(0, 56) + ' \u672c\u671b\u7b2c ' + el + ' \u884c'); }
  }
}

console.log('=== \u8bed\u6cd5\u9519\u8bef\u5e26\u884c\u53f7 ===');
run('int main(){ cout << 1+', '\u5355\u884c\u672a\u95ed\u5408', 1);
run('int a=1;\nint b=2;\nint main(){ cout <<', '\u7b2c3\u884c\u672a\u95ed\u5408', 3);
run('int main(){\n  int x = ;\n}', '\u7b2c2\u884c\u7f3a\u503c', 2);
run('int main(){\n  int x = 1;\n  int y = ;\n}', '\u7b2c3\u884c\u7f3a\u503c', 3);

console.log('\n=== \u6ce8\u91ca\u4e0e\u9884\u5904\u7406\u540e\u884c\u53f7\u4e0d\u504f ===');
run('// \u6ce8\u91ca\nint main(){ cout << 1+', '\u884c\u6ce8\u91ca\u540e', 2);
run('// a\n// b\nint main(){ cout << 1+', '\u4e24\u4e2a\u884c\u6ce8\u91ca\u540e', 3);
run('/* \u5757\n\u6ce8\u91ca\n\u591a\u884c */\nint main(){ cout << 1+', '\u5757\u6ce8\u91ca\u8de83\u884c\u540e', 4);
run('#include <iostream>\nint main(){ cout << 1+', 'include \u540e', 2);
run('#include <iostream>\n#include <vector>\nusing namespace std;\nint main(){ cout << 1+', '\u6df7\u5408', 4);
run('// c\n#include <iostream>\nint main(){ cout << 1+', '\u6ce8\u91ca+include', 3);

console.log('\n=== \u53d8\u91cf\u672a\u5b9a\u4e49\u5e26\u884c\u53f7 ===');
run('int main(){ cout << abc; }', '\u5355\u884c\u53d8\u91cf\u672a\u5b9a\u4e49', 1);
run('int main(){\n  int x = 1;\n  cout << yyy;\n}', '\u7b2c3\u884c\u53d8\u91cf\u672a\u5b9a\u4e49', 3);
run('#include <iostream>\nusing namespace std;\nint main(){\n  cout << zz;\n}', 'include \u540e\u53d8\u91cf\u672a\u5b9a\u4e49', 4);
run('int main(){\n  // \u6ce8\u91ca\n  cout << qq;\n}', '\u6ce8\u91ca\u540e\u53d8\u91cf\u672a\u5b9a\u4e49', 3);

console.log('\n=== \u56de\u5f52\u9632\u62a4\uff1a\u4e0d\u80fd\u628a\u539f\u672c\u80fd\u8dd1\u7684\u6539\u574f ===');
run('int main(){ cout << 1+1; }', '\u57fa\u7840\u8fd0\u884c', null);
run('int main(){ int a=1; cout << a+1; }', '\u53d8\u91cf', null);
run('#include <iostream>\nusing namespace std;\nint main(){ cout << "hi"; }', 'include + \u5b57\u7b26\u4e32', null);
run('#define N 5\nint main(){ cout << N; }', '\u5b8f\u5c55\u5f00', null);
run('#include <iostream>\nusing namespace std;\nint main(){\n  int s=0;\n  for(int i=1;i<=10;i++) s+=i;\n  cout << s;\n}', '\u591a\u884c\u5faa\u73af', null);
run('#include <iostream>\n#include <vector>\n#include <algorithm>\nusing namespace std;\nint main(){\n  vector<int> v = {3,1,2};\n  sort(v.begin(), v.end());\n  for(int x : v) cout << x;\n}', 'STL + \u8303\u56f4for', null);

console.log('\n\u901a\u8fc7 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
