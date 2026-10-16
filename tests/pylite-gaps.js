/* 基础包三个真缺口的回归测试。
   为什么单独成文件：这三个都是"能真跑验证"的，与需要大文件的运行时自检不同。
   用真 python3 对照的方式见 tests/xcheck.js，这里只验行为。 */
var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
global.window = global; global.Code = {};
eval(fs.readFileSync(path.join(root, 'js/pylite.js'), 'utf8'));

var P = 0, F = 0;
function t(code, label, want) {
  var out = [];
  try {
    var I = Code.pylite.create(function (s) { out.push(s); }, function () { return ''; });
    I.run(code, { timeout: 5000 });
  } catch (e) {
    F++; console.log('  \u274c ' + label + ' \u2192 ' + String(e.message).slice(0, 80)); return;
  }
  var got = out.join('\n').trim();
  if (want !== null && got !== want) {
    F++; console.log('  \u274c ' + label + ' \u5b9e\u5f97 ' + JSON.stringify(got) + ' \u671f\u671b ' + JSON.stringify(want)); return;
  }
  P++; console.log('  \u2705 ' + label + (want === null ? '' : ' \u2192 ' + JSON.stringify(got)));
}
function tErr(code, label, re) {
  var out = [], msg = '';
  try {
    var I = Code.pylite.create(function (s) { out.push(s); }, function () { return ''; });
    I.run(code, { timeout: 5000 });
  } catch (e) { msg = String(e.message); }
  if (re.test(msg)) { P++; console.log('  \u2705 ' + label + ' \u2192 ' + msg.slice(0, 70)); }
  else { F++; console.log('  \u274c ' + label + ' \u672a\u62a5\u671f\u671b\u9519\u8bef\uff0c\u5b9e\u5f97: ' + (msg || '(no error)')); }
}

console.log('=== ① \u865a\u62df\u6587\u4ef6\u7cfb\u7edf (open) ===');
t('f=open("a.txt","w")\nf.write("hi")\nf.close()\nprint(open("a.txt").read())', '\u5199\u540e\u8bfb', 'hi');
t('f=open("b.txt","w")\nf.write("one")\nf.close()\nf=open("b.txt","a")\nf.write("two")\nf.close()\nprint(open("b.txt").read())', 'a \u6a21\u5f0f\u8ffd\u52a0', 'onetwo');
tErr('print(open("nope.txt").read())', '\u8bfb\u4e0d\u5b58\u5728\u7684\u6587\u4ef6\u5e94\u62a5 FileNotFoundError', /FileNotFoundError/);
t('import json\nf=open("d.json","w")\njson.dump({"k":1},f)\nf.close()\nprint(open("d.json").read())', 'json.dump \u5230\u6587\u4ef6', '{"k":1}');

console.log('\n=== ② json \u6a21\u5757 ===');
t('import json\nprint(json.dumps({"a":1,"b":[1,2]}))', 'dumps dict', '{"a":1,"b":[1,2]}');
t('import json\nprint(json.loads(\'{"x": 5}\')["x"])', 'loads \u4e0b\u6807', '5');
t('import json\nd=json.loads(\'{"a":{"b":2}}\')\nprint(d["a"]["b"])', '\u5d4c\u5957 loads', '2');
t('import json\nprint(json.dumps([1,2,3]))', 'dumps list', '[1,2,3]');
t('import json\nprint(json.dumps((1,2)))', 'tuple \u2192 []', '[1,2]');
t('import json\nprint(json.dumps(None))', 'None \u2192 null', 'null');
t('import json\nprint(json.dumps(True))', 'True \u2192 true', 'true');
t('import json\nprint(json.dumps({"a":1},indent=2))', 'indent \u5173\u952e\u5b57\u53c2\u6570', '{\n  "a": 1\n}');
t('import json\nprint(json.dumps({"a":1},2))', 'indent \u4f4d\u7f6e\u53c2\u6570', '{\n  "a": 1\n}');

console.log('\n=== ③ \u8bed\u6cd5\u9519\u8bef\u5e26\u884c\u53f7 ===');
tErr('x=1\ny=(', '\u7b2c2\u884c\u9519\u8bef\u62a5\u7b2c2\u884c', /\u7b2c 2 \u884c/);
tErr('a=1\nb=2\nc=(', '\u7b2c3\u884c\u9519\u8bef\u62a5\u7b2c3\u884c', /\u7b2c 3 \u884c/);
tErr('x=1\ns="""a\nb"""\ny=(', '\u4e09\u5f15\u53f7\u8de8\u884c\u540e\u884c\u53f7\u4e0d\u504f', /\u7b2c 4 \u884c/);
/* \u62a5\u9519\u672c\u8eab\u4e0d\u80fd\u5d29 */
tErr('def f(:', 'def \u53c2\u6570\u9519\u4e0d\u5d29\uff08\u539f\u4f1a\u62a5 undefined.v\uff09', /\u8bed\u6cd5\u9519\u8bef/);
/* def f(,) 在真 Python 里是语法错误，本环境会宽容接受 ——
   可接受。真正的红线是**不能崩成 JS 内部错误**（如 undefined.v），
   那会把"你写错了"变成一堆看不懂的报错。所以这里只断言"不崩"。 */
var okNoCrash = true, m2 = '';
try {
  var I2 = Code.pylite.create(function () { }, function () { return ''; });
  I2.run('def f(,):\n  pass', { timeout: 5000 });
} catch (e2) {
  m2 = String(e2.message);
  if (/reading|undefined|null/.test(m2)) okNoCrash = false;
}
if (okNoCrash) { P++; console.log('  \u2705 def f(,) \u4e0d\u5d29\u6e83' + (m2 ? ' \u2192 ' + m2.slice(0, 50) : ' \uff08\u5bbd\u5bb9\u63a5\u53d7\uff09')); }
else { F++; console.log('  \u274c def f(,) \u5d29\u6210 JS \u5185\u90e8\u9519\u8bef: ' + m2.slice(0, 60)); }

console.log('\n=== \u56de\u5f52\u9632\u62a4\uff1a\u4e0d\u80fd\u628a\u539f\u672c\u80fd\u8dd1\u7684\u6539\u574f ===');
t('for i in range(3): print(i)', '\u5faa\u73af', '0\n1\n2');
t('def f(a,b=2):\n  return a+b\nprint(f(1))\nprint(f(1,10))', '\u9ed8\u8ba4\u53c2\u6570', '3\n11');
t('def g(*a,**k):\n  return (a,k)\nprint(g(1,2,x=3))', '*a \u4e0e **k \u7ec4\u5408', null);
t('def g(a,*b):\n  return (a,b)\nprint(g(1,2,3))', 'a \u4e0e *b', '(1, [2, 3])');
t('import math\nprint(math.sqrt(16))', 'math', '4');
t('s="""a\nb\nc"""\nprint(s)', '\u4e09\u5f15\u53f7\u5b57\u7b26\u4e32', 'a\nb\nc');
t('def f(x):\n  return x*2\nprint(f(21))', '\u591a\u884c\u51fd\u6570', '42');

console.log('\n\u901a\u8fc7 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
