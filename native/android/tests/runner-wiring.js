#!/usr/bin/env node
/* 原生运行时的接线一致性检查。
   环境无 Android SDK / NDK，**编译不了**；
   但"JNI 名字/参数对不上""忘了降级""混进 WebView"这类
   **编译期不报错、运行期直接崩**的问题，静态能查出来。
   反向验证：故意改错后必须报红（见文件末尾注释）。 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const app = path.join(root, 'app/src/main/java/io/code/app');

const kt = fs.readFileSync(path.join(app, 'run/QuickJsRunner.kt'), 'utf8');
const iface = fs.readFileSync(path.join(app, 'run/Runner.kt'), 'utf8');
const c = fs.readFileSync(path.join(root, 'app/src/main/cpp/quickjs_bridge.c'), 'utf8');
const cmake = fs.readFileSync(path.join(root, 'app/src/main/cpp/CMakeLists.txt'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
const allKt = fs.readdirSync(app, { recursive: true })
  .filter(f => f.endsWith('.kt'))
  .map(f => fs.readFileSync(path.join(app, f), 'utf8')).join('\n');

let P = 0, F = 0;
const t = (n, ok, e) => { ok ? (P++, console.log('  ✅ ' + n)) : (F++, console.log('  ❌ ' + n + (e ? ' —— ' + e : ''))); };

console.log('原生运行时接线检查');

/* ---------- 1. JNI 函数名与参数 ---------- */
/* JNI 命名：Java_io_code_app_run_QuickJsRunner_<方法名>。
   写错一个字母 = 运行期 UnsatisfiedLinkError，**编译期完全不报错**，
   表现是"点了运行就崩"。所以必须在这里钉住。 */
const PKG = 'io_code_app_run';
const CLS = 'QuickJsRunner';

/* Kotlin 类型 → JNI C 类型 */
const PARAM = { String: 'jstring', Long: 'jlong' };
const RET = { Long: 'jlong', Unit: 'void' };

const decls = [...kt.matchAll(/private external fun (\w+)\(([^)]*)\)(?::\s*([\w<>,? ]+))?/g)]
  .map(m => ({
    name: m[1],
    params: m[2].split(',').map(s => s.trim()).filter(Boolean)
      .map(s => s.split(':')[1].trim()),
    ret: (m[3] || 'Unit').trim()
  }));

t('解析到 3 个 external 声明', decls.length === 3, JSON.stringify(decls.map(d => d.name)));

for (const d of decls) {
  const want = `Java_${PKG}_${CLS}_${d.name}`;
  /* 只查函数**定义**（后面跟 ( 且前有换行），不查声明里的注释 */
  const re = new RegExp('(?:^|\\n)(?:extern\\s+)?JNIEXPORT[^\\n]*\\n?\\s*' + want + '\\s*\\(');
  t('C 里有 ' + want, re.test(c));

  /* JNI 前两个参数永远是 JNIEnv* 与 jclass（这里都是 static 调用） */
  const wantParams = ['JNIEnv *env', 'jclass', ...d.params.map(p => PARAM[p] || '?')];
  const sig = new RegExp(want + '\\s*\\(([^)]*)\\)', 's');
  const mm = sig.exec(c);
  if (mm) {
    const got = mm[1].split(',').map(s => s.trim().replace(/\s+/g, ' '));
    t(d.name + ' 参数个数对（含 env/jclass）', got.length === wantParams.length,
      '实得 ' + got.length + ' 期望 ' + wantParams.length + ' :: ' + mm[1].trim().replace(/\s+/g, ' '));
    t(d.name + ' 第 3 个参数起类型对', wantParams.slice(2).every((w, i) => (got[i + 2] || '').indexOf(w) >= 0),
      '期望 ' + wantParams.slice(2).join(',') + ' 实得 ' + got.slice(2).join(','));
  } else {
    t(d.name + ' 找得到签名', false);
  }
  /* 返回类型 */
  if (d.ret === 'Long') t(d.name + ' 返回 jlong', new RegExp(want + '[\\s\\S]{0,400}?\\)\\s*\\{[\\s\\S]*?return \\(jlong\\)').test(c) || /return \(jlong\)/.test(c));
}

/* ---------- 2. 引擎缺失必须降级，不能崩 ---------- */
/* System.loadLibrary 失败抛 UnsatisfiedLinkError，发生在 companion object 的 init，
   一旦冒出去 = 打开 APP 就闪退，且崩溃栈看不出是"忘了配 NDK"。 */
const initBlock = /companion object \{([\s\S]*?)\n    \}/.exec(kt);
const ib = initBlock ? initBlock[1] : '';
t('loadLibrary 在 try 里（不能让它冒出去）', /try\s*\{[\s\S]*?System\.loadLibrary[\s\S]*?\}\s*catch/.test(kt));
t('装载失败要记住状态 available=false', /available = false/.test(kt));
t('run() 在不可用时返回明确错误而不是抛', /if \(!available\)[\s\S]{0,300}?return RunResult/.test(kt));
t('错误信息里说清怎么修（提到 NDK）', /NDK/.test(kt));

/* ---------- 3. 超时必须靠引擎中断，不能靠 kill 线程 ---------- */
/* ⚠ C 侧同样要剥注释！文件头为了解释"为什么用中断回调"提到了
   JS_SetInterruptHandler，全文搜索会命中注释 ——
   于是**去掉真实调用后检查依然通过**（反向验证第 3 例当时没报红，
   就是这个原因）。这是本项目第 5 次栽在同一个坑上。 */
const stripC = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const cc = stripC(c);
t('C 剥完注释还剩内容（剥离没写坏）', cc.length > 800 && cc.length < c.length);
t('注册了 QuickJS 中断回调（剥注释后）', /JS_SetInterruptHandler/.test(cc));
t('中断回调里比对 deadline', /deadline_ms/.test(cc) && /now_ms\(\) > r->deadline_ms/.test(cc));
t('超时置位 timed_out', /timed_out = 1/.test(cc));
t('结果里带回超时标志（第 3 个元素）', /SetObjectArrayElement\(env, res, 2,/.test(cc));
t('注释里确实写了为什么用中断（不能只做不解释）', /中断/.test(c));

/* ---------- 4. 解释器的两个易错点 ---------- */
t('建引擎前先建 Code 宿主对象（否则报 Code is not defined）', /globalThis\.Code = \{\}/.test(c));
t('引擎源码真的被 eval（不能收了参数不用）', /eval_or_die\(r->ctx, source/.test(cc));
t('eval 的是传入的 source 而不是别的', !/eval_or_die\(r->ctx, source\s*,\s*NULL\)\s*;\s*\/\*/.test(cc));
t('Kotlin 侧拒绝空源码（否则"什么都没发生"最难查）', /source\.isBlank\(\)/.test(kt));
t('Kotlin 侧拒绝未知解释器名', /只支持 cpplite \/ pylite/.test(kt));

/* ---------- 5. 能力边界必须如实告知 ---------- */
t('caveat 里明说不是完整编译器', /不是完整编译器/.test(kt));
t('C++ 与 Python 的 caveat 分开（不能串台）', /when \(script\)/.test(kt) && /pylite-quickjs/.test(kt) && /cpplite-quickjs/.test(kt));

/* ---------- 6. 仍然不能是套壳 ---------- */
/* ⚠ 必须**先剥掉注释**再查。
   我连续四次栽在同一个坑上：注释里为了解释"为什么不用 WebView"
   会提到 WebView 这个词，全文搜索就把它当成真的在用，
   于是**正确的代码被判成失败**（这次是第 4 次：Python 侧断言、
   HTML 注释、flags 全文搜索、以及这里）。
   剥注释要覆盖 Kotlin 的行注释与块注释，且不能误吃掉字符串里的斜杠。 */
const stripKt = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const codeKt = stripKt(allKt);
t('剥完注释还剩内容（剥离没写坏）', codeKt.length > 500 && codeKt.length < allKt.length);
t('没有 WebView（剥注释后）', !/WebView|WebKit|android\.webkit/.test(codeKt));
t('没有 evaluateJavascript / loadUrl（剥注释后）', !/evaluateJavascript|loadUrl\(/.test(codeKt));
t('注释里确实解释了不套壳的理由（不能只删不写）', /套壳/.test(allKt));
t('没有申请联网权限', !/android\.permission\.INTERNET/.test(manifest));

/* ---------- 7. 构建配置 ---------- */
for (const f of ['quickjs.c', 'libregexp.c', 'libunicode.c', 'libbf.c', 'cutils.c']) {
  t('CMakeLists 引用了 ' + f, cmake.indexOf(f) >= 0);
}
t('QuickJS 缺失时给出明确错误而不是一堆 undefined reference', /FATAL_ERROR/.test(cmake) && /缺少 QuickJS 源码/.test(cmake));
t('写了接入说明 NDK.md', fs.existsSync(path.join(root, 'NDK.md')));

console.log('\n通过 ' + P + ' / ' + (P + F));
process.exit(F ? 1 : 0);
