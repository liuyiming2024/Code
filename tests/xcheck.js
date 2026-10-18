#!/usr/bin/env node
/* ============================================================
   与真 g++ 对拍
   ------------------------------------------------------------
   ⚠ 这个文件曾经存在，后来在一次"整理"提交中被连带删掉了，
   而我在那之后的多轮总结里**仍在声称"真 g++ 对照 53/53"**。
   那是**没有依据的说法** —— 测试已经没了，我却还在引用它的数字。

   教训写在这里：引用一个测试结果之前，先确认那个测试**还在**。
   现在重建，并且把用例直接写在文件里（不依赖外部文件），
   这样它不会再因为别处目录被删而消失。

   ---------- 为什么必须跟真编译器对拍 ----------
   自研解释器"跑通了"只能证明它不自相矛盾。
   只有跟真 g++ 输出一致，才能说它**语义正确**。
   差一个字符就是 WA，而用户不会知道是解释器错了。
   ============================================================ */
var fs = require('fs'), path = require('path');
var cp = require('child_process');
var root = path.join(__dirname, '..');

global.window = global; global.Code = {};
eval(fs.readFileSync(path.join(root, 'js/cpplite.js'), 'utf8'));

/* 用例：只用在真 g++ 和我们这里**都能跑**的语法范围内。
   覆盖竞赛最常用的输出/运算/控制流/数组/字符串/STL。 */
var CASES = [
  ['a+b', 'int main(){ int a,b; cin>>a>>b; cout<<a+b; }', '3 4'],
  ['输出', 'int main(){ cout<<"hello"; }', ''],
  ['换行', 'int main(){ cout<<1<<endl<<2; }', ''],
  ['循环求和', 'int main(){ int s=0; for(int i=1;i<=10;i++) s+=i; cout<<s; }', ''],
  ['while', 'int main(){ int i=0,s=0; while(i<5){ s+=i; i++; } cout<<s; }', ''],
  ['do-while', 'int main(){ int i=0; do{ i++; }while(i<5); cout<<i; }', ''],
  ['数组', 'int main(){ int a[5]; for(int i=0;i<5;i++) a[i]=i*i; cout<<a[3]; }', ''],
  ['数组初始化', 'int main(){ int a[3]={1,2,3}; cout<<a[0]+a[1]+a[2]; }', ''],
  ['二维', 'int main(){ int a[3][3]; a[1][1]=7; cout<<a[1][1]; }', ''],
  ['函数', 'int f(int n){ return n*n; }\nint main(){ cout<<f(5); }', ''],
  ['递归', 'int f(int n){ if(n<2) return n; return f(n-1)+f(n-2); }\nint main(){ cout<<f(10); }', ''],
  ['三目', 'int main(){ int x=5; cout<<(x>3?1:0); }', ''],
  ['switch', 'int main(){ int x=2; switch(x){ case 1: cout<<1; break; case 2: cout<<2; break; } }', ''],
  ['字符串', '#include <string>\nusing namespace std;\nint main(){ string s="ab"; s+="c"; cout<<s; }', ''],
  ['substr', '#include <string>\nusing namespace std;\nint main(){ string s="hello"; cout<<s.substr(1,3); }', ''],
  ['string长度', '#include <string>\nusing namespace std;\nint main(){ string s="abcd"; cout<<s.length(); }', ''],
  ['sort数组', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int a[5]={3,1,4,1,5}; sort(a,a+5); cout<<a[0]<<a[4]; }', ''],
  ['vector', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v; v.push_back(3); v.push_back(1); sort(v.begin(),v.end()); cout<<v[0]<<v[1]; }', ''],
  ['vector初始化列表', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{3,1,2}; sort(v.begin(),v.end()); cout<<v[0]<<v[1]<<v[2]; }', ''],
  ['vector大小', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v; v.push_back(1); cout<<v.size(); }', ''],
  ['map', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ map<string,int> m; m["a"]=5; cout<<m["a"]; }', ''],
  ['set', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ set<int> s; s.insert(3); s.insert(1); cout<<*s.begin(); }', ''],
  ['priority_queue', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ priority_queue<int> q; q.push(1);q.push(5); cout<<q.top(); }', ''],
  ['queue', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ queue<int> q; q.push(1); q.push(2); q.pop(); cout<<q.front(); }', ''],
  ['stack', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ stack<int> s; s.push(1); s.push(2); cout<<s.top(); }', ''],
  ['__gcd', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ cout<<__gcd(12,18); }', ''],
  ['max/min', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ cout<<max(3,7)<<min(3,7); }', ''],
  ['abs', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ cout<<abs(-5); }', ''],
  ['reverse数组', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int a[3]={1,2,3}; reverse(a,a+3); cout<<a[0]<<a[2]; }', ''],
  ['reverse迭代器', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{1,2,3}; reverse(v.begin(),v.end()); cout<<v[0]<<v[2]; }', ''],
  ['accumulate', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{1,2,3}; cout<<accumulate(v.begin(),v.end(),0); }', ''],
  ['lower_bound', '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{1,3,5}; cout<<*lower_bound(v.begin(),v.end(),3); }', ''],
  ['结构体', 'struct P{ int x; int y; };\nint main(){ P p; p.x=3; p.y=4; cout<<p.x+p.y; }', ''],
  ['结构体逗号成员', 'struct P{ int x,y; };\nint main(){ P p; p.x=3; p.y=4; cout<<p.x*p.y; }', ''],
  ['long long', 'int main(){ long long a=1000000000; cout<<a*10; }', ''],
  ['位运算', 'int main(){ cout<<(1<<10); }', ''],
  ['取模', 'int main(){ cout<<17%5; }', ''],
  ['整除', 'int main(){ cout<<17/5; }', ''],
  ['double', 'int main(){ cout<<7/2.0; }', ''],
  ['printf', '#include <cstdio>\nint main(){ printf("%d",42); }', ''],
  ['scanf', '#include <cstdio>\nint main(){ int x; scanf("%d",&x); printf("%d",x*2); }', '21'],
  ['嵌套循环', 'int main(){ int s=0; for(int i=0;i<3;i++) for(int j=0;j<3;j++) s++; cout<<s; }', ''],
  ['break/continue', 'int main(){ int s=0; for(int i=0;i<10;i++){ if(i==3) continue; if(i==6) break; s+=i; } cout<<s; }', ''],
  ['多组EOF', 'int main(){ int a,b; while(cin>>a>>b) cout<<a+b<<" "; }', '1 2\n3 4'],
  ['先读n', 'int main(){ int n,x,s=0; cin>>n; for(int i=0;i<n;i++){ cin>>x; s+=x; } cout<<s; }', '3\n1 2 3'],
  ['字符', 'int main(){ char c=65; cout<<c; }', ''],
  ['bool输出', 'int main(){ cout<<(3>2); }', ''],
  ['引用参数', 'void f(int &x){ x=9; }\nint main(){ int a=1; f(a); cout<<a; }', ''],
  ['默认参数', 'int f(int a,int b=10){ return a+b; }\nint main(){ cout<<f(1); }', ''],
  ['重载', 'int f(int a){ return 1; }\nint f(double a){ return 2; }\nint main(){ cout<<f(1); }', ''],
  ['sizeof', 'int main(){ int a[5]; cout<<sizeof(a)/sizeof(a[0]); }', ''],
  ['memset', '#include <cstring>\nusing namespace std;\nint main(){ int a[5]; memset(a,0,sizeof(a)); a[2]=5; cout<<a[0]<<a[2]; }', ''],
  ['stringstream拆分', '#include <sstream>\nusing namespace std;\nint main(){ stringstream ss("1 2 3"); int x,s=0; while(ss>>x) s+=x; cout<<s; }', ''],
];

/* ⚠ 真 g++ 必须显式 #include 与 using namespace std，
   而我们的解释器**默认就提供** std（写 cout 不用写 std::）。

   不补这段前导的话，绝大多数用例会因
   "'cout' was not declared in this scope" 编译失败 ——
   于是几乎全部"跳过"，对拍等于没做，
   而我却会看到一个"18/18 全过"的漂亮数字。

   **跳过率过高本身就是对拍失效的信号**，不能只看通过数。 */
function withPreamble(src) {
  if (/#include\s*<bits\/stdc\+\+/.test(src)) {
    return /using\s+namespace\s+std/.test(src) ? src : src + '\nusing namespace std;';
  }
  return '#include <bits/stdc++.h>\nusing namespace std;\n' + src;
}

function runReal(src, stdin) {
  var dir = fs.mkdtempSync('/tmp/xc');
  var f = path.join(dir, 'a.cpp'), b = path.join(dir, 'a.out');
  fs.writeFileSync(f, withPreamble(src));
  try {
    cp.execSync('g++ -std=c++17 -O0 -o ' + JSON.stringify(b) + ' ' + JSON.stringify(f), { stdio: 'pipe', timeout: 60000 });
    var out = cp.execSync(JSON.stringify(b), { input: stdin || '', timeout: 10000 }).toString();
    return { out: out.trim() };
  } catch (e) { return { err: String(e.message || e).slice(0, 60) }; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { } }
}

function runMine(src, lines) {
  var i = 0;
  var input = function () { return i < lines.length ? lines[i++] : ''; };
  var out = [];
  try {
    var I = Code.cpplite.create(function (s) { out.push(s); }, input);
    I.run(src, { timeout: 5000 });
  } catch (e) { return { err: String(e.message).slice(0, 60) }; }
  var got = out.filter(function (x) { return x.indexOf('[提示]') < 0; }).join('').trim();
  return { out: got };
}

var P = 0, F = 0, skip = 0;
console.log('与真 g++ 对拍');
CASES.forEach(function (c) {
  var name = c[0], src = c[1], stdin = c[2] || '';
  var lines = stdin ? stdin.split('\n') : [];
  var real = runReal(src, stdin);
  var mine = runMine(src, lines);
  if (real.err) { skip++; console.log('  ⊘ ' + name + '（真 g++ 也跑不了，跳过）'); return; }
  if (mine.err) { F++; console.log('  ❌ ' + name + ' → 我们报错：' + mine.err); return; }
  if (real.out === mine.out) { P++; console.log('  ✅ ' + name); }
  else { F++; console.log('  ❌ ' + name + ' → 真 ' + JSON.stringify(real.out) + ' / 我们 ' + JSON.stringify(mine.out)); }
});
console.log('\n一致 ' + P + ' / ' + (P + F) + (skip ? '（跳过 ' + skip + '）' : ''));
/* ⚠ 跳过率过高 = 对拍失效。
   上面那次就是 35/53 全跳过，却显示"18/18 全过" ——
   看起来很美，实际什么都没验。所以这里硬性要求跳过不超过 20%。 */
var total = CASES.length;
if (skip > Math.floor(total * 0.2)) {
  console.log('❌ 跳过 ' + skip + '/' + total + ' 太多了，对拍实际上没起作用');
  process.exit(1);
}
process.exit(F ? 1 : 0);
