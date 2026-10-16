/* C++ 虚拟文件系统（ifstream/ofstream）的回归测试。
   ⚠ 与 Python 侧的 pylite 虚拟 FS **分开实现**（用户拍板），各存各的。
   真值对照：tests/xcheck.js 用真 g++ 逐字节比对。 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
global.window = global; global.Code = {};
eval(fs.readFileSync(path.join(root, 'js/cpplite.js'), 'utf8'));

var P = 0, F = 0;
function run(code, label, want) {
  var out = [];
  try {
    var I = Code.cpplite.create(function (s) { out.push(s); }, function () { return ''; });
    I.run(code, { timeout: 5000 });
  } catch (e) {
    F++; console.log('  \u274c ' + label + ' \u2192 ' + String(e.message).slice(0, 80)); return;
  }
  /* 过滤掉首次使用的提示行 —— 它只该出现一次，不是程序输出 */
  var got = out.filter(function (x) { return x.indexOf('[\u63d0\u793a]') < 0; }).join('').trim();
  if (want !== null && got !== want) {
    F++; console.log('  \u274c ' + label + ' \u5b9e\u5f97 ' + JSON.stringify(got) + ' \u671f\u671b ' + JSON.stringify(want)); return;
  }
  P++; console.log('  \u2705 ' + label + (want === null ? '' : ' \u2192 ' + JSON.stringify(got)));
}
function note(code, label, re) {
  var out = [];
  try {
    var I = Code.cpplite.create(function (s) { out.push(s); }, function () { return ''; });
    I.run(code, { timeout: 5000 });
  } catch (e) { F++; console.log('  \u274c ' + label + ' ' + String(e.message).slice(0, 60)); return; }
  var all = out.join('\n');
  if (re.test(all)) { P++; console.log('  \u2705 ' + label); }
  else { F++; console.log('  \u274c ' + label + ' \u672a\u51fa\u73b0\u671f\u671b\u5185\u5bb9'); }
}

console.log('=== \u5199\u5165\u4e0e\u8bfb\u51fa ===');
run('int main(){\n  ofstream fout("a.txt");\n  fout << "hi";\n  fout.close();\n  ifstream fin("a.txt");\n  string s;\n  fin >> s;\n  cout << s;\n}', 'ofstream \u5199\u5b57\u7b26\u4e32\uff0cifstream \u8bfb\u56de', 'hi');
run('int main(){\n  ofstream f("b.txt");\n  f << 1 << " " << 2;\n  f.close();\n  ifstream g("b.txt");\n  int x,y;\n  g >> x >> y;\n  cout << x+y;\n}', '\u5199\u6570\u5b57\u518d\u8bfb\uff08\u4e0e\u771f g++ \u5bf9\u7167\uff09', '3');
run('int main(){\n  ofstream f("e.txt");\n  f << "x";\n  f.close();\n  cout << "ok";\n}', 'ofstream \u4e0d\u5199 stdout', 'ok');

console.log('\n=== \u6253\u5f00\u5931\u8d25\u7684\u5224\u5b9a ===');
run('int main(){\n  ifstream fin("nope.txt");\n  if(!fin) cout << "fail";\n  else cout << "ok";\n}', 'if(!fin) \u6587\u4ef6\u4e0d\u5b58\u5728', 'fail');
run('int main(){\n  ofstream f("c.txt");\n  if(f.is_open()) cout << "open";\n  f.close();\n}', 'is_open()', 'open');
run('int main(){\n  ifstream fin("nope.txt");\n  cout << fin.good();\n}', 'good() \u5931\u8d25\u4e3a 0', '0');

console.log('\n=== freopen \u91cd\u5b9a\u5411\uff08\u7ade\u8d5b\u5e38\u7528\uff09 ===');
run('int main(){\n  ofstream f("in.txt");\n  f << "7 8";\n  f.close();\n  freopen("in.txt","r",stdin);\n  int a,b;\n  cin >> a >> b;\n  cout << a+b;\n}', 'freopen \u540e cin \u4ece\u6587\u4ef6\u8bfb', '15');

console.log('\n=== getline ===');
run('int main(){\n  ofstream f("g.txt");\n  f << "hello world" << endl;\n  f.close();\n  ifstream g("g.txt");\n  string s;\n  getline(g, s);\n  cout << s;\n}', 'getline \u4ece\u6587\u4ef6\u8bfb\u4e00\u884c', 'hello world');
run('int main(){\n  ofstream f("m.txt");\n  f << "l1" << endl << "l2" << endl;\n  f.close();\n  ifstream g("m.txt");\n  string a,b;\n  getline(g,a);\n  getline(g,b);\n  cout << a << "-" << b;\n}', 'getline \u8fde\u8bfb\u4e24\u884c', 'l1-l2');

console.log('\n=== \u5fc5\u987b\u544a\u77e5\u201c\u4e0d\u662f\u672c\u5730\u786c\u76d8\u201d ===');
note('int main(){ ofstream f("n.txt"); f << 1; f.close(); }', '\u9996\u6b21\u7528\u6587\u4ef6\u8981\u63d0\u793a\u662f\u865a\u62df\u6587\u4ef6\u7cfb\u7edf', /虚拟文件系统|不是本地硬盘/);

console.log('\n=== \u56de\u5f52\u9632\u62a4 ===');
run('int main(){ cout << 1+1; }', 'cout', '2');
run('int main(){ int n=8; cout << (n>>1); }', '\u4f4d\u79fb\u4e0d\u88ab\u8bef\u5224\u4e3a\u6d41', '4');
run('#include <iostream>\nusing namespace std;\nint main(){\n  int s=0;\n  for(int i=1;i<=10;i++) s+=i;\n  cout << s;\n}', '\u5faa\u73af', '55');
run('#include <iostream>\n#include <vector>\n#include <algorithm>\nusing namespace std;\nint main(){\n  vector<int> v = {3,1,2};\n  sort(v.begin(), v.end());\n  for(int x : v) cout << x;\n}', 'STL + \u8303\u56f4for', '123');
/* 语法错误要报错且带行号。
   ↵ 第一版我把它写成 want=null（期望不报错），
   于是“正确报错”被判成失败——又是测试写错凤枉对的代码。
   报错带行号是上一轮刚做的，这里顺手锁住不回退。 */
(function () {
  var code = 'int main(){\n  int x=1;\n  int y=(;\n}', msg = '';
  try {
    var I = Code.cpplite.create(function () { }, function () { return ''; });
    I.run(code, { timeout: 5000 });
  } catch (e) { msg = String(e.message); }
  if (/\u7b2c 3 \u884c/.test(msg)) { P++; console.log('  \u2705 \u8bed\u6cd5\u9519\u8bef\u4ecd\u5e26\u884c\u53f7 \u2192 ' + msg.slice(0, 46)); }
  else { F++; console.log('  \u274c \u8bed\u6cd5\u9519\u8bef\u884c\u53f7\u56de\u9000\uff0c\u5b9e\u5f97: ' + (msg || '(\u672a\u62a5\u9519)')); }
})();

console.log('\n\u901a\u8fc7 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
