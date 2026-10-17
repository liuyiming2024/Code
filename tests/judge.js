#!/usr/bin/env node
/* 判题器真跑测试 —— 用真的 cpplite / pylite 跑真的代码。 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = path.join(__dirname, '..');
const ctx = { console, Date, Math, JSON, String, Number, Array, Object, RegExp, Error };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['js/cpplite.js', 'js/pylite.js', 'js/judge.js']) {
  vm.runInContext(fs.readFileSync(path.join(R, f), 'utf8'), ctx, { filename: f });
}
const J = ctx.Code.judge;
let P = 0, F = 0;
const t = (n, ok, e) => { ok ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

console.log('判题器真跑测试');

/* C++：a+b，两组样例 */
const CPP = `#include <bits/stdc++.h>
using namespace std;
int main(){ int a,b; cin>>a>>b; cout<<a+b<<endl; return 0; }`;
const cases = [{ in: '1 2\n', out: '3\n', name: '样例1' }, { in: '10 20\n', out: '30\n', name: '样例2' }];
let r = J.judge('a.cpp', CPP, cases);
t('C++ 两组全过 → AC', r.verdict === 'AC' && r.passed === 2, JSON.stringify(r.verdict) + ' ' + r.passed + '/' + r.total);

/* 故意错一组 */
r = J.judge('a.cpp', CPP, [{ in: '1 2\n', out: '3\n' }, { in: '5 5\n', out: '99\n' }]);
t('有错 → WA', r.verdict === 'WA', r.verdict);
t('WA 时第一个样例仍算通过', r.details[0].ok === true);
t('WA 的样例给出期望与实得', r.details[1].want === '99\n' && r.details[1].got.trim() === '10',
  'want=' + JSON.stringify(r.details[1].want) + ' got=' + JSON.stringify(r.details[1].got));

/* 比对的三条细节 */
t('忽略行尾空格', J.judge('a.cpp', CPP, [{ in: '1 2\n', out: '3   \n' }]).verdict === 'AC');
t('忽略末尾多余换行', J.judge('a.cpp', CPP, [{ in: '1 2\n', out: '3\n\n\n' }]).verdict === 'AC');
t('归一 \\r\\n', J.judge('a.cpp', CPP, [{ in: '1 2\r\n', out: '3\r\n' }]).verdict === 'AC');
t('严格模式下行尾空格算错', J.judge('a.cpp', CPP, [{ in: '1 2\n', out: '3 \n' }], { strict: true }).verdict === 'WA');

/* Python */
const PY = `a,b = map(int, input().split())
print(a+b)`;
r = J.judge('a.py', PY, [{ in: '3 4\n', out: '7\n' }, { in: '100 1\n', out: '101\n' }]);
t('Python 两组全过 → AC', r.verdict === 'AC' && r.passed === 2, r.verdict + ' ' + r.passed);

/* 运行期错误 */
r = J.judge('a.py', `x = 1 // 0
print(x)`, [{ in: '', out: '1\n' }]);
t('运行期错误 → RE', r.verdict === 'RE', r.verdict);
t('RE 时带上错误信息', r.details[0].err.length > 0);

/* 语法错误 */
r = J.judge('a.cpp', `int main(){ cout << 1+1 `, [{ in: '', out: '2' }]);
t('语法错误 → RE 而不是崩', r.verdict === 'RE', r.verdict);

/* 没有 main */
r = J.judge('a.cpp', `int f(){ return 1; }`, [{ in: '', out: '1' }]);
t('没有 main → RE', r.verdict === 'RE');

/* 空样例 / 无样例 */
t('没有样例 → NONE 且给出提示', J.judge('a.cpp', CPP, []).verdict === 'NONE');
t('全是空样例 → NONE（不能误判 WA）', J.judge('a.cpp', CPP, [{ in: '', out: '' }]).verdict === 'NONE');
t('认不出语言 → NONE 且说明', J.judge('a.txt', CPP, cases).verdict === 'NONE');
t('判题器认不出时不硬跑（不给假结果）', J.judge('a.txt', CPP, cases).msg.indexOf('认不出') >= 0);

/* 归一化本身 */
t('norm 去末尾换行', J.norm('a\n\n') === 'a');
t('norm 去行尾空格', J.norm('a  \nb') === 'a\nb');
t('norm 保留行首空格', J.norm('  a') === '  a');
t('norm 处理 null', J.norm(null) === '');
t('normStrict 保留行尾空格', J.normStrict('a \n') === 'a ');

/* 输入一次给全：多组读取不能丢 */
const SUM = `#include <bits/stdc++.h>
using namespace std;
int main(){ int n; cin>>n; int s=0; for(int i=0;i<n;i++){int x; cin>>x; s+=x;} cout<<s<<endl; return 0; }`;
r = J.judge('a.cpp', SUM, [{ in: '4\n1 2 3 4\n', out: '10\n' }]);
t('多样例输入一次给全（for 循环读 n 个数）', r.verdict === 'AC', r.verdict + ' 实得 ' + JSON.stringify(r.details[0] && r.details[0].got));

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
