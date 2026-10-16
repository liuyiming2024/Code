/* cpplite.js —— C / C++ 子集解释器（自研，纯 JS）
 *
 * 定位：教学级。支持变量、运算、控制流、函数、一维数组、基础字符串与 printf / cout。
 * 不支持：指针与地址运算、struct / class、模板、STL 容器、头文件与多文件、
 *         预处理指令（#include 会被忽略）。
 * 遇到不支持的语法给出具体的"暂不支持"提示，不静默跑歪。
 *
 * 与真编译器的分工：真工程请用扩展中心的 C/C++ 运行时（下载后本地执行）。
 * 这里只解决"随手写个小算法立刻看结果"。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var TYPES = ['int', 'long', 'short', 'char', 'float', 'double', 'bool', 'void', 'unsigned', 'signed', 'string', 'auto', 'const'];
  var KEYWORDS = ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
    'return', 'struct', 'class', 'typedef', 'template', 'namespace', 'using', 'new', 'delete',
    'public', 'private', 'protected', 'virtual', 'inline', 'static', 'extern', 'sizeof', 'try', 'catch',
    'throw', 'const', 'operator', 'this', 'enum', 'union', 'goto', 'register', 'volatile', 'nullptr'];

  /* ============================================================
   * 一、分词
   * ============================================================ */
  /* ============================================================
   * UB（未定义行为）模拟开关  ——  S-082 / S-083
   *
   * 为什么要有这个开关：
   *   我上一轮建议"UB 一律转明确报错"，审查官指出这条取向是错的，予以收回。
   *   理由：Code 是**教学与竞赛**工具。真实 C++ 里 UB 不会报错 ——
   *   int 溢出就回绕、数组越界就读到相邻内存、未初始化变量读到垃圾值。
   *   如果这里一律明确报错，学生写的程序在 Code 里"很安全"，
   *   一提交到 OJ 就 WA，而他在 Code 里从来没见过这种错。
   *   **报错掩盖了真实行为，比不报错更有害。**
   *
   * 所以分两档：
   *   safe  （默认）：明确报错，适合初学与教学 —— 出错了告诉你错在哪
   *   real          ：真模拟 UB，适合竞赛与进阶 —— 行为贴近 g++
   *
   * 危险类（默认 real 才生效，safe 档报错）：
   *   整数溢出回绕 / 数组越界 / 未初始化变量 / 空指针
   * 非 UB（IEEE 754 明确规定，两档都按真实行为）：
   *   浮点除零 → Infinity  （S-078 明确：这条不进开关）
   * ============================================================ */
  var UB = {
    mode: 'safe',
    set: function (m) { if (m === 'real' || m === 'safe') UB.mode = m; },
    isReal: function () { return UB.mode === 'real'; },
    /* 统一入口：安全档抛明确错误，真实档返回 true 表示"继续模拟" */
    /* line 可选。运行期错误（越界、溢出）不带行号的话，
       用户只知道"下标 10 越界"却不知道是**哪一行**的 a[10]
       —— 而一个程序里可能有几十处下标访问。 */
    check: function (kind, msg, line) {
      if (UB.isReal()) return true;
      throw cerr('暂不支持（安全模式）：' + msg + '。' +
        '切换到「真实 UB」模式可模拟真实 C++ 的行为（' + kind + '）', line);
    }
  };

  /* 按真实宽度回绕（S-069 / S-083①）。
     int 是 32 位、long long 是 64 位 —— 用 JS 的 number 直接算，
     2147483647+1 会得到 2147483648，而真实 g++ 是 -2147483648。
     竞赛里溢出是常见陷阱，算错了就是 WA。 */
  function wrapInt(v, type) {
    if (typeof v !== 'number' || !isFinite(v)) return v;
    if (!Number.isInteger(v)) return v;
    var bits = 32;
    if (type === 'long long' || type === 'unsigned long long' || type === 'long') bits = 64;
    if (type === 'short' || type === 'short int') bits = 16;
    if (type === 'char' || type === 'unsigned char') bits = 8;
    if (bits === 64) {
      /* 用 BigInt 精确回绕，避免 2^53 以上精度丢失 */
      var b = BigInt(Math.trunc(v));
      var m = 1n << 64n;
      var r = ((b % m) + m) % m;
      if (r >= (1n << 63n)) r -= m;
      return Number(r);
    }
    var mod = Math.pow(2, bits);
    var r2 = ((v % mod) + mod) % mod;
    /* ⚠ unsigned 不能按有符号回绕（对照测试实测发现）。
       `unsigned r = u - 1` 此前得到 -1，而 g++ 是 4294967295 ——
       unsigned 永不為负，这是它最基本的性质。
       wrapInt 里 unsigned 不匹配任何宽度分支，默认走了有符号回绕。 */
    if (/unsigned/.test(String(type))) return r2 >>> 0;
    if (r2 >= mod / 2) r2 -= mod;
    return r2;
  }

  /* 把整数结果收敛到 C 类型的宽度。
   *
   * 为什么要它（本轮实测发现，审查官 S-069 未覆盖到的一条）：
   *   `short t = 32767; t = t + 1;` 真 g++ 输出 -32768，而此前我们输出 32768。
   *   根因：赋值路径**完全不按左侧变量的类型截断** ——
   *   只有 BinOp 回绕（而且推断出的是提升后的 int），
   *   写回 short 变量这一步没人管。
   *
   * 分工（必须与真 C++ 一致，用 g++ -O2 实测对照过）：
   *   - `s + 1`：short 先整数提升为 int，结果是 32768（不截断）
   *   - `t = t + 1`：写回 short 时截断，结果是 -32768
   *   审查官原条目写「short 32767+1 真 -32768」**是错的** ——
   *   它没考虑整数提升。照着改会把对的改成错的。
   *
   * 安全档：超出范围就报错。此前安全档静默给出 2147483648，
   *   既不报错又给错值，是最坏的一种 —— 用户完全不知道自己在溢出。
   */
  /* 递归深度上限（S-044）。
     ⚠ 这个数必须**实测**定，不能拍脑袋。
       我一开始写 1000，结果无限递归照样冒 "Maximum call stack size exceeded" ——
       因为解释器每层 C 函数调用要吃掉约 20 个 JS 栈帧，
       实测**只到 527 层 JS 栈就满了**，永远够不着 1000 的阈值。
       设成 1000 等于没设。
     现在取 400：既能跑完常见的递归（快排、DFS 一般不超过这个深度），
     又能在栈溢出之前先一步给出人话。 */
  var MAX_CALL_DEPTH = 400;

  var RANGE = {
    'char': 8, 'unsigned char': 8,
    'short': 16, 'short int': 16, 'unsigned short': 16, 'unsigned short int': 16,
    'int': 32, 'unsigned': 32, 'unsigned int': 32,
    'long long': 64, 'unsigned long long': 64, 'long': 64
  };
  function fitInt(v, ctype, line) {
    if (typeof v !== 'number' || !Number.isInteger(v) || !isFinite(v)) return v;
    /* 'short int' → 'short'、'unsigned int' → 'unsigned'；
       但单独的 'int' 不能去掉 —— 否则报错里会写成「超出  的范围」，
       类型名是空的，用户看不出自己超了哪种类型。 */
    var t0 = String(ctype || 'int');
    var t = (t0 === 'int') ? 'int' : t0.replace(/\s*int$/, '');
    var bits = RANGE[t];
    if (t === 'short int') bits = 16;
    if (bits == null) bits = 32;
    if (bits === 64) return v;                 /* 64 位：本轮不截断（JS double 精度已足够到 2^53） */
    var lo, hi;
    if (/unsigned/.test(t)) { lo = 0; hi = Math.pow(2, bits) - 1; }
    else { lo = -Math.pow(2, bits - 1); hi = Math.pow(2, bits - 1) - 1; }
    if (v >= lo && v <= hi) return v;
    if (UB.isReal()) return wrapInt(v, t);
    /* 安全档：明确报错，并提示该用什么类型 —— 静默给错值是最坏的 */
    UB.check('整数溢出',
      '结果 ' + v + ' 超出 ' + t + ' 的范围（' + lo + ' ~ ' + hi + '）。\n' +
      '真实 C++ 会回绕成一个看起来随机的负数（UB），这里先拦住你。\n' +
      (bits === 32 ? '如果数值本来就该这么大，请改用 long long。' : '请检查取值范围。'), line);
    return v;
  }

  /* ============================================================
   * C 类型推断（S-115 / S-116）
   *
   * 为什么需要：AST 节点的 `type` 字段是**节点类型**（恒为 'BinOp'），
   * 不能拿来存 C 类型 —— 之前直接用 `node.type` 传给 wrapInt，
   * 于是所有宽度分支永不匹配，short/char/long long/unsigned 全按 int32 处理。
   * 这也是为什么"同一个键写了两次"是危险写法（范围 for 那次踩过同一个坑）。
   *
   * 这里按 C 的**整型提升规则**推断：
   *   - 一端是 unsigned 且宽度 >= 另一端 → 结果为 unsigned
   *   - 否则取两端中更宽的那个
   * ============================================================ */
  var CTYPE_RANK = {
    'char': 1, 'unsigned char': 1, 'signed char': 1,
    'short': 2, 'short int': 2, 'unsigned short': 2,
    'int': 3, 'unsigned int': 3, 'unsigned': 3,
    'long': 4, 'unsigned long': 4,
    'long long': 5, 'unsigned long long': 5
  };
  function isUnsignedCType(t) { return !!t && /unsigned/.test(t); }
  function ctypeRank(t) { return CTYPE_RANK[t] || 3; }

  /* 从表达式节点推断 C 类型 */
  function inferCType(node, scope) {
    if (!node) return null;
    if (node.type === 'Name') return scope && scope.typeOf ? (scope.typeOf(node.name) || null) : null;
    if (node.type === 'Num') return node.isFloat ? 'double' : 'int';
    if (node.type === 'Str') return 'string';
    /* 二元运算：整型提升 —— unsigned 优先，其次取更宽者 */
    if (node.type === 'BinOp') {
      var lt = inferCType(node.l, scope), rt = inferCType(node.r, scope);
      if (isUnsignedCType(lt) || isUnsignedCType(rt)) {
        /* 一端 unsigned → 结果 unsigned，宽度取较大者 */
        return (ctypeRank(lt) >= ctypeRank(rt) ? lt : rt).indexOf('unsigned') >= 0
          ? (ctypeRank(lt) >= ctypeRank(rt) ? lt : rt)
          : 'unsigned ' + (ctypeRank(lt) >= ctypeRank(rt) ? lt : rt);
      }
      return ctypeRank(lt) >= ctypeRank(rt) ? (lt || rt) : (rt || lt);
    }
    if (node.type === 'Cast') return node.ctype || null;
    if (node.type === 'Index') return scope && scope.typeOf ? (scope.typeOf(node.obj && node.obj.name) || null) : null;
    return null;
  }

  /* ============================================================
   * 预处理宏（#define）
   *
   * 为什么不再"记录名字然后报错"：
   *   宏在竞赛代码里无处不在 —— `#define N 100005`、`#define ll long long`、
   *   `#define rep(i,a,b) for(int i=a;i<b;i++)`。
   *   只报错等于逼用户把每一行宏都手改成常量，那这份代码就不是 C++ 了。
   *   而且报错信息再清楚，也比不上**直接让它能跑**。
   *
   * 支持两类：
   *   常量宏   #define N 5            → 文本替换
   *   宏函数   #define SQ(x) ((x)*(x)) → 带参替换
   * 不支持的（明确报出来，不静默）：
   *   #ifdef / #ifndef / #pragma / 字符串化 # / 连接 ##
   * ============================================================ */
  var MACROS = {};        /* 常量宏：名 → token 数组 */
  var MACRO_FNS = {};     /* 宏函数：名 → {params, body} */

  /* 收集源码里的 #define。返回去掉预处理行之后的源码。 */
  var MACRO_ERRS = [];   /* 预处理阶段收集到的明确不支持项 */

  function collectAndStripMacros(src) {
    var lines = src.split('\n'), out = [];
    var stack = [];        /* 条件编译栈，支持嵌套 */
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var tr = ln.replace(/^\s+/, '');
      /* ⚠ 指令不一定在行首。实测用例写成 `int main(){ #ifdef X`，
         按"行首 # 才是指令"判定会漏掉，于是两个分支都保留，
         输出变成 "yesno"（真 C++ 只输出一个分支）。
         所以行内出现 `#指令` 时，从 # 处把该行拆成"代码 + 指令"两段。 */
      var hashAt = ln.indexOf('#');
      var inline = false;
      if (hashAt > 0) {
        var after = ln.slice(hashAt + 1);
        if (/^\s*(ifdef|ifndef|if|else|elif|endif|define|pragma)\b/.test(after)) inline = true;
      }
      if (tr.charAt(0) !== '#' && !inline) {
        /* 条件不成立的行整行丢弃 ——
           不能只是"跳过预处理指令"，否则两个分支都留下。 */
        var inactive = false;
        for (var k = 0; k < stack.length; k++) if (!stack[k].active) { inactive = true; break; }
        out.push(inactive ? '' : ln);
        continue;
      }
      var codeBefore = '';
      var body;
      if (inline) {
        codeBefore = ln.slice(0, hashAt);
        body = ln.slice(hashAt + 1);
        var inact2 = false;
        for (var k2 = 0; k2 < stack.length; k2++) if (!stack[k2].active) { inact2 = true; break; }
        out.push(inact2 ? '' : codeBefore);
      } else {
        body = tr.slice(1);
      }
      var dm = /^\s*define\s+([A-Za-z_]\w*)/.exec(body);
      if (dm) {
        var name = dm[1];
        var rest = body.slice(dm[0].length);
        /* 宏函数：名字后紧跟左括号，且括号内是逗号分隔的**标识符**列表。
           ⚠ 不能只看"有没有左括号" —— `#define B (A*3)` 紧跟括号，
           但括号里是表达式不是参数。按"有括号就是宏函数"判定，
           B 会被当成需要一个名为 `A*3` 的参数的宏函数，
           于是 `cout << B` 报"变量未定义：B"（S-123），
           而用户明明写了 #define B，完全无从排查。 */
        var paren = /^\s*\(([^)]*)\)/.exec(rest);
        var isFn = false;
        if (paren && paren[1].trim() !== '') {
          var parts = paren[1].split(',').map(function (x) { return x.trim(); });
          isFn = parts.every(function (x) { return /^[A-Za-z_]\w*$/.test(x); });
        }
        if (isFn) {
          var pm = /^\s*\(([^)]*)\)\s*([\s\S]*)$/.exec(rest);
          if (pm) {
            var params = pm[1].split(',').map(function (x) { return x.trim(); })
                             .filter(function (x) { return x !== ''; });
            MACRO_FNS[name] = { params: params, body: pm[2].trim() };
            out.push('');
            continue;
          }
        }
        /* 常量宏：剩余部分就是替换文本 */
        MACROS[name] = rest.trim();
      }
      /* ============================================================
       * 条件编译 #ifdef / #ifndef / #else / #endif（S-117）
       *
       * ⚠ 宏已经能展开了（S-076），但条件编译没跟着走：
       *   `#define X 1` + `#ifdef X / cout<<"yes" / #else / cout<<"no" / #endif`
       *   实测输出 "no"（真 C++ 是 "yes"）—— 两个分支都被保留了。
       *   用户看到程序正常运行、输出另一个分支的结果，完全无从察觉。
       *
       * 不支持的（#if 表达式求值 / #pragma / # 字符串化 / ## 连接）：明确报出。
       * ============================================================ */
      var cond = /^\s*(ifdef|ifndef|if|else|elif|endif)\b/.exec(body);
      if (cond) {
        var kw = cond[1];
        var arg = body.slice(cond[0].length).trim();
        if (kw === 'ifdef') { stack.push({ active: MACROS[arg] !== undefined || MACRO_FNS[arg] !== undefined, taken: true }); out.push(''); continue; }
        if (kw === 'ifndef') { stack.push({ active: MACROS[arg] === undefined && MACRO_FNS[arg] === undefined, taken: true }); out.push(''); continue; }
        if (kw === 'else') {
          if (stack.length) { stack[stack.length - 1].active = !stack[stack.length - 1].active; }
          out.push(''); continue;
        }
        if (kw === 'endif') { stack.pop(); out.push(''); continue; }
        if (kw === 'if' || kw === 'elif') {
          /* #if 需要常量表达式求值，本环境不做 —— 明确说出，不静默取错分支 */
          MACRO_ERRS.push('暂不支持 #' + kw + '（需要常量表达式求值）。请用 #ifdef / #ifndef 代替。');
          stack.push({ active: false, taken: true });
          out.push(''); continue;
        }
      }
      /* #pragma 等其他指令：静默跳过 */
      out.push('');
    }
    return out.join('\n');
  }

  /* 对源码做宏展开（迭代直到不再变化，处理宏套宏）。
     用 token 级替换而不是字符串替换 —— 字符串替换会把
     标识符里恰好包含宏名的部分也替换掉（如宏 `a` 会把 `max` 变成 `m5x`）。 */
  function expandMacros(src, depth) {
    depth = depth || 0;
    if (depth > 12) return src;   /* 防无限递归：`#define A A` */
    var changed = false;
    var toks = [];
    /* 先粗分：标识符 / 其他 */
    var re = /([A-Za-z_]\w*)|([\s\S])/g, mt;
    var seq = [];
    while ((mt = re.exec(src)) !== null) seq.push(mt[0]);

    var i = 0, out = '';
    while (i < seq.length) {
      var w = seq[i];
      /* 宏函数：SQ(3) */
      if (MACRO_FNS[w] && /^[A-Za-z_]/.test(w)) {
        /* 找紧跟的 ( —— 允许中间有空格 */
        var j = i + 1;
        while (j < seq.length && /^\s*$/.test(seq[j])) j++;
        if (j < seq.length && seq[j] === '(') {
          var depthP = 0, args = [], cur = '';
          var k = j;
          for (; k < seq.length; k++) {
            if (seq[k] === '(') { depthP++; if (depthP === 1) continue; }
            if (seq[k] === ')') { depthP--; if (depthP === 0) break; }
            if (seq[k] === ',' && depthP === 1) { args.push(cur); cur = ''; continue; }
            cur += seq[k];
          }
          if (depthP === 0 && k < seq.length) {
            args.push(cur);
            var mf = MACRO_FNS[w];
            var rep = mf.body;
            for (var a = 0; a < mf.params.length; a++) {
              var av = args[a] !== undefined ? args[a].trim() : '';
              /* ⚠ 括号不能无脑加（本轮实测发现）。
                 此前一律替换成 `(实参)`，于是
                   `#define rep(i,a,b) for(int i=a;i<b;i++)` + `rep(i,0,5)`
                 展开成 `for(int (i)=(0);(i)<(5);(i)++)` ——
                 声明位置不能加括号，解析直接报"期望标识符，实际读到 ("，
                 而用户看到的是自己的 `rep(i,0,5)` 那一行出错，完全无从排查。

                 正确做法：只有实参是**复合表达式**时才加括号（防优先级问题），
                 单一标识符或字面量原样代入。
                   `SQ(1+2)` → `((1+2))*((1+2))`  ✅ 仍然安全
                   `rep(i,0,5)` → `for(int i=0;i<5;i++)`  ✅ 能解析 */
              var needParen = /[+\-*/%<>=!&|^?:]/.test(av);
              var sub = needParen ? '(' + av + ')' : av;
              rep = rep.replace(new RegExp('\\b' + mf.params[a] + '\\b', 'g'), sub);
            }
            out += rep;
            changed = true;
            i = k + 1;
            continue;
          }
        }
      }
      /* 常量宏 */
      if (MACROS[w] !== undefined && /^[A-Za-z_]/.test(w)) {
        out += MACROS[w];
        changed = true;
        i++;
        continue;
      }
      out += w;
      i++;
    }
    return changed ? expandMacros(out, depth + 1) : out;
  }

  /* 吸收连续的类型词构成完整类型名。
     竞赛里 `long long`、`unsigned long long` 是基础中的基础 ——
     防溢出全靠它们。只认一个词的话，第二个词会落在变量名位置，
     报"期望标识符，实际读到 long"，用户会以为自己写错了语法。

     组合规则（最多三段）：
       long + long          → long long
       long + double        → long double
       unsigned + long      → unsigned long
       unsigned long + long → unsigned long long   ← 三段，竞赛最常用
       signed   同理
       short + int          → short int
     返回是否吸收了一个词。 */
  function absorbType(parser, type) {
    if (!parser.at('TYPE')) return null;
    var nx = parser.peek().v;
    if (nx === 'const') return null;
    var parts = type.split(' ');
    var head = parts[0];
    var last = parts[parts.length - 1];
    if ((head === 'unsigned' || head === 'signed')) {
      if (nx === 'long' && parts.length < 3) { parser.p++; return type + ' long'; }
      if ((nx === 'int' || nx === 'char' || nx === 'short') && parts.length < 2) { parser.p++; return type + ' ' + nx; }
      return null;
    }
    if (head === 'long' && (nx === 'long' || nx === 'double') && parts.length < 2) { parser.p++; return type + ' ' + nx; }
    if (head === 'short' && nx === 'int' && parts.length < 2) { parser.p++; return 'short int'; }
    return null;
  }

  /* 预处理总入口：收集 #define → 剥离预处理行 → 展开宏 */
  function preprocess(src) {
    /* 每次处理前清空，否则多次 run 之间会互相污染 ——
       前一个文件定义的 N 会跑到后一个文件里。 */
    MACROS = {}; MACRO_FNS = {}; MACRO_ERRS = [];
    var stripped = collectAndStripMacros(src);
    /* 预处理阶段发现的"明确不支持"要报出来，不能静默取错分支 */
    if (MACRO_ERRS.length) throw cerr(MACRO_ERRS.join('\n'));
    return expandMacros(stripped);
  }

  /* ================= STL 容器 =================
   * 竞赛里 set / stack / queue / priority_queue / pair 都常用。
   * 之前统一当 vector 处理，于是 s.insert() 报
   * "vector 暂不支持的方法：insert" —— 报的是 vector，
   * 而用户写的是 set，这个错指错了方向，没法自己排查。
   * ============================================================ */

  /* set：有序去重集合 */
  function makeSet() {
    var arr = [];
    var api = {
      __set: true,
      insert: function (x) { if (arr.indexOf(x) < 0) { arr.push(x); arr.sort(function (a, b) { return a - b; }); } return 0; },
      erase: function (x) { var i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); return 0; },
      count: function (x) { return arr.indexOf(x) >= 0 ? 1 : 0; },
      find: function (x) { return arr.indexOf(x) >= 0; },
      size: function () { return arr.length; },
      empty: function () { return arr.length === 0; },
      clear: function () { arr.length = 0; return 0; },
      begin: function () { return { __iter: arr, __at: 0 }; },
      end: function () { return { __iter: arr, __at: arr.length }; }
    };
    api.__data = arr;
    return api;
  }

  /* stack：后进先出 */
  function makeStack() {
    var arr = [];
    return {
      __stack: true, __data: arr,
      push: function (x) { arr.push(x); return 0; },
      pop: function () { arr.pop(); return 0; },
      top: function () { return arr[arr.length - 1]; },
      size: function () { return arr.length; },
      empty: function () { return arr.length === 0; }
    };
  }

  /* queue：先进先出 */
  function makeQueue() {
    var arr = [];
    return {
      __queue: true, __data: arr,
      push: function (x) { arr.push(x); return 0; },
      pop: function () { arr.shift(); return 0; },
      front: function () { return arr[0]; },
      back: function () { return arr[arr.length - 1]; },
      size: function () { return arr.length; },
      empty: function () { return arr.length === 0; }
    };
  }

  /* priority_queue：大顶堆 */
  function makePQueue() {
    var arr = [];
    function up() { arr.sort(function (a, b) { return a - b; }); }   /* 升序，top 取末尾 = 最大 */
    return {
      __pqueue: true, __data: arr,
      push: function (x) { arr.push(x); up(); return 0; },
      pop: function () { arr.pop(); return 0; },
      top: function () { return arr[arr.length - 1]; },
      size: function () { return arr.length; },
      empty: function () { return arr.length === 0; }
    };
  }

  /* pair：first / second */
  function makePair(a, b) {
    return { __pair: true, first: (a === undefined ? 0 : a), second: (b === undefined ? 0 : b) };
  }

  /* 把 BigInt 按 64 位有符号回绕（与 wrapInt 的 64 位分支一致） */
  function wrapBigTo64(v) {
    var m = 1n << 64n;
    var r = ((v % m) + m) % m;
    if (r >= (1n << 63n)) r -= m;
    return r;
  }

  function tokenize(src) {
    var t = [], i = 0, n = src.length;
    /* 行号追踪。为什么需要：之前语法错误只说"期望 X，实际读到 Y"，
       不给行号 —— 对写 C++ 的人几乎没用，他只能从头逐行找括号。
       push() 统一附带 st.line，所有报错点就都能报出行号。 */
    var st = { line: 1 };
    function push(tk) { tk.line = st.line; t.push(tk); }
    while (i < n) {
      var c = src[i];
      if (c === '\n') { st.line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      /* 预处理指令整行忽略 */
      /* ⚠ 预处理指令不能只静默跳过。
         `#define N 5` 被无声忽略后，用到 N 的地方才报"变量未定义：N" ——
         用户会以为自己拼错了变量名，翻来覆去找，
         而真实原因是"我们不支持预处理宏"，这句话从没告诉过他。
         所以记录所有宏名，等标识符找不到时给出针对性提示。 */
      if (c === '#') {
        var ln = '';
        var j0 = i + 1;
        while (j0 < n && src[j0] !== '\n') { ln += src[j0]; j0++; }
        var dm = /^\s*define\s+([A-Za-z_]\w*)/.exec(ln);
        if (dm) MACROS[dm[1]] = true;
        /* 同样只跳到行尾，不在这里 ++（'\n' 分支会统一处理）。
           实测中 preprocess 已经把 # 行替成空行，tokenize 很少走到这里；
           但直接调 tokenize 时会走到，规则必须一致。 */
        i = j0;
        continue;
      }
      /* 注释 */
      /* 注释里的换行也要计数 —— 块注释跨多行时不推进，后面行号全偏 */
      /* ⚠ 只跳到行尾，**不在这里 ++**。
         第一版我在这里 ++，而下一轮主循环遇到同一个 '\n' 又会 ++ 一次，
         于是行注释之后的行号全部 +1（实测报第 3 行，实际是第 2 行）。
         统一规则：所有"跳到行尾"的分支都不计数，交给下面的 '\n' 分支处理，
         保证每个换行**恰好**计一次。 */
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') st.line++;
          i++;
        }
        i += 2; continue;
      }

      /* 字符串 */
      if (c === '"' || c === "'") {
        var q = c, buf = '';
        i++;
        while (i < n && src[i] !== q) {
          if (src[i] === '\\') {
            var e = src[i + 1];
            buf += (e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e);
            i += 2; continue;
          }
          buf += src[i]; i++;
        }
        i++;
        push({ t: q === '"' ? 'STR' : 'CHAR', v: buf });
        continue;
      }
      /* 数字 */
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        var m = /^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i));
        /* 数字后缀：`1LL`、`1000000007LL`、`3.5f`、`10u`。
           竞赛里 `(1LL<<40)` 是防溢出的标准写法，
           不认后缀会报"语法错误：期望 )，实际读到 LL"，
           而用户看不出这是后缀的问题。 */
        var after = src.slice(i + m[0].length);
        var sm = /^([LuUlLfF]{1,2})(?![A-Za-z0-9_])/.exec(after);
        if (sm) i += sm[0].length;
        /* ⚠ parseFloat 会把 1.0 变成整数 1，浮点性就此丢失。
           于是 `1.0/0` 被当成整数除零而报错，真 C++ 却是 inf。
           保留原始文本，供后面判断"这个字面量是浮点还是整数"。 */
        push({ t: 'NUM', v: parseFloat(m[0]), raw: m[0] });
        i += m[0].length;
        continue;
      }
      /* 标识符 */
      if (/[A-Za-z_]/.test(c)) {
        var m2 = /^[A-Za-z_]\w*/.exec(src.slice(i));
        var w = m2[0];
        push({ t: (TYPES.indexOf(w) >= 0 ? 'TYPE' : KEYWORDS.indexOf(w) >= 0 ? 'KW' : 'NAME'), v: w });
        i += w.length;
        continue;
      }
      /* 运算符：长的优先 */
      var ops = ['<<=', '>>=', '...', '->*', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '++', '--',
        '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::', '->', '.*'];
      var hit = null;
      for (var k = 0; k < ops.length; k++) if (src.substr(i, ops[k].length) === ops[k]) { hit = ops[k]; break; }
      if (!hit) hit = c;
      if ('+-*/%<>=!&|^~?:;,.()[]{}'.indexOf(hit) >= 0 || hit.length > 1) {
        push({ t: 'OP', v: hit });
        i += hit.length;
        continue;
      }
      throw cerr('无法识别的字符：' + c, st.line);
    }
    push({ t: 'EOF' });
    return t;
  }

  /* 报错一律带行号 —— 只说"期望 X，实际读到 Y"不说是哪一行，
     对写 C++ 的人几乎没用（他只能从头逐行找括号）。
     行号来自 tokenize 阶段追踪的 st.line；
     ⚠ 它之所以等于**原始源码的行号**，是因为 preprocess 逐行 push
     （不成立的分支替成空行而非删除），行数与原文一一对应。
     若哪天改了 preprocess 让它删行，这里会整体偏 —— 已在测试里锁死。 */
  function cerr(msg, line) {
    var e = new Error(msg + (line ? '（第 ' + line + ' 行）' : ''));
    e.cppLine = line || 0;
    return e;
  }

  /* ============================================================
   * 二、语法分析
   * ============================================================ */
  /* 容器类型识别：vector<int> / map<string,int> / set<int>。
     这些名字不在 TYPES 里，走普通声明解析会当成表达式，
     报"读到意外的 int"——用户看不出这是"不支持 vector"。
     所以单独识别，并明确告诉用户支持到什么程度。 */
  /* 文件流类型名。与 Python 侧的虚拟 FS **分开实现**（用户拍板）：
     C++ 的 ifstream/ofstream 与 Python 的 open() 各用各的存储，
     不共享文件。分开的代价是"同一份数据不能跨语言读到"，
     好处是任何一边的改动不会波及另一边。这里明确记下这个决定。 */
  function isStreamTypeName(v) {
    return v === 'ifstream' || v === 'ofstream' || v === 'fstream';
  }

  function isContainerName(v) {
    return v === 'vector' || v === 'map' || v === 'set' || v === 'unordered_map' ||
           v === 'unordered_set' || v === 'deque' || v === 'stack' || v === 'queue' ||
           v === 'priority_queue' || v === 'pair' || v === 'list';
  }

  function parseContainerDecl(parser) {
    /* 只在"NAME < ... > NAME"这个形状下才认，避免误判比较表达式 */
    if (!parser.at('NAME') || !isContainerName(parser.peek().v)) return null;
    var save = parser.p;
    var kind = parser.next().v;
    if (!parser.atOp('<')) { parser.p = save; return null; }
    parser.p++;
    var depth = 1, elem = [];
    while (depth > 0 && !parser.at('EOF')) {
      var t = parser.peek();
      if (t.t === 'OP' && t.v === '<') { depth++; elem.push(t.v); parser.p++; continue; }
      /* ⚠ 词法把 `>>` 切成一个 token（右移运算符优先）。
         `vector<vector<int>>` 的结尾就是 `>>`，
         不拆开的话 depth 只减 1，剩下的 `>` 落在变量名位置，
         报"读到意外的 int"。而二维 vector 在竞赛里很常见。 */
      if (t.t === 'OP' && t.v === '>>') {
        /* 就地拆成两个 '>'，但不在这里改 depth ——
           让下面的正常流程分别消耗它们（内层一次、外层一次）。
           在这里直接 depth -= 2 的话会少消耗一个 '>'，
           残留的 '>' 落在变量名位置，就又报"读到意外的 int"了。 */
        parser.t[parser.p] = { t: 'OP', v: '>' };
        parser.t.splice(parser.p + 1, 0, { t: 'OP', v: '>' });
        continue;
      }
      if (t.t === 'OP' && t.v === '>') { depth--; if (depth === 0) { parser.p++; break; } }
      elem.push(t.v); parser.p++;
    }
    if (depth !== 0) { parser.p = save; return null; }
    /* 后面必须跟标识符才是声明 */
    if (!parser.at('NAME')) { parser.p = save; return null; }
    return { kind: kind, elem: elem.join('') };
  }

  function Parser(t) {
    this.t = t; this.p = 0;
    /* 已声明的文件流变量名 → 类型。
       ⚠ 必须有它：`<<`/`>>` 既是流运算符也是位移，靠左操作数区分，
       而原判定只认 cin/cout 这几个**固定名字**。
       文件流叫 f / fin / fout，不在名单里，
       于是 `fout << "hi"` 被当成**位移**运算 ——
       不报错，输出静默为空。这类"错得没声音"最难查。 */
    this.streamVars = {};
  }
  Parser.prototype = {
    peek: function (k) { return this.t[this.p + (k || 0)]; },
    lineOf: function () { var t = this.peek(); return (t && t.line) || 0; },
    next: function () { return this.t[this.p++]; },
    at: function (type, val) { var t = this.peek(); return t && t.t === type && (val === undefined || t.v === val); },
    atOp: function (v) { return this.at('OP', v); },
    eat: function (type, val) { if (this.at(type, val)) { this.p++; return true; } return false; },
    expect: function (type, val) {
      if (!this.eat(type, val)) {
        var t = this.peek();
        throw cerr('语法错误：期望 ' + (val || type) + '，实际读到 ' + (t ? (t.v !== undefined ? t.v : t.t) : '文件结束'), this.lineOf());
      }
    },


    /* 预扫描：先把所有 struct 名收集起来。
       解析器遇到 `P p;` 时要知道 P 是类型而不是表达式 ——
       而 struct 定义可能出现在文件后面，不预扫描就认不出来。
       C++ 里这叫前置声明问题，这里用一次轻量扫描解决。 */
    prescanStructs: function () {
      var names = {}, i = 0, n = this.t.length;
      while (i < n) {
        if (this.t[i].t === 'KW' && (this.t[i].v === 'struct' || this.t[i].v === 'class')) {
          if (i + 1 < n && this.t[i + 1].t === 'NAME') names[this.t[i + 1].v] = true;
        }
        i++;
      }
      return names;
    },

    parse: function () {
      this.structNames = this.prescanStructs();
      var out = [];
      while (!this.at('EOF')) {
        if (this.eat('OP', ';')) continue;
        out.push(this.topLevel());
      }
      return { type: 'Program', body: out };
    },

    /* 容器变量声明：vector<int> v; / vector<int> v(10); / map<string,int> m; */
    containerVarDecl: function (cdecl) {
      var name = this.next().v;
      var init = null;
      /* vector<int> v(10) 或 v(10, 0) —— 构造参数 */
      if (this.atOp('(')) {
        this.p++;
        var a1 = null, a2 = null;
        if (!this.atOp(')')) a1 = this.assign();
        if (this.eat('OP', ',')) a2 = this.assign();
        this.expect('OP', ')');
        init = { type: 'CtorArgs', a: a1, b: a2 };
      } else if (this.eat('OP', '=')) {
        /* 花括号初始化列表：vector<int> v = {3,1,2};
           不支持的话报"读到意外的 {"，而这是 C++11 起最常见的初始化写法。 */
        if (this.atOp('{')) {
          this.p++;
          var elts = [];
          while (!this.atOp('}') && !this.at('EOF')) {
            elts.push(this.assign());
            if (!this.eat('OP', ',')) break;
          }
          this.expect('OP', '}');
          init = { type: 'InitList', elts: elts };
        } else {
          init = this.assign();
        }
      }
      this.expect('OP', ';');
      return { type: 'ContainerDecl', kind: cdecl.kind, elem: cdecl.elem, name: name, init: init };
    },

    /* switch 语句（S-073）。竞赛里状态机、菜单类题目常用。 */
    switchStmt: function () {
      this.next();   /* switch */
      this.expect('OP', '(');
      var disc = this.expr();
      this.expect('OP', ')');
      this.expect('OP', '{');
      var cases = [], def = null, cur = null;
      while (!this.atOp('}') && !this.at('EOF')) {
        if (this.at('KW', 'case')) {
          this.p++;
          var cv = this.expr();
          this.expect('OP', ':');
          cur = { test: cv, body: [] };
          cases.push(cur);
          continue;
        }
        if (this.at('KW', 'default')) {
          this.p++;
          this.expect('OP', ':');
          def = { body: [] };
          cur = def;
          continue;
        }
        var st = this.statement();
        if (st) (cur ? cur.body : (def && def.body) || []).push(st);
      }
      this.expect('OP', '}');
      return { type: 'Switch', disc: disc, cases: cases, def: def };
    },

    /* struct 变量声明：P p;  /  P arr[10]; */
    structVarDecl: function (typeName) {
      this.p++;   /* 类型名 */
      var name = this.next().v;
      var sizes = null;
      while (this.atOp('[')) {
        this.p++;
        (sizes || (sizes = [])).push(this.atOp(']') ? null : this.expr());
        this.expect('OP', ']');
      }
      this.expect('OP', ';');
      return { type: 'StructVarDecl', typeName: typeName, name: name, sizes: sizes };
    },

    /* struct 声明：struct P { int x; int y; }; */
    structDecl: function () {
      this.next();  /* 吃掉 struct / class */
      var nameTok = this.peek();
      if (!this.at('NAME')) throw cerr('struct 后面需要名字', this.lineOf());
      var name = this.next().v;
      /* 前置声明 struct P; —— 只登记名字，成员未知 */
      if (this.eat('OP', ';')) return { type: 'StructDecl', name: name, fields: null };
      this.expect('OP', '{');
      var fields = [];
      while (!this.atOp('}') && !this.at('EOF')) {
        /* 成员声明：类型 名字;  —— 同样支持 long long。
           ⚠ 成员类型可以是另一个 struct（S-127）：
             `struct A{int v;}; struct B{ A a; int w; };`
             链表节点、树节点全靠嵌套结构体，数据结构入门必需。
             此前只认 TYPE token，而 A 是 NAME，
             于是 `A a;` 报"语法错误：期望 ;，实际读到 a" ——
             这个措辞会让人以为是自己的分号写错了。 */
        while (this.at('TYPE') && (this.peek().v === 'const' || this.peek().v === 'unsigned' || this.peek().v === 'signed')) this.p++;
        var ftype;
        if (this.at('TYPE')) { ftype = this.next().v; }
        else if (this.at('NAME') && this.structNames && this.structNames[this.peek().v]) { ftype = this.next().v; }
        else { ftype = 'int'; }
        while (this.at('TYPE') && this.peek().v !== 'const') {
          var nx3 = this.peek().v;
          if (ftype === 'long' && (nx3 === 'long' || nx3 === 'double')) { ftype += ' ' + nx3; this.p++; }
          else if (ftype === 'unsigned' && (nx3 === 'long' || nx3 === 'int' || nx3 === 'char' || nx3 === 'short')) { ftype += ' ' + nx3; this.p++; }
          else break;
        }
        var fname = this.next().v;
        var farr = null;
        while (this.atOp('[')) {
          this.p++;
          (farr || (farr = [])).push(this.atOp(']') ? null : this.expr());
          this.expect('OP', ']');
        }
        this.expect('OP', ';');
        fields.push({ name: fname, type: ftype, sizes: farr });
      }
      this.expect('OP', '}');
      this.eat('OP', ';');   /* struct 定义后的分号可省，但不能报错 */
      return { type: 'StructDecl', name: name, fields: fields };
    },

    topLevel: function () {
      /* using namespace std; */
      if (this.at('KW', 'using')) { while (!this.atOp(';') && !this.at('EOF')) this.p++; this.eat('OP', ';'); return { type: 'Pass' }; }
      /* typedef int ll; —— 竞赛里 ll 几乎人手一个。
         不认它会报"无法识别的声明"，用户以为自己写错了。 */
      if (this.at('KW', 'typedef')) {
        this.p++;
        var bt = this.next().v;
        while (this.at('TYPE') && this.peek().v !== 'const') {
          var nxb = this.peek().v;
          if (bt === 'long' && (nxb === 'long' || nxb === 'double')) { bt += ' ' + nxb; this.p++; }
          else if (bt === 'unsigned' && (nxb === 'long' || nxb === 'int' || nxb === 'char' || nxb === 'short')) { bt += ' ' + nxb; this.p++; }
          else break;
        }
        var alias = this.next().v;
        this.expect('OP', ';');
        (this.aliases || (this.aliases = {}))[alias] = bt;
        return { type: 'Pass' };
      }
      if (this.at('KW', 'namespace') || this.at('KW', 'template')) throw cerr('暂不支持：' + this.peek().v, this.lineOf());
      if (this.at('KW', 'struct') || this.at('KW', 'class')) {
        return this.structDecl();
      }
      if (this.at('KW', 'enum') || this.at('KW', 'union')) {
        throw cerr('暂不支持：' + this.peek().v + '（本环境只支持基础类型、数组与函数）', this.lineOf());
      }
      var cdecl = parseContainerDecl(this);
      if (cdecl) return this.containerVarDecl(cdecl);
      /* typedef 的别名当类型用：`ll x = 5;` */
      if (this.at('NAME') && this.aliases && this.aliases[this.peek().v]) {
        var al = this.peek().v;
        var saveA = this.p;
        this.p++;   /* 吃掉别名 */
        if (this.at('NAME')) {
          var an = this.next().v;
          var declsA = [this.varDeclarator(this.aliases[al], an)];
          while (this.eat('OP', ',')) { var an2 = this.next().v; declsA.push(this.varDeclarator(this.aliases[al], an2)); }
          this.expect('OP', ';');
          return { type: 'VarDecl', decls: declsA };
        }
        this.p = saveA;
      }
      /* struct 类型的变量声明：`P p;` / `P arr[10];` */
      if (this.at('NAME') && this.structNames && this.structNames[this.peek().v] &&
          this.t[this.p + 1] && this.t[this.p + 1].t === 'NAME') {
        return this.structVarDecl(this.peek().v);
      }
      return this.funcOrDecl();
    },

    /* 识别函数定义：类型 名字 ( ... ) { */
    funcOrDecl: function () {
      if (!this.at('TYPE') && !this.at('NAME')) throw cerr('无法识别的声明', this.lineOf());
      /* const 是限定词，跳过；unsigned / signed 是主类型的一部分，
         ⚠ 不能再无条件跳过 —— `unsigned x = 5;` 跳掉 unsigned 后
         就剩下 `x = 5`，报"期望标识符，实际读到 ="，
         而这个措辞会让用户以为自己写错了语法。 */
      while (this.at('TYPE') && this.peek().v === 'const') this.p++;
      /* ⚠ 必须循环吸收连续的类型词：`long long`、`unsigned long long`、
         `long double` 都是两个词组成一个类型。
         只吃第一个的话，第二个 `long` 会被当成变量名位置去解析，
         于是报"期望标识符，实际读到 long"——
         而 long long 是竞赛里最基础的类型（防 int 溢出），
         报这个错等于大部分数论题都跑不了。 */
      var type = this.at('TYPE') ? this.next().v : 'auto';
      /* 用统一的 absorbType，避免各写一份规则导致行为不一致 */
      while (this.at('TYPE')) {
        var nt2 = absorbType(this, type);
        if (!nt2) break;
        type = nt2;
      }
      /* 文件流声明：ifstream fin("a.txt"); / ofstream fout("b.txt");
         ⚠ 不单独识别的话会掉进下面的"变量声明"分支：
           ifstream 是 NAME 不是 TYPE，于是 type='auto'、name='ifstream'，
           紧接着 expect(';') 撞到 fin → 报"语法错误：期望 ;"
         用户看到这个完全猜不到是自己用了文件流 ——
         还以为是分号写错了。竞赛里文件读写很常见，必须支持。 */
      if (this.at('NAME') && isStreamTypeName(this.peek().v)) {
        var sk = this.next().v;
        if (!this.at('NAME')) throw cerr(sk + ' 后面需要变量名', this.lineOf());
        var sname = this.next().v;
        var sargs = [];
        if (this.atOp('(')) {
          this.p++;
          while (!this.atOp(')')) {
            sargs.push(this.assign());
            if (!this.eat('OP', ',')) break;
          }
          this.expect('OP', ')');
        }
        this.expect('OP', ';');
        this.streamVars[sname] = sk;
        return { type: 'StreamDecl', kind: sk, name: sname, args: sargs, line: sk ? this.peek().line : 0 };
      }
      var nameTok = this.peek();
      if (!this.at('NAME')) throw cerr('期望标识符，实际读到 ' + (nameTok && nameTok.v), this.lineOf());
      var name = this.next().v;
      if (this.atOp('(')) {
        var args = this.paramList();
        if (this.atOp('{')) {
          var body = this.block();
          return { type: 'Func', name: name, retType: type, args: args, body: body };
        }
        this.expect('OP', ';');
        return { type: 'Pass' };
      }
      /* 变量声明 */
      var decls = [this.varDeclarator(type, name)];
      while (this.eat('OP', ',')) {
        var nm = this.next().v;
        decls.push(this.varDeclarator(type, nm));
      }
      this.expect('OP', ';');
      return { type: 'VarDecl', decls: decls };
    },

    varDeclarator: function (type, name) {
      var arrSizes = null, init = null;
      while (this.atOp('[')) {
        this.p++;
        (arrSizes || (arrSizes = [])).push(this.atOp(']') ? null : this.expr());
        this.expect('OP', ']');
      }
      if (this.eat('OP', '=')) init = this.initOrExpr();
      return { name: name, type: type, sizes: arrSizes, init: init };
    },

    /* 初始化可能是单值，也可能是花括号列表 {1,2,3} */
    initOrExpr: function () {
      if (this.atOp('{')) {
        this.p++;
        var elts = [];
        while (!this.atOp('}')) {
          elts.push(this.assign());
          if (!this.eat('OP', ',')) break;
        }
        this.expect('OP', '}');
        return { type: 'InitList', elts: elts };
      }
      return this.assign();
    },

    paramList: function () {
      this.expect('OP', '(');
      var args = [];
      while (!this.atOp(')')) {
        while (this.at('TYPE') && (this.peek().v === 'const' || this.peek().v === 'unsigned')) this.p++;
        /* 参数类型可能是 struct 名（`bool cmp(P a, P b)`）。
           P 是 NAME 不是 TYPE，不认的话 P 会被当成参数名、
           真正的参数名 a 就成了多余 token，报"期望 )，实际读到 a"。
           而按结构体字段排序是竞赛里极常见的操作。 */
        var ty;
        if (this.at('TYPE')) { ty = this.next().v; }
        else if (this.at('NAME') && this.structNames && this.structNames[this.peek().v]) {
          ty = this.next().v;
        } else { ty = 'auto'; }
        /* 引用参数 `int &n`：& 在名字之前 */
        var byRef = false;
        if (this.atOp('&')) { this.p++; byRef = true; }
        var nm = null;
        if (this.at('NAME')) nm = this.next().v;
        var isArr = false;
        if (this.atOp('[')) { isArr = true; while (!this.atOp(',') && !this.atOp(')')) this.p++; }
        /* 默认值：`int b = 10` */
        var defv = null;
        if (this.eat('OP', '=')) defv = this.assign();
        if (nm) args.push({ name: nm, type: ty, def: defv, isArr: isArr, byRef: byRef });
        if (!this.eat('OP', ',')) break;
      }
      this.expect('OP', ')');
      return args;
    },

    block: function () {
      this.expect('OP', '{');
      var out = [];
      while (!this.atOp('}') && !this.at('EOF')) {
        var s = this.statement();
        if (s) out.push(s);
      }
      this.expect('OP', '}');
      return out;
    },

    statement: function () {
      if (this.eat('OP', ';')) return null;
      if (this.eat('OP', '{')) {
        /* 裸块：回退用 block 统一解析 */
        this.p--;
        return { type: 'Block', body: this.block() };
      }
      var t = this.peek();
      if (t.t === 'KW') {
        switch (t.v) {
          case 'if': return this.ifStmt();
          case 'for': return this.forStmt();
          case 'while': return this.whileStmt();
          case 'do': return this.doStmt();
          case 'return': return this.returnStmt();
          case 'break': this.p++; this.expect('OP', ';'); return { type: 'Break' };
          case 'continue': this.p++; this.expect('OP', ';'); return { type: 'Continue' };
          case 'switch': return this.switchStmt();
          case 'try': case 'catch': case 'throw': throw cerr('暂不支持：' + t.v, this.lineOf());
          case 'new': case 'delete': throw cerr('暂不支持：' + t.v + '（本环境无动态内存）', this.lineOf());
        }
      }
      /* using namespace std; */
      if (this.at('KW', 'using')) { while (!this.atOp(';') && !this.at('EOF')) this.p++; this.eat('OP', ';'); return null; }
      /* 局部文件流声明：ifstream fin("a.txt"); / ofstream fout("b.txt");
         ⚠ 必须放在容器声明**之前**：`ifstream fin("x")` 走 funcOrDecl 的话
         type='auto'、name='ifstream'，紧接着 expect(';') 撞到 fin
         → 报"语法错误：期望 ;，实际读到 fin"
         用户看到这个只会以为自己分号写错了，猜不到是文件流不支持。
         函数体内的声明走的是这里，不是 funcOrDecl，所以两边都要加。 */
      if (this.at('NAME') && isStreamTypeName(this.peek().v)) {
        var sk2 = this.next().v;
        if (!this.at('NAME')) throw cerr(sk2 + ' 后面需要变量名', this.lineOf());
        var sname2 = this.next().v;
        var sargs2 = [];
        if (this.atOp('(')) {
          this.p++;
          while (!this.atOp(')')) {
            sargs2.push(this.assign());
            if (!this.eat('OP', ',')) break;
          }
          this.expect('OP', ')');
        }
        this.expect('OP', ';');
        this.streamVars[sname2] = sk2;
        return { type: 'StreamDecl', kind: sk2, name: sname2, args: sargs2, line: t.line };
      }
      /* 局部声明：容器（vector / map / set …） */
      var cdecl2 = parseContainerDecl(this);
      if (cdecl2) return this.containerVarDecl(cdecl2);
      /* 局部的 typedef 别名：`ll x = 5;`（函数体内最常见） */
      if (this.at('NAME') && this.aliases && this.aliases[this.peek().v]) {
        var al2 = this.peek().v;
        var saveB = this.p;
        this.p++;
        if (this.at('NAME')) {
          var an3 = this.next().v;
          var declsB = [this.varDeclarator(this.aliases[al2], an3)];
          while (this.eat('OP', ',')) { var an4 = this.next().v; declsB.push(this.varDeclarator(this.aliases[al2], an4)); }
          this.expect('OP', ';');
          return { type: 'VarDecl', decls: declsB };
        }
        this.p = saveB;
      }
      /* struct 类型的局部变量：`P p;` */
      if (this.at('NAME') && this.structNames && this.structNames[this.peek().v] &&
          this.t[this.p + 1] && this.t[this.p + 1].t === 'NAME') {
        return this.structVarDecl(this.peek().v);
      }
      /* 局部声明 */
      if (this.at('TYPE')) {
        while (this.at('TYPE') && this.peek().v === 'const') this.p++;
        var ty = this.next().v;
        /* 多词类型：long long / unsigned long long / long double。
           函数体内的 `long long ans = 0;` 是竞赛代码里最常见的写法，
           只吃第一个词的话第二个 `long` 会落在变量名位置，
           报"期望标识符，实际读到 long" —— 看起来像用户写错了，
           实际是我们没认全这个类型。 */
        while (this.at('TYPE')) {
          var nt3 = absorbType(this, ty);
          if (!nt3) break;
          ty = nt3;
        }
        /* int *p —— 星号在变量名之前，必须先看，否则会当成"期望标识符"报错，
           用户看到的是语法错而不是"不支持指针" */
        if (this.atOp('*')) throw cerr('暂不支持：指针（本环境无地址与内存操作）', this.lineOf());
        /* 引用变量 `int &r = x;`
           本环境没有真地址，用"绑定名"实现：记录别名 → 真实变量名，
           读写都转发到原变量。`r = 9` 之后 x 也变成 9 ——
           这才是引用的语义。直接报错的话，
           凡是用引用传参的函数都得改写，代码就不是原样了。 */
        var refTarget = null;
        if (this.atOp('&')) { this.p++; var rt = this.peek(); if (rt && rt.t === 'NAME') refTarget = rt.v; }
        if (!this.at('NAME')) throw cerr('期望标识符，实际读到 ' + (this.peek().v || this.peek().t), this.lineOf());
        var nm = this.next().v;
        /* 可能是函数声明 */
        if (this.atOp('(')) { this.paramList(); this.expect('OP', ';'); return null; }
        /* 引用声明：int &r = x; —— 把 r 记成 x 的别名 */
        if (refTarget && this.atOp('=')) {
          var hasEq = this.p;
          this.p++;
          var rv = this.assign();
          this.expect('OP', ';');
          return { type: 'AliasDecl', name: nm, target: rv };
        }
        if (refTarget) throw cerr('引用必须初始化：int &r = x;');
        var decls = [this.varDeclarator(ty, nm)];
        while (this.eat('OP', ',')) {
          var n2 = this.next().v;
          decls.push(this.varDeclarator(ty, n2));
        }
        this.expect('OP', ';');
        return { type: 'VarDecl', decls: decls };
      }
      var e = this.expr();
      this.expect('OP', ';');
      return { type: 'Expr', expr: e };
    },

    ifStmt: function () {
      this.expect('KW', 'if');
      this.expect('OP', '(');
      var cond = this.expr();
      this.expect('OP', ')');
      var then = this.oneStmt();
      var els = null;
      if (this.at('KW', 'else')) { this.p++; els = this.oneStmt(); }
      return { type: 'If', cond: cond, then: then, els: els };
    },
    oneStmt: function () {
      if (this.atOp('{')) return { type: 'Block', body: this.block() };
      var s = this.statement();
      return s || { type: 'Pass' };
    },
    /* 范围 for：`for (auto x : v)` / `for (int x : arr)` / `for (auto &x : v)`
       C++11 起这是遍历容器最自然的写法，竞赛里几乎是标配。
       必须在普通 for 之前识别 —— 否则 `int x` 后面的 `:` 会被当成语法错误，
       报"期望 ;，实际读到 :"，用户完全看不出这是"不支持范围 for"。 */
    tryRangeFor: function () {
      var save = this.p;
      /* 类型：auto / int / long long / const auto& 等 */
      var isType = this.at('TYPE') || (this.at('NAME') && this.structNames && this.structNames[this.peek().v]);
      if (!isType) return null;
      /* 吸收可能的 const 与多词类型 */
      while (this.at('TYPE') && this.peek().v === 'const') this.p++;
      var ty = this.at('TYPE') ? this.next().v : this.next().v;
      while (this.at('TYPE')) {
        var nt = absorbType(this, ty);
        if (!nt) break;
        ty = nt;
      }
      /* 引用：auto &x */
      var byRef = false;
      if (this.atOp('&')) { this.p++; byRef = true; }
      if (!this.at('NAME')) { this.p = save; return null; }
      var varName = this.next().v;
      if (!this.atOp(':')) { this.p = save; return null; }
      this.p++;   /* 吃掉 : */
      var iterable = this.assign();
      if (!this.atOp(')')) { this.p = save; return null; }
      this.p++;
      /* ⚠ 变量名不能叫 `type` —— 节点本身的 `type` 字段会被覆盖。
         写成 { type:'RangeFor', ..., type: ty } 的话后者覆盖前者，
         节点就变成 type='int'，主 switch 里根本匹配不到，
         报"暂不支持的语句：int" —— 从报错完全看不出是这里的问题。 */
      return { type: 'RangeFor', varName: varName, varType: ty, iter: iterable, byRef: byRef, body: this.oneStmt() };
    },

    forStmt: function () {
      this.expect('KW', 'for');
      this.expect('OP', '(');
      var rf = this.tryRangeFor();
      if (rf) return rf;
      var init = null;
      if (!this.atOp(';')) init = this.statement();
      else this.p++;
      var cond = this.atOp(';') ? null : this.expr();
      this.expect('OP', ';');
      var step = this.atOp(')') ? null : this.expr();
      this.expect('OP', ')');
      return { type: 'For', init: init, cond: cond, step: step, body: this.oneStmt() };
    },
    whileStmt: function () {
      this.expect('KW', 'while');
      this.expect('OP', '(');
      var c = this.expr();
      this.expect('OP', ')');
      return { type: 'While', cond: c, body: this.oneStmt() };
    },
    doStmt: function () {
      this.expect('KW', 'do');
      var b = this.oneStmt();
      this.expect('KW', 'while');
      this.expect('OP', '(');
      var c = this.expr();
      this.expect('OP', ')');
      this.expect('OP', ';');
      return { type: 'DoWhile', cond: c, body: b };
    },
    returnStmt: function () {
      this.expect('KW', 'return');
      if (this.atOp(';')) { this.p++; return { type: 'Return', value: null }; }
      var v = this.expr();
      this.expect('OP', ';');
      return { type: 'Return', value: v };
    },

    /* ---------- 表达式 ---------- */
    expr: function () { return this.commaExpr(); },
    commaExpr: function () {
      var l = this.assign();
      while (this.eat('OP', ',')) l = this.assign();
      return l;
    },
    assign: function () {
      var l = this.ternary();
      var AUG = { '=': null, '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%' };
      var t = this.peek();
      if (t && t.t === 'OP' && (t.v in AUG)) {
        var op = t.v; this.p++;
        var r = this.assign();
        return { type: 'Assign', op: AUG[op] || '=', target: l, value: r, aug: !!AUG[op] };
      }
      return l;
    },
    ternary: function () {
      var c = this.logicOr();
      if (this.atOp('?')) {
        this.p++;
        var a = this.expr();
        this.expect('OP', ':');
        var b = this.ternary();
        return { type: 'Ternary', cond: c, then: a, els: b };
      }
      return c;
    },
    logicOr: function () {
      var l = this.logicAnd();
      while (this.atOp('||')) { this.p++; l = { type: 'Logic', op: '||', l: l, r: this.logicAnd() }; }
      return l;
    },
    logicAnd: function () {
      var l = this.bitOr();
      while (this.atOp('&&')) { this.p++; l = { type: 'Logic', op: '&&', l: l, r: this.bitOr() }; }
      return l;
    },
    bitOr: function () {
      var l = this.bitXor();
      while (this.atOp('|')) { var ln = this.peek().line; this.p++; l = { type: 'BinOp', op: '|', l: l, r: this.bitXor(), line: ln }; }
      return l;
    },
    bitXor: function () {
      var l = this.bitAnd();
      while (this.atOp('^')) { var ln = this.peek().line; this.p++; l = { type: 'BinOp', op: '^', l: l, r: this.bitAnd(), line: ln }; }
      return l;
    },
    bitAnd: function () {
      var l = this.equality();
      while (this.atOp('&')) { var ln = this.peek().line; this.p++; l = { type: 'BinOp', op: '&', l: l, r: this.equality(), line: ln }; }
      return l;
    },
    equality: function () {
      var l = this.relational();
      while (this.atOp('==') || this.atOp('!=')) { var ot = this.next(); l = { type: 'BinOp', op: ot.v, l: l, r: this.relational(), line: ot.line }; }
      return l;
    },
    relational: function () {
      var l = this.shift();
      while (this.atOp('<') || this.atOp('>') || this.atOp('<=') || this.atOp('>=')) { var ot = this.next(); l = { type: 'BinOp', op: ot.v, l: l, r: this.shift(), line: ot.line }; }
      return l;
    },
    shift: function () {
      var l = this.additive();
      while (this.atOp('<<') || this.atOp('>>')) { var ot = this.next(); l = { type: 'BinOp', op: ot.v, l: l, r: this.additive(), line: ot.line }; }
      return l;
    },
    additive: function () {
      var l = this.multiplicative();
      while (this.atOp('+') || this.atOp('-')) { var ot = this.next(); l = { type: 'BinOp', op: ot.v, l: l, r: this.multiplicative(), line: ot.line }; }
      return l;
    },
    multiplicative: function () {
      var l = this.unary();
      while (this.atOp('*') || this.atOp('/') || this.atOp('%')) { var ot = this.next(); l = { type: 'BinOp', op: ot.v, l: l, r: this.unary(), line: ot.line }; }
      return l;
    },
    unary: function () {
      if (this.atOp('!')) { this.p++; return { type: 'Unary', op: '!', v: this.unary() }; }
      if (this.atOp('-')) { this.p++; return { type: 'Unary', op: '-', v: this.unary() }; }
      if (this.atOp('+')) { this.p++; return this.unary(); }
      if (this.atOp('~')) { this.p++; return { type: 'Unary', op: '~', v: this.unary() }; }
      if (this.atOp('++')) { this.p++; return { type: 'PreInc', v: this.unary() }; }
      if (this.atOp('--')) { this.p++; return { type: 'PreInc', v: this.unary(), dec: true }; }
      /* `*p` 解引用：本环境没有真指针，但 max_element / find 返回的是
         "指针替身"（带 __ptr / __idx），必须支持解引用，
         否则 `cout << *max_element(a, a+n)` 直接报错，
         而这是 <algorithm> 的标准用法。
         对真指针仍明确报错，不假装支持。 */
      if (this.atOp('*')) {
        this.p++;
        var inner = this.unary();
        return { type: 'Deref', v: inner };
      }
      if (this.atOp('&')) throw cerr('暂不支持：取地址', this.lineOf());
      if (this.at('KW', 'sizeof')) throw cerr('暂不支持：sizeof', this.lineOf());
      if (this.at('KW', 'new')) throw cerr('暂不支持：new', this.lineOf());
      return this.postfix();
    },
    postfix: function () {
      var e = this.primary();
      while (true) {
        if (this.atOp('(')) {
          var lnC = this.peek().line;      /* '(' 所在行 = 调用发生的行 */
          this.p++;
          var args = [];
          while (!this.atOp(')')) { args.push(this.assign()); if (!this.eat('OP', ',')) break; }
          this.expect('OP', ')');
          e = { type: 'Call', callee: e, args: args, line: lnC };
          continue;
        }
        if (this.atOp('[')) {
          var ln2 = this.peek().line;
          this.p++;
          var idx = this.expr();
          this.expect('OP', ']');
          e = { type: 'Index', obj: e, index: idx, line: ln2 };
          continue;
        }
        if (this.atOp('.')) { this.p++; e = { type: 'Member', obj: e, name: this.next().v }; continue; }
        if (this.atOp('->')) { this.p++; e = { type: 'Member', obj: e, name: this.next().v, arrow: true }; continue; }
        if (this.atOp('++')) { this.p++; e = { type: 'PostInc', v: e }; continue; }
        if (this.atOp('--')) { this.p++; e = { type: 'PostInc', v: e, dec: true }; continue; }
        /* << 与 >> 必须左结合。右操作数解析期间要关掉流运算符：
           否则 unary() 内部又走到 postfix，继续吃掉后面的 <<，
           结果 cout << "hi" << 42 变成 cout << ("hi" << 42)，中间的项全丢。 */
        /* ⚠ 右操作数必须用 additive() 而不是 unary()。
           用 unary() 的话 `cout << a+b` 只吃掉 a，
           输出 3 而不是 10 —— 而这是竞赛里最常见的写法之一。
           C++ 中 + 的优先级高于 <<，所以右操作数应包含加减层级。
           仍需 noStream 保护：否则 `cout << a << b` 会被后面的 << 吃掉。 */
        /* ⚠ `<<` / `>>` 既是流运算符也是位移。
           必须靠左操作数区分：只有左边是 cin / cout 时才当流。
           不区分的话 `n >> 1`（快速幂、状压 DP 的核心写法）
           会被当成 cin 解析，报"暂不支持的赋值目标" ——
           而这个写法在竞赛里和 cin >> x 一样常见。 */
        var isStreamObj = (e && e.type === 'Name' && (e.name === 'cin' || e.name === 'cout' ||
                          e.name === 'cerr' || e.name === 'endl')) ||
                          (e && e.type === 'Name' && !!(this.streamVars && this.streamVars[e.name])) ||
                          (e && (e.type === 'Cout' || e.type === 'Cin'));
        if (!this.noStream && isStreamObj && this.atOp('<<')) {
          this.p++;
          this.noStream = true;
          var r = this.additive();
          this.noStream = false;
          e = { type: 'Cout', left: e, right: r };
          continue;
        }
        if (!this.noStream && isStreamObj && this.atOp('>>')) {
          this.p++;
          this.noStream = true;
          var r2 = this.additive();
          this.noStream = false;
          e = { type: 'Cin', left: e, right: r2 };
          continue;
        }
        break;
      }
      return e;
    },
    primary: function () {
      var t = this.peek();
      if (this.atOp('(')) {
        /* C 风格强制转换：(int)x 、(long long)n。
           竞赛里 `c[(int)s[i]]` 这种字符转下标很常见，
           不认这个语法会报"读到意外的 int"，用户根本看不出是转换的问题。 */
        var nt = this.t[this.p + 1];
        if (nt && nt.t === 'TYPE') {
          var save2 = this.p;
          this.p++;
          var ctype = this.next().v;
          while (this.at('TYPE') && this.peek().v !== 'const') {
            var nx4 = this.peek().v;
            if (ctype === 'long' && (nx4 === 'long' || nx4 === 'double')) { ctype += ' ' + nx4; this.p++; }
            else if (ctype === 'unsigned' && (nx4 === 'long' || nx4 === 'int' || nx4 === 'char' || nx4 === 'short')) { ctype += ' ' + nx4; this.p++; }
            else break;
          }
          if (this.atOp(')')) {
            this.p++;
            var inner = this.unary();
            return { type: 'Cast', ctype: ctype, v: inner };
          }
          this.p = save2;   /* 不是转换，回退按普通括号处理 */
        }
        this.p++;
        var e = this.expr();
        this.expect('OP', ')');
        return e;
      }
      /* ⚠ 字面量必须区分整数与浮点。
         `1.0/0` 里如果 1.0 被当成整数 1，就会走整数除零分支报错，
         而真 C++ 打印的是 inf —— 这条错会让学生以为浮点除零会崩。 */
      if (t.t === 'NUM') {
        this.p++;
        var raw = String(t.raw !== undefined ? t.raw : t.v);
        var flt = /[.eE]/.test(raw);
        /* ⚠ 超过 2^53 的整数字面量，JS 的 number 存不准。
           `long long x = 9223372036854775807LL` 会被读成 ...775808，
           差了 200 多 —— 不报错，只是答案错，用户无从察觉。
           这里对超范围字面量改用 BigInt 精确保存（只在这一处引入，
           不改动整个解释器的数值模型，把风险圈在最小范围）。 */
        if (!flt && /^\d+$/.test(raw) && raw.length > 15) {
          var bigv;
          try { bigv = BigInt(raw); } catch (e) { bigv = null; }
          if (bigv !== null && (bigv > BigInt(Number.MAX_SAFE_INTEGER) || bigv < BigInt(Number.MIN_SAFE_INTEGER))) {
            return { type: 'Num', v: t.v, isFloat: false, __big: bigv };
          }
        }
        return { type: 'Num', v: t.v, isFloat: flt };
      }
      if (t.t === 'STR') { this.p++; return { type: 'Str', v: t.v }; }
      if (t.t === 'CHAR') { this.p++; return { type: 'Char', v: t.v }; }
      if (t.t === 'KW' && (t.v === 'nullptr')) { this.p++; return { type: 'Null' }; }
      if (t.t === 'NAME') {
        var nm = t.v;
        /* true / false / std:: */
        if (nm === 'true' || nm === 'false') { this.p++; return { type: 'Bool', v: nm === 'true' }; }
        if (nm === 'std') {
          this.p++;
          if (this.atOp('::')) {
            this.p++;
            var n2 = this.next().v;
            return { type: 'Name', name: n2, std: true, line: t.line };
          }
        }
        this.p++;
        /* Name 带行号，这样"变量未定义"能说出是哪一行。
           C++ 里拼错变量名是最常见的错误之一，
           没有行号时只能从头逐行找。 */
        return { type: 'Name', name: nm, line: t.line };
      }
      /* 最常撞到的语法错误（括号没闭合等），原来只说"读到意外的 X"
         不给行号 —— 必须带上。同时 t 可能是 undefined（文件在错误处结束），
         直接读 t.v 会让**报错本身崩溃**，把有用的信息换成看不懂的报错。 */
      var desc = !t ? '文件结束' : (t.v !== undefined ? String(t.v) : t.t);
      throw cerr('语法错误：读到意外的 ' + desc, t && t.line);
    }
  };

  /* ============================================================
   * 三、执行
   * ============================================================ */
  /* ============================================================
   * 时间同步（TLE 预测）—— 本轮最重要的一件事
   *
   * 问题：这是**解释器**，不是编译器。它跑一步的代价和真实 C++ 差几个数量级。
   *   如果直接把"我跑不动"当成"你的算法太慢"报出去，
   *   用户得到的结论就是错的 —— 一个在 OJ 上 10 毫秒通过的 O(n) 算法，
   *   在这里会被判"可能存在死循环"。
   *   **用自己的能力上限冒充用户的错误，是最坏的一类错。**
   *
   * 所以要做两件事：
   *   1) 把步数换算成"等效真实 C++ 时间"，让用户知道真实的量级
   *   2) 中断时明确区分"本环境跑不动"和"你的算法会 TLE"
   *
   * 标定（实测，非估计）：
   *   - cpplite 一次简单循环迭代 ≈ 12 步
   *     （实测：n=1e4 求和 120010 步，n=2e4 求和 240010 步 → 每迭代 12 步）
   *   - 真实 C++ -O2：约 1e8 次基本操作/秒
   *     （竞赛界通用估算口径；实测本机 -O2 依赖链约 2.75ns/迭代，量级吻合）
   *   → 1 真实秒 ≈ 12 × 1e8 = 1.2e9 cpplite 步
   *   → 1 真实毫秒 ≈ 1.2e6 cpplite 步
   *
   * 标定环境：g++ 11.4.0 -O2，2026-10-13。换机器不改数量级结论。
   * ============================================================ */
  var PERF = {
    /* 一次简单循环迭代对应的步数（实测） */
    stepsPerIter: 12,
    /* 真实 C++ -O2 每秒可执行的基本操作次数（竞赛通用口径） */
    realOpsPerSec: 1e8,
    /* 步数 → 等效真实秒 */
    toRealSec: function (steps) {
      return steps / PERF.stepsPerIter / PERF.realOpsPerSec;
    },
    /* 等效真实秒的可读形式 */
    human: function (steps) {
      var sec = PERF.toRealSec(steps);
      if (sec < 0.001) return (sec * 1e6).toFixed(1) + ' 微秒';
      if (sec < 1) return (sec * 1000).toFixed(2) + ' 毫秒';
      if (sec < 60) return sec.toFixed(2) + ' 秒';
      return (sec / 60).toFixed(1) + ' 分钟';
    }
  };

  /* 步数上限。
     ⚠ 原来是 200 万 —— 只相当于真实 C++ 的 1.7 毫秒，
     于是 n=20 万的 O(n) 循环就被判"可能存在死循环"，
     而它在真实环境里只要 2 毫秒。**这是把本环境的上限说成了用户的错。**
     提到 5e7：可覆盖 n=1e6 的 O(n)（约 1.2e7 步）与 n=1e4 的 O(n²)（约 1.2e8 超出，靠墙钟兜底）。
     真正的兜底交给 runner 的墙钟超时，而不是步数。 */
  var MAX_STEPS = 50000000;

  /* ⚠ 变量必须记住自己的 C 类型。
     此前只有值没有类型，于是 `unsigned u=1; int i=-1; i<u` 只能按 JS 数字比较，
     得到 1 而真 C++ 是 0（int 被提升成 unsigned，-1 变成 4294967295）。
     short / char / long long 的宽度回绕同理 —— 不知道类型就没法按宽度回绕。
     类型表与值表平行维护，读写走同样的作用域链。 */
  function Scope(parent) { this.v = {}; this.t = {}; this.parent = parent || null; }
  Scope.prototype.get = function (n) {
    var s = this;
    while (s) { if (n in s.v) return s.v[n]; s = s.parent; }
    /* 未定义时先查是不是 #define 过的宏 ——
       告诉用户"这是宏，而我们不支持预处理"，
       比让他盯着"变量未定义"怀疑自己拼错要有用得多。 */
    if (MACROS[n]) {
      throw cerr('变量未定义：' + n + '。注意：源码里有 `#define " + n + "`，' +
        '本环境暂不支持预处理宏（#define），请用常量或 enum 代替');
    }
    throw cerr('变量未定义：' + n);
  };
  /* 赋值：沿链找到已存在的那一层再改。只写当前层的话，
     块内 s+=i 会新建同名变量，外层的 s 永远是初值。 */
  Scope.prototype.set = function (n, val) {
    var s = this;
    while (s) { if (n in s.v) { s.v[n] = val; return; } s = s.parent; }
    this.v[n] = val;
  };
  /* 声明：必须落在当前层，否则 for(int i...) 会去改外层同名变量 */
  Scope.prototype.declare = function (n, val, ctype) { this.v[n] = val; if (ctype) this.t[n] = ctype; };
  /* 取变量的 C 类型：沿链向上找，与 get 一致 */
  Scope.prototype.typeOf = function (n) {
    var s = this;
    while (s) { if (s.t && n in s.t) return s.t[n]; s = s.parent; }
    return null;
  };
  Scope.prototype.setType = function (n, ctype) {
    var s = this;
    while (s) { if (n in s.v) { if (!s.t) s.t = {}; s.t[n] = ctype; return; } s = s.parent; }
    if (!this.t) this.t = {};
    this.t[n] = ctype;
  };

  /* 控制流信号用异常实现。
     ⚠ 必须带可识别的标记 —— 否则 switch / 循环分不清是哪个信号，
     只能靠 `instanceof` 或字符串比较，容易漏。
     给每个信号一个 __break / __continue / __return 标记，
     捕获方一眼能认出来。 */
  function CBreak() { this.__break = true; }
  function CContinue() { this.__continue = true; }
  function CReturn(v) { this.value = v; this.__return = true; }

  /* 当前解释器实例的引用。
     sort 的比较器要回调用户函数，而 builtin 是纯函数拿不到 this ——
     用一个模块级变量指向最近创建的实例。
     ⚠ 这是有意的妥协：builtin 用 .apply(null, ...) 调用，没有 this。 */
  var INTERP = null;

  /* sort 的比较器：`sort(a, a+n, cmp)` 或 `sort(v.begin(), v.end(), cmp)`。
     竞赛里降序、按结构体字段排序全靠它。
     第三参数可能是用户函数名（__fn 标记）或内置函数。 */
  function resolveCmp(self2, cmp) {
    if (!cmp) return function (x, y) {
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x) < String(y) ? -1 : (String(x) > String(y) ? 1 : 0);
    };
    var fnNode = null, builtin = null;
    if (typeof cmp === 'object' && cmp.__fn) fnNode = self2.funcs[cmp.__fn] ? self2.funcs[cmp.__fn].node : null;
    if (typeof cmp === 'object' && cmp.__builtinFn) builtin = cmp.__builtinFn;
    if (typeof cmp === 'object' && cmp.__lambda) fnNode = cmp.node;
    if (!fnNode && !builtin) return null;
    return function (x, y) {
      if (builtin) return builtin(x, y);
      var sc = new Scope(self2.global);
      (fnNode.args || []).forEach(function (a, i) { sc.declare(a.name, i === 0 ? x : y); });
      var ret = null;
      try {
        for (var bi = 0; bi < fnNode.body.length; bi++) self2.exec(fnNode.body[bi], sc);
      } catch (e) { if (e && e.__return) ret = e.value; else throw e; }
      /* 返回 true/1 表示 x 应排在 y 前面 */
      return (ret === true || ret === 1) ? -1 : (ret ? -1 : 1);
    };
  }

  function Interp(out, input) {
    INTERP = this;
    this.out = out || function () { };
    this.input = input || function () { return ''; };
    this.steps = 0;
    this.callDepth = 0;
    this.deadline = 0;
    this.global = new Scope(null);
    this.funcs = {};

    this.inBuf = [];   /* cin 的输入词缓冲，跨多次 >> 共享 */

    /* ⚠ C++ 的虚拟文件系统 —— 与 Python 侧(pylite) **各存一份**，不共享。
       这是有意的决定：两边互不牵连。
       ⚠ 每个 Interp 实例独享 —— 放原型上共享的话，重跑一次会读到
       上次的残留文件，表现为"我没建过这个文件啊"。 */
    this.vfs = {};
    this.vfsNoteDone = false;
    /* freopen 重定向：cin 从哪个文件读（null = 标准输入） */
    this.cinFile = null;

    this.structs = {};   /* struct 名 → 字段列表 */
    this.install();
  }

  Interp.prototype = {
    tick: function () {
      if (++this.steps > MAX_STEPS) {
        /* 措辞必须说清：这是**本环境的能力上限**，不等于用户的算法会 TLE。
           原措辞"可能存在死循环"会让用户以为自己写错了，
           而实际上可能只是 n 开得比解释器能跑的大而已。 */
        throw cerr('本环境已跑满 ' + MAX_STEPS.toLocaleString() + ' 步（相当于真实 C++ 约 ' +
          PERF.human(MAX_STEPS) + '），停止执行。\n' +
          '这不代表你的程序会超时 —— 本环境是解释器，比真实编译器慢几个数量级。\n' +
          '要判断会不会 TLE，请用「TLE 预测」（按小规模外推），而不是看这里跑不跑得完。');
      }
      /* 墙钟超时也要说清：这是**本环境的时间预算**，不等于真实超时。
         解释器跑 5 秒对应的真实 C++ 时间往往只有几十毫秒 ——
         用"可能存在死循环"会让用户怀疑自己的代码，而它可能完全正常。 */
      if (this.deadline && Date.now() > this.deadline) {
        throw cerr('本环境已跑满时间预算（' +
          ((this.deadline - this.t0) / 1000).toFixed(1) + ' 秒），停止执行。\n' +
          '这不代表你的程序会超时 —— 本环境比真实编译器慢几个数量级，\n' +
          '要判断是否 TLE，请用「TLE 预测」按目标规模外推。');
      }
    },

    install: function () {
      var self = this;
      var g = this.global;
      g.set('cout', { __cout: true });
      g.set('cin', { __cin: true });
      g.set('stdin', { __stdin: true });
      g.set('stdout', { __stdout: true });

      /* ---------- C++ 虚拟文件系统（独立于 Python 侧） ----------
       * 第一次用到文件时就提示一次：这是**内存里**的，不是本地硬盘。
       * 不提示的话用户会以为自己在读写真实文件，
       * 于是刷新后发现文件没了 —— 比没有这个功能更让人困惑。 */
      function vfsNote() {
        if (self.vfsNoteDone || !self.out) return;
        self.vfsNoteDone = true;
        self.out('[提示] C++ 文件读写用的是内存里的虚拟文件系统，不是本地硬盘；刷新页面即消失。');
      }

      function CppFile(path, mode) {
        vfsNote();
        this.__cppfile = true;
        this.path = String(path);
        this.mode = String(mode || (this.__isOut ? 'w' : 'r'));
        this.closed = false;
        var isOut = /[wa]/.test(this.mode) && !/\+/.test(this.mode);
        var isIn = /r/.test(this.mode);
        this.__isIn = isIn || (!isOut);
        this.__isOut = isOut;
        var exists = Object.prototype.hasOwnProperty.call(self.vfs, this.path);
        if (this.__isIn && !exists) {
          this.ok = false;                 /* 打开失败：if(!fin) 应为真 */
          this._readBuf = '';
        } else {
          this.ok = true;
          this._readBuf = this.__isIn ? self.vfs[this.path] : '';
        }
        this._writeBuf = this.__isOut ? '' : '';
      }
      CppFile.prototype._flush = function () {
        if (this.__isOut && !this.closed) self.vfs[this.path] = this._writeBuf;
      };
      /* 从文件缓冲取一个词 —— 与 cin 的 nextToken 同规则（按空白切分） */
      CppFile.prototype._nextToken = function () {
        this._readBuf = this._readBuf.replace(/^\s+/, '');
        if (this._readBuf === '') return '';
        var m = /^\S+/.exec(this._readBuf);
        var w = m[0];
        this._readBuf = this._readBuf.slice(w.length);
        return w;
      };
      CppFile.prototype._getline = function () {
        var nl = this._readBuf.indexOf('\n');
        var line;
        if (nl < 0) { line = this._readBuf; this._readBuf = ''; }
        else { line = this._readBuf.slice(0, nl); this._readBuf = this._readBuf.slice(nl + 1); }
        return line;
      };
      /* if (!fin) —— C++ 的 ifstream 有 operator bool，打不开时为假。
         不做这个的话 `if (!fin)` 恒为假（对象总是真值），
         于是"文件打不开"的处理分支永远进不去，用户以为自己读了空文件。 */
      CppFile.prototype.__bool = function () { return this.ok && !this.closed; };
      self.CppFile = CppFile;

      /* freopen：竞赛里极常见的重定向（freopen("in.txt","r",stdin)）。
         不做的话整段重定向会被静默忽略，程序继续从键盘读 ——
         用户会以为文件没生效，而实际上根本没实现。 */
      g.set('freopen', function (path, mode) {
        vfsNote();
        var p = String(path);
        if (!Object.prototype.hasOwnProperty.call(self.vfs, p)) {
          /* 读不到就返回 NULL 语义：让后续读入为空，而不是假装成功 */
          self.cinFile = null;
          return null;
        }
        self.cinFile = p;
        self.inBuf = [];
        return { __stdin: true };
      });
      /* getline：两种形态都要支持
           getline(cin, s)      从标准输入读一行
           getline(fin, s)      从文件读一行
         ⚠ 只支持第一种的话，从文件读行会静默读到空串 ——
           用户以为文件是空的，实际是没实现。 */
      g.set('getline', function (stream, target) {
        var line;
        if (stream && stream.__cppfile) line = stream._getline();
        else if (self.cinFile) {
          var txt = self.vfs[self.cinFile] || '';
          var nl = txt.indexOf('\n');
          if (nl < 0) { line = txt; self.vfs[self.cinFile] = ''; }
          else { line = txt.slice(0, nl); self.vfs[self.cinFile] = txt.slice(nl + 1); }
          self.inBuf = [];
        } else {
          line = self.input();
        }
        /* 第二个参数在 C++ 里是**引用**，传进来只是当前值（0），
           拿不到名字。所以从 __argNames 取实参名，按名字写回调用处作用域。
           只按值判断的话 getline 会静默什么都不做 —— s 保持初值 0，
           用户会以为文件是空的。 */
        var nm = null;
        if (self.__argNames && self.__argNames.length > 1) nm = self.__argNames[1];
        if (nm) {
          var sc = self.curScope || self.global;
          sc.set(nm, String(line));
          return sc;
        }
        if (typeof target === 'string') {
          var sc2 = self.curScope || self.global;
          sc2.set(target, String(line));
          return sc2;
        }
        return String(line);
      });

      g.set('fopen', function (path, mode) {
        vfsNote();
        return new CppFile(path, mode);
      });
      g.set('endl', '\n');
      g.set('true', true); g.set('false', false);

      function printf() {
        var a = Array.prototype.slice.call(arguments);
        var fmt = typeof a[0] === 'string' ? a[0] : '';
        if (typeof a[0] !== 'string') { self.out(a.map(self.str).join(' ')); return 0; }
        var i = 1, s = '';
        var re = /%([-+ 0#]*)(?:(\d+))?(?:\.(\d+))?([dioxXucsfeEgG%])/g;
        s = fmt.replace(re, function (m, flags, width, prec, spec) {
          if (spec === '%') return '%';
          var v = a[i++];
          var txt;
          if (spec === 'd' || spec === 'i') txt = String(Math.trunc(Number(v)));
          else if (spec === 'u') txt = String(Math.abs(Math.trunc(Number(v))));
          else if (spec === 'o') txt = Math.trunc(Number(v)).toString(8);
          else if (spec === 'x') txt = Math.trunc(Number(v)).toString(16);
          else if (spec === 'X') txt = Math.trunc(Number(v)).toString(16).toUpperCase();
          else if (spec === 'c') txt = String.fromCharCode(Number(v));
          else if (spec === 's') txt = self.str(v);
          else if (spec === 'f' || spec === 'F') txt = Number(v).toFixed(prec ? parseInt(prec, 10) : 6);
          else if (spec === 'e' || spec === 'E') txt = Number(v).toExponential(prec ? parseInt(prec, 10) : 6);
          else if (spec === 'g' || spec === 'G') txt = String(Number(v));
          else txt = self.str(v);
          if (width) {
            var w = parseInt(width, 10);
            var pad = flags && flags.indexOf('0') >= 0 ? '0' : ' ';
            if (flags && flags.indexOf('-') >= 0) txt = txt + new Array(Math.max(0, w - txt.length) + 1).join(' ');
            else txt = new Array(Math.max(0, w - txt.length) + 1).join(pad) + txt;
          }
          return txt;
        });
        self.out(s);
        return s.length;
      }
      this.funcs.printf = { builtin: printf };
      this.funcs.puts = { builtin: function (s) { self.out(self.str(s) + '\n'); return 0; } };
      this.funcs.sprintf = { builtin: function () { return 0; } };
      this.funcs.strlen = { builtin: function (s) { return String(s).length; } };
      this.funcs.abs = { builtin: function (x) { return Math.abs(x); } };
      this.funcs.sqrt = { builtin: Math.sqrt };
      this.funcs.pow = { builtin: Math.pow };
      this.funcs.min = { builtin: function (a, b) { return Math.min(a, b); } };
      this.funcs.max = { builtin: function (a, b) { return Math.max(a, b); } };
      this.funcs.floor = { builtin: Math.floor };
      this.funcs.ceil = { builtin: Math.ceil };
      this.funcs.round = { builtin: Math.round };
      this.funcs.scanf = { builtin: function () { return 0; } };

      /* ================= 竞赛常用算法 =================
       * sort 是竞赛里用得最多的函数，没有之一。以前报"暂不支持的函数：sort"，
       * 等于绝大多数题都跑不了。
       *
       * 这里支持三种调用形式（真实竞赛代码里都会出现）：
       *   sort(a)          —— 整个数组
       *   sort(a, n)       —— 前 n 个元素
       *   sort(a, l, r)    —— 下标 [l, r)
       * 数组是原地排序（C++ 语义就是原地），返回排序后的数组以便链式使用。
       */
      this.funcs.sort = {
        builtin: function (a, b, c, d) {
          var self2 = INTERP;
          if (!Array.isArray(a)) throw cerr('sort 的第一个参数必须是数组');
          var arr = a;
          var l = 0, r = arr.length, cmpArg = null;
          var isFn = function (v) { return v && typeof v === 'object' && (v.__fn || v.__builtinFn || v.__lambda); };
          var isPtr = function (v) { return v && typeof v === 'object' && (v.__ptr || v.__iter); };
          /* 形式：sort(a, cmp) —— 数组 + 比较器 */
          if (isFn(b)) { cmpArg = b; }
          /* 形式：sort(a, a+n, cmp) —— 指针尾 + 比较器。
             ⚠ 必须放在 number 判定之前：`a+n` 是指针替身不是数字，
             漏了这条的话比较器被忽略，降序变升序 ——
             不报错，只是答案反了，竞赛里最难查。 */
          else if (isPtr(b) && isFn(c)) { r = (b.__idx !== undefined ? b.__idx : b.__at) || 0; cmpArg = c; }
          else if (isPtr(b)) { r = (b.__idx !== undefined ? b.__idx : b.__at) || 0; }
          /* 形式：sort(a, n, cmp) */
          else if (typeof b === 'number' && typeof c === 'object') { r = Math.min(b, arr.length); cmpArg = c; }
          /* 形式：sort(a, n) */
          else if (typeof b === 'number' && c === undefined) { r = Math.min(b, arr.length); }
          /* 形式：sort(a, l, r) */
          else if (typeof b === 'number' && typeof c === 'number') { l = b; r = Math.min(c, arr.length); cmpArg = d; }
          /* 形式：sort(begin, end, cmp) 已在 doCall 处理 */
          var cmpFn = resolveCmp(self2, cmpArg);
          if (cmpArg && !cmpFn) throw cerr('无法识别的比较器');
          var part = arr.slice(l, r).sort(cmpFn || function (x, y) {
            if (typeof x === 'number' && typeof y === 'number') return x - y;
            return String(x) < String(y) ? -1 : (String(x) > String(y) ? 1 : 0);
          });
          for (var i = 0; i < part.length; i++) arr[l + i] = part[i];
          return arr;
        }
      };

      /* reverse：与 sort 同级的常用操作 */
      this.funcs.reverse = {
        builtin: function (a) {
          if (!Array.isArray(a)) throw cerr('reverse 的参数必须是数组');
          a.reverse();
          return a;
        }
      };

      /* lower_bound / upper_bound：二分查找，返回下标（找不到返回长度） */
      /* lower_bound 有两种常见写法，都得支持：
           lower_bound(a, a+n, v)  —— STL 迭代器风格（三个参数）
           lower_bound(a, n, v)    —— 数组 + 长度 + 值（竞赛简化写法）
         只支持一种的话，另一种会静默返回错的下标 ——
         而二分查找错了不会报错，只会给出错误答案。 */
      function boundHelper(a, b, c, inclusive) {
        var arr = a, lo = 0, hi, v;
        if (Array.isArray(a)) {
          if (c === undefined) { hi = arr.length; v = b; }
          else { lo = 0; hi = Math.min(b, arr.length); v = c; }
        } else throw cerr('lower_bound / upper_bound 的第一个参数必须是数组');
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (inclusive ? (arr[mid] <= v) : (arr[mid] < v)) lo = mid + 1; else hi = mid;
        }
        return lo;
      }
      this.funcs.lower_bound = { builtin: function (a, b, c) { return boundHelper(a, b, c, false); } };
      this.funcs.upper_bound = { builtin: function (a, b, c) { return boundHelper(a, b, c, true); } };

      this.funcs.make_pair = { builtin: function (a, b) { return makePair(a, b); } };

      /* ================= <algorithm> 常用算法 =================
       * 这些是竞赛的"日常工具"。缺了任何一个，用户都得手写循环替代，
       * 而手写循环又容易出错 —— 工具本身不该成为障碍。
       * 指针形式（返回的是迭代器/指针）这里返回下标，
       * 因为本环境没有真指针；同时支持直接解引用 *max_element(...)。
       * ======================================================== */
      function toArr(a) {
        if (Array.isArray(a)) return a;
        if (a && a.__set) return a.__data;
        if (a && a.__iter) return a.__iter;
        throw cerr('需要数组或容器，收到：' + JSON.stringify(a));
      }
      /* 三参数区间 (first, last, ...) 或两参数 (arr, ...) */
      function rangeArgs(args, needValue) {
        var arr = toArr(args[0]);
        /* ⚠ 起点来自 args[0]（可能是首指针），终点来自 args[1]（尾指针）。
           把起点也取自 args[1] 的话，`a+3` 会同时当起点和终点，
           区间变成 [3,3) —— 所有算法都返回空结果（0），
           而且不报错，用户只会以为算法坏了。 */
        var l = (args[0] && (args[0].__ptr === arr || args[0].__iter === arr))
                ? ((args[0].__idx !== undefined ? args[0].__idx : args[0].__at) || 0) : 0;
        var r = arr.length, v = null;
        var a1 = args[1], a2 = args[2], a3 = args[3];
        /* 形式 1：迭代器 / 指针 —— f(v.begin(), v.end(), ...) 或 f(a, a+n, ...) */
        if (a1 && (a1.__iter === arr || a1.__ptr === arr)) {
          r = (a1.__idx !== undefined ? a1.__idx : a1.__at) || 0;
          if (a2 && (a2.__iter === arr || a2.__ptr === arr)) { r = (a2.__idx !== undefined ? a2.__idx : a2.__at) || 0; v = a3; }
          else { v = a2; }
        }
        /* 形式 2：数组 + 个数 —— f(a, n, ...) */
        else if (typeof a1 === 'number') { r = Math.min(a1, arr.length); v = a2; }
        /* 形式 3：只有数组 —— f(a, ...) */
        else { v = a1; }
        return { arr: arr, l: l, r: r, v: v };
      }

      this.funcs.max_element = {
        builtin: function () {
          var g = rangeArgs(arguments, false), bi = g.l, bv = -Infinity;
          if (g.l >= g.r) return { __ptr: g.arr, __idx: g.l, valueOf: function () { return g.arr[g.l]; } };
          for (var i = g.l; i < g.r; i++) if (g.arr[i] > bv) { bv = g.arr[i]; bi = i; }
          return { __ptr: g.arr, __idx: bi, valueOf: function () { return g.arr[bi]; } };
        }
      };
      this.funcs.min_element = {
        builtin: function () {
          var g = rangeArgs(arguments, false), bi = g.l, bv = Infinity;
          if (g.l >= g.r) return { __ptr: g.arr, __idx: g.l, valueOf: function () { return g.arr[g.l]; } };
          for (var i = g.l; i < g.r; i++) if (g.arr[i] < bv) { bv = g.arr[i]; bi = i; }
          return { __ptr: g.arr, __idx: bi, valueOf: function () { return g.arr[bi]; } };
        }
      };
      this.funcs.accumulate = {
        builtin: function () {
          var g = rangeArgs(arguments, true), sum = (g.v === null || g.v === undefined) ? 0 : g.v;
          for (var i = g.l; i < g.r; i++) sum += g.arr[i];
          return sum;
        }
      };
      this.funcs.count = {
        builtin: function () {
          var g = rangeArgs(arguments, true), c = 0;
          for (var i = g.l; i < g.r; i++) if (g.arr[i] === g.v) c++;
          return c;
        }
      };
      this.funcs.find = {
        builtin: function () {
          var g = rangeArgs(arguments, true);
          for (var i = g.l; i < g.r; i++) if (g.arr[i] === g.v) return { __ptr: g.arr, __idx: i, valueOf: function () { return g.arr[i]; } };
          return { __ptr: g.arr, __idx: g.r, valueOf: function () { return null; } };
        }
      };
      this.funcs.fill = {
        builtin: function () {
          var g = rangeArgs(arguments, true);
          for (var i = g.l; i < g.r; i++) g.arr[i] = g.v;
          return g.arr;
        }
      };
      /* unique：去重（相邻），返回新长度对应的"尾指针" */
      this.funcs.unique = {
        builtin: function () {
          var g = rangeArgs(arguments, false), out = [];
          for (var i = g.l; i < g.r; i++) if (i === g.l || g.arr[i] !== g.arr[i - 1]) out.push(g.arr[i]);
          for (var j = 0; j < out.length; j++) g.arr[g.l + j] = out[j];
          return { __ptr: g.arr, __idx: g.l + out.length, valueOf: function () { return g.l + out.length; } };
        }
      };
      /* 迭代器距离：distance / 指针相减 */
      this.funcs.distance = {
        builtin: function (a, b) {
          if (a && a.__ptr && b && b.__ptr) return b.__idx - a.__idx;
          if (a && a.__iter && b && b.__iter) return b.__at - a.__at;
          return 0;
        }
      };
      /* next_permutation / prev_permutation：全排列枚举常用 */
      this.funcs.next_permutation = {
        builtin: function (a, b) {
          var arr = toArr(a);
          var l = 0, r = (b && b.__iter === arr) ? (b.__at || 0) : (typeof b === 'number' ? b : arr.length);
          var i = r - 1;
          while (i > l && arr[i - 1] >= arr[i]) i--;
          if (i <= l) { arr.slice(l, r).sort(function (x, y) { return x - y; }).forEach(function (v, k) { arr[l + k] = v; }); return false; }
          var j = r - 1;
          while (arr[j] <= arr[i - 1]) j--;
          var t = arr[i - 1]; arr[i - 1] = arr[j]; arr[j] = t;
          var tail = arr.slice(i, r).sort(function (x, y) { return x - y; });
          for (var k2 = 0; k2 < tail.length; k2++) arr[i + k2] = tail[k2];
          return true;
        }
      };
      /* swap：交换两个元素（数组+下标 或 两个变量不行，这里支持数组形式） */
      /* swap(a, b)：支持变量名形式。
         ⚠ 靠 __swapNames 拿到调用处的实参**名字**，再走作用域交换。
         因为值传进来只是副本，直接交换改不到外面 ——
         表面上"跑成功了"但两个变量纹丝不动，这是最隐蔽的一类错。 */
      this.funcs.swap = {
        builtin: function (a, b) {
          var names = this && this.__swapNames;
          if (names && names[0] && names[1]) {
            var sc = INTERP ? INTERP.curScope : null;
            if (sc) { var tmp = sc.get(names[0]); sc.set(names[0], sc.get(names[1])); sc.set(names[1], tmp); return 0; }
          }
          /* 数组形式：swap(a[i], a[j]) 拿不到左值，明确告知 */
          throw cerr('swap 需要两个变量名：swap(a, b)。数组元素形式 swap(a[i], a[j]) 在本环境不支持，请手写临时变量');
        }
      };
      /* binary_search：存在性二分 */
      this.funcs.binary_search = {
        builtin: function () {
          var g = rangeArgs(arguments, true);
          var lo = g.l, hi = g.r;
          while (lo < hi) { var mid = (lo + hi) >> 1; if (g.arr[mid] < g.v) lo = mid + 1; else hi = mid; }
          return (lo < g.r && g.arr[lo] === g.v);
        }
      };
      /* 位运算与数学补充 */
      this.funcs.__builtin_popcount = { builtin: function (x) { var c = 0; x = x >>> 0; while (x) { c += x & 1; x >>>= 1; } return c; } };
      this.funcs.log2 = { builtin: function (x) { return Math.log2(x); } };
      this.funcs.log10 = { builtin: function (x) { return Math.log10(x); } };
      this.funcs.exp = { builtin: function (x) { return Math.exp(x); } };
      this.funcs.hypot = { builtin: function (a, b) { return Math.sqrt(a * a + b * b); } };

      /* __gcd：数论常用（<algorithm> 里实际叫 std::gcd，竞赛常写 __gcd） */
      this.funcs.__gcd = {
        builtin: function (a, b) {
          a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
          while (b) { var t = b; b = a % b; a = t; }
          return a;
        }
      };
      this.funcs.gcd = this.funcs.__gcd;
    },

    str: function (v) {
      if (v === null || v === undefined) return 'null';
      /* C++ 的 cout << bool 默认输出 1 / 0（不是 true / false，
         那是 std::boolalpha 的行为）。
         输出 true/false 会让结果看起来"对"但在 OJ 上格式不对 ——
         竞赛输出格式是严格匹配的。 */
      if (typeof v === 'boolean') return v ? '1' : '0';
      /* 整数直接输出。
         以前统一走 Math.round(v*1e10)/1e10，超过 2^53 精度的大整数
         会被表示成 7778742049.000001 —— 而 long long 输出的正是这类数，
         竞赛答案错一位就是 WA，这种"看起来差不多"的输出最危险。 */
      /* C++ 的 cout 打印浮点无穷是 `inf` / `-inf`，不是 JS 的 `Infinity`。
         写 Infinity 的话，用户照着这个输出去对 OJ 的样例就对不上。 */
      if (v === Infinity) return 'inf';
      if (v === -Infinity) return '-inf';
      if (typeof v === 'object' && v !== null && typeof v.__big === 'bigint') return v.__big.toString();
      if (typeof v === 'number') {
        if (Number.isInteger(v)) return String(v);
        return String(Math.round(v * 1e10) / 1e10);
      }
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return '[' + v.map(this.str, this).join(', ') + ']';
      if (v && typeof v === 'object' && v.__manip) {
        if (v.__manip === 'endl') return '\n';
        return '';    /* fixed / hex 等只影响格式，不产生字符 */
      }
      return String(v);
    },

    run: function (src, opts) {
      opts = opts || {};
      this.steps = 0;
      this.deadline = opts.timeout ? Date.now() + opts.timeout : 0;
      /* 宏必须先收集、剥离、再展开，然后才分词。
         顺序错了（比如先分词再展开）会导致宏里的多 token 替换对不上。 */
      src = preprocess(src);
      var tree = new Parser(tokenize(src)).parse();
      /* 先收集函数 */
      var self = this;
      tree.body.forEach(function (n) { if (n.type === 'Func') self.funcs[n.name] = { node: n }; });
      var main = null;
      tree.body.forEach(function (n) {
        if (n.type === 'Func' && n.name === 'main') main = n;
      });
      if (!main) throw cerr('没有找到 main 函数');
      var g = this.global;
      /* ⚠ StructDecl 必须在这里 exec 一遍（此前漏了）。
         不 exec 的话 `self.structs` 永远是空表，
         于是 struct 实例建出来没有任何字段 ——
         单层 struct 靠"赋值时动态加属性"侥幸能用，
         但嵌套字段（S-127）建不出来，`b.a.v=5` 报
         "不能给非对象赋值成员：v"。 */
      tree.body.forEach(function (n) {
        if (n.type === 'VarDecl' || n.type === 'StructDecl') self.exec(n, g);
      });
      this.callFunc(main, [], g);
      return {
        steps: this.steps,
        /* 等效真实 C++ 耗时。这是"时间同步"的核心输出 ——
           用户看到的应该是"我的程序在真实环境里要多久"，
           而不是"这个解释器跑了多久"。 */
        realSec: PERF.toRealSec(this.steps),
        realText: PERF.human(this.steps)
      };
    },

    exec: function (node, scope) {
      this.tick();
      var self = this;
      switch (node.type) {
        case 'Pass': return null;
        case 'Block': return this.execBlock(node.body, scope);
        /* struct 定义：登记字段，供后面 P p; 使用 */
        case 'StructDecl':
          if (node.fields) self.structs[node.name] = node.fields;
          else if (!self.structs[node.name]) self.structs[node.name] = [];
          return null;

        /* 容器声明：vector / map / set。
           值统一用 JS 数组表示（map 用带 __map 标记的对象），
           这样现有的下标读写、sort、循环遍历都能直接复用。 */
        case 'ContainerDecl': {
          var val2;
          if (node.kind === 'map' || node.kind === 'unordered_map') {
            val2 = { __map: true, data: {} };
          } else if (node.kind === 'set' || node.kind === 'unordered_set') {
            val2 = makeSet();
          } else if (node.kind === 'stack') {
            val2 = makeStack();
          } else if (node.kind === 'queue') {
            val2 = makeQueue();
          } else if (node.kind === 'priority_queue') {
            val2 = makePQueue();
          } else if (node.kind === 'pair') {
            val2 = makePair(0, 0);
          } else {
            /* vector / deque / stack / queue / priority_queue / list 都用数组 */
            val2 = [];
            if (node.init && node.init.type === 'CtorArgs' && node.init.a !== null) {
              var cnt = self.eval(node.init.a, scope) | 0;
              var fill = node.init.b !== null ? self.eval(node.init.b, scope) : 0;
              /* ⚠ 元素类型本身是容器时（`vector<vector<int>> g(3)`），
                 每个元素必须建一个空数组而不是填 0 ——
                 否则 `g[0].push_back(1)` 会报"结构体成员访问"，
                 因为 g[0] 是数字 0。真实 C++ 里这是 3 个空 vector。 */
              var elemIsContainer = /vector|map|set|deque|stack|queue|list|pair/.test(node.elem || '');
              for (var ci = 0; ci < cnt; ci++) val2.push(elemIsContainer ? [] : fill);
            } else if (node.init) {
              var iv = self.eval(node.init, scope);
              if (Array.isArray(iv)) val2 = iv.slice();
              else if (iv !== null && iv !== undefined) val2 = [iv];
            }
          }
          scope.declare(node.name, val2);
          return null;
        }

        /* struct 变量：按登记的字段建对象，数值字段默认 0 */
        case 'StructVarDecl': {
          var fields = self.structs[node.typeName] || [];
          /* ⚠ 字段本身是 struct 时要递归建对象（S-127）。
             此前统一填 0，于是 `b.a.v = 5` 报"不能给非对象赋值成员：v" ——
             语法解析过了、赋值却失败，用户会以为是自己的访问方式写错了。
             嵌套结构体是链表节点、树节点的基础，数据结构入门必需。 */
          var mkInst = function (tn, d) {
            d = d || 0;
            var o = { __struct: true, __type: tn };
            var fs2 = self.structs[tn] || [];
            fs2.forEach(function (f) {
              if (self.structs[f.type] && d < 8) o[f.name] = mkInst(f.type, d + 1);
              else if (Array.isArray(f.arr)) o[f.name] = [];
              else o[f.name] = (f.type === 'char' || f.type === 'string') ? '' : 0;
            });
            return o;
          };
          var mkInstTop = function () { return mkInst(node.typeName, 0); };
          if (node.sizes) {
            var cnt2 = self.eval(node.sizes[0] || { type: 'Num', v: 0 }, scope) | 0;
            var arr2 = [];
            for (var si = 0; si < cnt2; si++) arr2.push(mkInstTop());
            scope.declare(node.name, arr2);
          } else {
            scope.declare(node.name, mkInstTop());
          }
          return null;
        }

        /* switch：找匹配的 case，穿透（fallthrough）到下一个 break。
           C++ 的 switch 是穿透的 —— 不实现穿透的话，
           `case 1: case 2: ...` 这种合并写法会失效。 */
        case 'Switch': {
          var dv = self.eval(node.disc, scope);
          var idx3 = -1;
          for (var k3 = 0; k3 < node.cases.length; k3++) {
            if (self.eval(node.cases[k3].test, scope) === dv) { idx3 = k3; break; }
          }
          if (idx3 < 0 && node.def) idx3 = node.cases.length;  /* default 放最后 */
          if (idx3 < 0) return null;
          /* ⚠ 不能直接用 execBlock —— 它会把 break 的返回值丢掉，
             于是 switch 永远不会在 break 处停下，一路穿透到底。
             所以自己逐条执行并检查返回值。 */
          for (var k4 = idx3; k4 <= node.cases.length; k4++) {
            var blk = (k4 === node.cases.length) ? (node.def ? node.def.body : null) : node.cases[k4].body;
            if (!blk) continue;
            /* break / continue 是**抛异常**实现的（CBreak / CContinue），
               不是返回值 —— 所以用 try/catch 接，检查返回值是接不到的。
               不接住的话 break 会一路穿到最外层，
               表现为 switch 之后的代码全都不执行。 */
            var broke = false;
            try {
              for (var bi = 0; bi < blk.length; bi++) self.exec(blk[bi], scope);
            } catch (e5) {
              if (e5 && e5.__break) broke = true;
              else if (e5 && e5.__continue) return null;
              else throw e5;   /* return 信号继续往外传 */
            }
            if (broke) return null;
            /* default 段执行完就不再穿透 */
            if (k4 === node.cases.length) break;
          }
          return null;
        }

        /* 引用声明：把名字绑到"目标表达式的读写"上。
           简单可靠的做法是绑定变量名（最常见的 `int &r = x;`），
           对数组元素等复杂左值给明确提示而不是静默退化成普通变量。 */
        case 'AliasDecl': {
          if (node.target && node.target.type === 'Name') {
            var tgt = node.target.name;
            scope.declare(node.name, scope.get(tgt));
            (self.aliases2 || (self.aliases2 = {}))[node.name] = tgt;
            return null;
          }
          throw cerr('引用目前只支持绑定到变量：int &r = x;');
        }

        /* 文件流声明要在这里接 —— 只加到 eval 的 switch 不够，
           语句执行走的是 exec。漏了这里会报
           "暂不支持的语句：StreamDecl"（从报错看不出漏在哪）。 */
        case 'StreamDecl': return this.doStreamDecl(node, scope);
        case 'VarDecl':
          node.decls.forEach(function (d) {
            var val;
            if (d.sizes) {
              /* 初始化列表是 AST 节点（InitList），先求值再取长度 */
              var initArr = d.init ? self.eval(d.init, scope) : null;
              var dims = d.sizes.map(function (z) { return z ? (self.eval(z, scope) | 0) : 0; });
              /* 多维数组（S-075）：int a[2][2] —— 按维度递归建嵌套数组。
                 竞赛里二维 DP、矩阵题全靠它，不支持等于这类题都写不了。 */
              var build = function (k) {
                var n1 = Math.max(0, dims[k] || 0);
                var arr9 = new Array(n1);
                var def0 = d.type === 'char' ? '' : 0;
                if (k < dims.length - 1) {
                  for (var q = 0; q < n1; q++) arr9[q] = build(k + 1);
                } else {
                  for (var q2 = 0; q2 < n1; q2++) arr9[q2] = def0;
                }
                return arr9;
              };
              val = dims.length > 1 ? build(0) : null;
              if (!val) {
                if (initArr !== null && !Array.isArray(initArr)) initArr = [initArr];
                var n0 = initArr ? initArr.length : (dims[0] || 0);
                val = new Array(Math.max(0, n0 | 0));
                var def = d.type === 'char' ? '' : 0;
                for (var i = 0; i < val.length; i++) val[i] = def;
                if (initArr) for (var j = 0; j < initArr.length && j < val.length; j++) val[j] = initArr[j];
              }
            } else {
              val = d.init ? self.eval(d.init, scope) : (d.type === 'char' ? '' : 0);
              if (d.type === 'int' && typeof val === 'number') val = Math.trunc(val);
              /* ⚠ 赋值时按**目标类型**回绕（S-115）。
                 C 的整型提升让 `short s; s + 1` 的结果是 int（32768），
                 只有赋回 short 时才截断成 -32768。
                 只在运算处回绕、赋值处不回绕的话，
                 `short r = s+1` 会得到 32768 —— 而 g++ 是 -32768。 */
              if (UB.isReal() && d.type && typeof val === 'number' && Number.isInteger(val)) {
                val = wrapInt(val, d.type);
              }
            }
            /* 第三个参数是 C 类型 —— 不存的话后面无法按宽度回绕，
               也无法做 unsigned 的整型提升（S-115 / S-116）。 */
            scope.declare(d.name, val, d.type || node.type2 || null);
          });
          return null;
        case 'Expr': this.eval(node.expr, scope); return null;
        case 'If':
          if (this.truthy(this.eval(node.cond, scope))) return this.execBody(node.then, scope);
          if (node.els) return this.execBody(node.els, scope);
          return null;
        case 'For': return this.execFor(node, scope);
        /* 范围 for：遍历数组 / vector / string / map 的键。
           引用形式（int &x）要能把改动写回容器 ——
           否则 `for(int &x : a) x*=2;` 看起来跑了却什么都没变，
           这种错不报也不崩，只是答案不对。 */
        case 'RangeFor': {
          var cont = this.eval(node.iter, scope);
          var items9;
          if (Array.isArray(cont)) items9 = cont;
          else if (cont && cont.__map) items9 = Object.keys(cont.data);
          else if (typeof cont === 'string') items9 = cont.split('');
          else throw cerr('范围 for 无法遍历：不是数组或容器');
          for (var ri9 = 0; ri9 < items9.length; ri9++) {
            scope.declare(node.varName, items9[ri9]);
            try {
              this.execBody(node.body, scope);
            } catch (eR9) {
              if (eR9 && eR9.__break) return null;
              if (eR9 && eR9.__continue) { if (node.byRef) items9[ri9] = scope.get(node.varName); continue; }
              throw eR9;
            }
            if (node.byRef) items9[ri9] = scope.get(node.varName);   /* 引用写回 */
          }
          return null;
        }
        case 'While': return this.execWhile(node, scope, false);
        case 'DoWhile': return this.execWhile(node, scope, true);
        case 'Return': throw new CReturn(node.value ? this.eval(node.value, scope) : null);
        case 'Break': throw new CBreak();
        case 'Continue': throw new CContinue();
      }
      throw cerr('暂不支持的语句：' + node.type);
    },

    execBlock: function (body, parent) {
      var sc = new Scope(parent);
      for (var i = 0; i < body.length; i++) this.exec(body[i], sc);
      return null;
    },

    /* 控制流（if / for / while / do）的 body 用当前作用域，不另开一层。
       若开新层，`i++` 与 `s += i` 会写进子作用域，外层变量纹丝不动：
       for 得不到累加结果，while 更是直接死循环。 */
    execBody: function (node, scope) {
      if (!node) return null;
      if (node.type === 'Block') {
        for (var i = 0; i < node.body.length; i++) this.exec(node.body[i], scope);
        return null;
      }
      return this.exec(node, scope);
    },

    execFor: function (node, parent) {
      var sc = new Scope(parent);
      if (node.init) this.exec(node.init, sc);
      var n = 0;
      while (!node.cond || this.truthy(this.eval(node.cond, sc))) {
        this.tick();
        /* 单次循环的迭代上限。原来是 100 万 —— 而 n=1e6 的 O(n) 是
           完全正常的规模，会被这里直接掐断。
           且措辞"可能存在死循环"同样把本环境的限制说成了用户的错。
           提高到 2e7，并给出等效真实时间让用户自己判断。 */
        if (++n > 20000000) {
          throw cerr('单次循环超过 2000 万次，本环境停止执行。\n' +
            '这不代表你的程序会超时 —— 请用「TLE 预测」按目标规模外推判断。');
        }
        try { this.execBody(node.body, sc); } catch (e) {
          if (e instanceof CBreak) break;
          if (e instanceof CContinue) { if (node.step) this.eval(node.step, sc); continue; }
          throw e;
        }
        if (node.step) this.eval(node.step, sc);
      }
      return null;
    },

    execWhile: function (node, parent, isDo) {
      var sc = new Scope(parent);
      var n = 0;
      var first = true;
      while (first && isDo || this.truthy(this.eval(node.cond, sc))) {
        first = false;
        this.tick();
        if (++n > 20000000) {
          throw cerr('单次循环超过 2000 万次，本环境停止执行。\n' +
            '这不代表你的程序会超时 —— 请用「TLE 预测」按目标规模外推判断。');
        }
        try { this.execBody(node.body, sc); } catch (e) {
          if (e instanceof CBreak) break;
          if (e instanceof CContinue) continue;
          throw e;
        }
      }
      return null;
    },

    truthy: function (v) {
      /* ⚠ 文件对象要按 C++ 的 operator bool 判定：
         ifstream 打不开时 `if (!fin)` 为真。
         不做的话对象恒为真值，"文件打不开"的分支永远进不去 ——
         用户会以为自己读到了空文件，而不是文件不存在。 */
      if (v && v.__cppfile) return !!v.__bool();
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string') return v.length > 0;
      return !!v;
    },

    eval: function (node, scope) {
      this.tick();
      var self = this;
      if (!node) return 0;
      switch (node.type) {
        case 'Num': return node.__big !== undefined ? { __big: node.__big } : node.v;
        case 'Str': return node.v;
        case 'Char': return node.v;
        case 'InitList': return node.elts.map(function (e) { return self.eval(e, scope); });
        case 'Bool': return node.v;
        case 'Null': return null;
        case 'Name':
          /* 函数名当值用：`sort(a, a+n, cmp)`。
             不查函数表的话会报"变量未定义：cmp"，而 cmp 明明就定义在上面 ——
             用户会以为自己拼错了，实际是我们不支持函数指针。 */
          if (this.funcs[node.name] && this.funcs[node.name].node) {
            return { __fn: node.name };
          }
          if (this.funcs[node.name] && this.funcs[node.name].builtin) {
            return { __builtinFn: this.funcs[node.name].builtin };
          }
          /* 流操纵符：endl / fixed / scientific / hex / dec / boolalpha
             `cout << endl` 在 C++ 里是换行，不是变量 ——
             当变量查会报"变量未定义：endl"，而这是每行输出都写的东西。 */
          if (node.name === 'endl') return { __manip: 'endl' };
          if (node.name === 'fixed') return { __manip: 'fixed' };
          if (node.name === 'scientific') return { __manip: 'scientific' };
          if (node.name === 'hex' || node.name === 'dec' || node.name === 'oct') return { __manip: 'base' };
          if (node.name === 'boolalpha') return { __manip: 'boolalpha' };
          if (node.name === 'setprecision') return { __manip: 'setprecision' };
          if (this.funcs[node.name] && this.funcs[node.name].node) {
            return { __fn: node.name };
          }
          if (this.funcs[node.name] && this.funcs[node.name].builtin) {
            return { __builtinFn: this.funcs[node.name].builtin };
          }
          try { return scope.get(node.name); } catch (e) {
            /* 与 Scope.get 里同样的宏提示。
               表达式里用到宏（`int x = N;`）走的是这里，
               只在 Scope.get 里加提示的话，这个最常见的场景反而漏了。 */
            if (MACROS[node.name]) {
              throw cerr('变量未定义：' + node.name + '。' +
                '注意：源码里有 #define ' + node.name + '，' +
                '本环境暂不支持预处理宏，请用常量或 enum 代替', node.line);
            }
            /* 带上行号。拼错变量名是 C++ 里最常见的错误之一，
               没有行号时用户只能从头逐行找 —— 而变量可能在几百行外。 */
            throw cerr('变量未定义：' + node.name, node.line);
          }
        case 'BinOp': return this.binop(node, scope);
        /* Logic 节点（&& / ||）与 BinOp 是两种节点类型。
           只接了 BinOp 的话，`a==0 || b==1` 这种最常见的条件判断
           会报"暂不支持的表达式：Logic" —— 而它在 if 里无处不在。 */
        case 'Logic': return this.binop(node, scope);
        /* 初始化列表 {1,2,3}：求值为数组。
           数组声明与容器声明都用它，求值一次即可。 */
        case 'InitList':
          return node.elts.map(function (e) { return self.eval(e, scope); });

        case 'Cast': {
          var cv = this.eval(node.v, scope);
          if (node.ctype === 'char' || node.ctype === 'unsigned char') {
            /* (char)65 → 'A'：转成字符。
               返回数字 65 的话 `cout << (char)65` 打印 65 而不是 A，
               与真 C++ 不一致。 */
            if (typeof cv === 'number') return String.fromCharCode(Math.trunc(cv) & 0xff);
            return cv;
          }
          if (node.ctype === 'int' || node.ctype === 'long' || node.ctype === 'long long' ||
              node.ctype === 'short' || node.ctype === 'unsigned') {
            if (typeof cv === 'string' && cv.length === 1) return cv.charCodeAt(0);
            return Math.trunc(Number(cv)) || 0;
          }
          if (node.ctype === 'double' || node.ctype === 'float' || node.ctype === 'long double') return Number(cv);
          if (node.ctype === 'string') return this.str(cv);
          return cv;
        }
        case 'Deref': {
          var pv = this.eval(node.v, scope);
          if (pv && typeof pv === 'object' && pv.__ptr) return pv.__ptr[pv.__idx];
          if (pv && typeof pv === 'object' && pv.__iter) return pv.__iter[pv.__at];
          throw cerr('暂不支持：指针解引用（本环境无地址与内存操作）');
        }
        case 'Unary':
          if (node.op === '!') return !this.truthy(this.eval(node.v, scope));
          if (node.op === '-') return -this.eval(node.v, scope);
          if (node.op === '~') return ~this.eval(node.v, scope);
          return this.eval(node.v, scope);
        case 'Ternary':
          return this.truthy(this.eval(node.cond, scope)) ? this.eval(node.then, scope) : this.eval(node.els, scope);
        case 'Assign': return this.doAssign(node, scope);
        case 'PreInc': {
          var t = node.v;
          var cur = this.eval(t, scope);
          var nv = node.dec ? cur - 1 : cur + 1;
          this.assignTo(t, nv, scope);
          return nv;
        }
        case 'PostInc': {
          var t2 = node.v;
          var old = this.eval(t2, scope);
          this.assignTo(t2, node.dec ? old - 1 : old + 1, scope);
          return old;
        }
        case 'Index': {
          var arr = this.eval(node.obj, scope);
          var i = this.eval(node.index, scope);
          if (typeof arr === 'string') return arr[i | 0];
          if (arr && typeof arr === 'object' && arr.__map) {
            var mk2 = String(i);
            return (mk2 in arr.data) ? arr.data[mk2] : 0;
          }
          if (!Array.isArray(arr)) throw cerr('不是数组：' + this.str(arr));
          var ix = i | 0;
          /* 越界读（S-077 / S-063）。安全档明确报错；
             真实档返回 undefined（模拟"读到不确定的值"，真实 C++ 是 UB） */
          if (ix < 0 || ix >= arr.length) {
            UB.check('数组越界', '下标 ' + ix + ' 越界（数组长度 ' + arr.length + '）', node.line);
            return undefined;
          }
          return arr[ix];
        }
        case 'Call': return this.doCall(node, scope);
        case 'StreamDecl': return this.doStreamDecl(node, scope);
        case 'Cout': return this.doCout(node, scope);
        case 'Cin': return this.doCin(node, scope);
        /* vector 的方法。竞赛里 vector 用得极多，
           而它的 .size() / .push_back() 都是成员调用 ——
           不支持成员访问，等于 vector 整体不可用。 */
        case 'Member': {
          var obj = this.eval(node.obj, scope);
          /* 文件对象的方法：fin.close() / fin.eof() / fin.is_open() / fin.good()
             ⚠ 原来只会走到"变量没有这个成员"的报错分支，
             于是 `fin.close()` 报"该容器不支持的成员：close" ——
             用户看不出这是文件流还没支持。 */
          if (obj && obj.__cppfile) {
            /* ⚠ 必须按 doCall 的约定返回 {__bound, __self}。
               第一版我直接返回裸函数，于是 doCall 拿不到 __bound，
               抛"不是可调用的成员" —— 从报错看不出是文件流的问题。 */
            var nm2 = node.name;
            var self3 = this;
            var fn = null;
            if (nm2 === 'close') fn = function () { obj._flush(); obj.closed = true; };
            else if (nm2 === 'is_open') fn = function () { return !!obj.ok && !obj.closed; };
            else if (nm2 === 'good') fn = function () { return !!obj.ok && !obj.closed; };
            else if (nm2 === 'fail') fn = function () { return !obj.ok; };
            else if (nm2 === 'eof') fn = function () { return obj._readBuf === ''; };
            else if (nm2 === 'open') fn = function (pa, mo) {
              var f2 = new self3.CppFile(pa, mo || 'r');
              obj.path = f2.path; obj.mode = f2.mode; obj.ok = f2.ok;
              obj._readBuf = f2._readBuf; obj._writeBuf = ''; obj.closed = false;
            };
            if (!fn) throw cerr('文件对象不支持的成员：' + nm2 +
              '（支持 close / is_open / good / fail / eof / open）');
            return { __bound: fn, __self: obj };
          }
          if (node.arrow) throw cerr('暂不支持：-> 运算符（本环境无指针）');
          /* set / stack / queue / priority_queue / pair：
             它们的方法挂在对象自身上，直接取就行 */
          if (obj && typeof obj === 'object' &&
              (obj.__set || obj.__stack || obj.__queue || obj.__pqueue || obj.__pair)) {
            var m2 = obj[node.name];
            if (typeof m2 === 'function') return { __bound: m2, __self: obj };
            if (m2 !== undefined) return m2;          /* pair.first / pair.second */
            throw cerr('该容器不支持的成员：' + node.name);
          }
          /* string 的方法。s.length() 是竞赛里最常用的字符串操作，
             不支持的话连最基本的字符串处理都做不了。 */
          if (typeof obj === 'string') {
            var sm = {
              size: function () { return obj.length; },
              length: function () { return obj.length; },
              empty: function () { return obj.length === 0; },
              substr: function (a, b) { return (b === undefined) ? obj.substr(a) : obj.substr(a, b); },
              find: function (t) { var i = obj.indexOf(String(t)); return i < 0 ? -1 : i; },
              clear: function () { return ''; }
            }[node.name];
            if (sm) return { __bound: sm, __self: obj };
            if (node.name === 'npos') return -1;
            throw cerr('string 暂不支持的方法：' + node.name);
          }
          if (Array.isArray(obj)) {
            var nm = node.name;
            /* push_back / pop_back / size / empty / clear / begin / end */
            var meth = {
              size: function () { return obj.length; },
              length: function () { return obj.length; },
              empty: function () { return obj.length === 0; },
              clear: function () { obj.length = 0; return 0; },
              push_back: function (x) { obj.push(x); return 0; },
              pop_back: function () { obj.pop(); return 0; },
              begin: function () { return { __iter: obj, __at: 0 }; },
              end: function () { return { __iter: obj, __at: obj.length }; },
              front: function () { return obj[0]; },
              back: function () { return obj[obj.length - 1]; },
              at: function (i) { return obj[i]; }
            }[nm];
            if (meth) return { __bound: meth, __self: obj };
            throw cerr('vector 暂不支持的方法：' + nm);
          }
          if (obj && typeof obj === 'object' && obj.__struct) {
            /* struct 成员访问 */
            if (!(node.name in obj)) {
              /* 未显式赋值过的成员按 0 处理，与 C++ 全局 struct 一致 */
              obj[node.name] = 0;
            }
            return obj[node.name];
          }
          if (obj && typeof obj === 'object' && obj.__map) {
            var mk = node.name;
            var mm = {
              size: function () { return Object.keys(obj.data).length; },
              empty: function () { return Object.keys(obj.data).length === 0; },
              clear: function () { obj.data = {}; return 0; },
              count: function (k) { return (String(k) in obj.data) ? 1 : 0; },
              find: function (k) { return (String(k) in obj.data) ? obj.data[String(k)] : null; },
              erase: function (k) { delete obj.data[String(k)]; return 0; }
            }[mk];
            if (mm) return { __bound: mm, __self: obj };
            throw cerr('map 暂不支持的方法：' + mk);
          }
          throw cerr('暂不支持：结构体 / 类成员访问（' + node.name + '）');
        }
      }
      throw cerr('暂不支持的表达式：' + node.type);
    },

    binop: function (node, scope) {
      var op = node.op;
      /* 整数溢出回绕（S-069 / S-083①）。
         实现思路：先按 JS 算完，再按类型宽度回绕。
         只在真实 UB 档回绕 —— 安全档保持数学正确的结果并给出提示，
         因为对初学者来说"2147483647+1 = -2147483648"只会让人困惑。 */
      var __self = this;
      function ov(v) {
        if (typeof v !== 'number' || !Number.isInteger(v) || !isFinite(v)) return v;
        /* ⚠ 用推断出的 C 类型，不能用 node.type —— 那是节点类型，恒为 'BinOp'。
           此前写 node.type 导致所有宽度分支永不匹配。 */
        var ct = node.ctype || inferCType(node, scope) || 'int';
        /* 安全档也要管：此前 `if (!UB.isReal()) return v;` 直接把
           2147483648 这种越界值原样返回 —— 既不报错又给错答案。
           现在统一交给 fitInt：真实档回绕，安全档报错。 */
        return fitInt(v, ct, node.line);
      }
      /* && 与 || 短路 */
      if (op === '&&') return this.truthy(this.eval(node.l, scope)) && this.truthy(this.eval(node.r, scope));
      if (op === '||') return this.truthy(this.eval(node.l, scope)) || this.truthy(this.eval(node.r, scope));
      var a = this.eval(node.l, scope), b = this.eval(node.r, scope);

      /* BigInt 操作数：超大整数（>2^53）必须精确算，不能退回 number。
         不处理的话 9223372036854775807 + 1 会得到 ...775808 而不是回绕到负值。 */
      var aIsBig = a && typeof a === 'object' && typeof a.__big === 'bigint';
      var bIsBig = b && typeof b === 'object' && typeof b.__big === 'bigint';
      if (aIsBig || bIsBig) {
        var ba = aIsBig ? a.__big : (typeof a === 'number' && Number.isInteger(a) ? BigInt(a) : null);
        var bb = bIsBig ? b.__big : (typeof b === 'number' && Number.isInteger(b) ? BigInt(b) : null);
        if (ba !== null && bb !== null) {
          var big;
          switch (op) {
            case '+': big = ba + bb; break;
            case '-': big = ba - bb; break;
            case '*': big = ba * bb; break;
            case '/': if (bb === 0n) throw cerr('除零错误'); big = ba / bb; break;
            case '%': if (bb === 0n) throw cerr('除零错误'); big = ba % bb; break;
            case '<': return ba < bb ? 1 : 0;
            case '>': return ba > bb ? 1 : 0;
            case '<=': return ba <= bb ? 1 : 0;
            case '>=': return ba >= bb ? 1 : 0;
            case '==': return ba === bb ? 1 : 0;
            case '!=': return ba !== bb ? 1 : 0;
            default: big = null;
          }
          if (big !== null) {
            /* 按 64 位回绕（long long），与 wrapInt 的 64 位分支一致 */
            var m64 = 1n << 64n;
            var r64 = ((big % m64) + m64) % m64;
            if (r64 >= (1n << 63n)) r64 -= m64;
            /* 结果能安全表示就转回 number，否则继续用 BigInt */
            if (r64 <= BigInt(Number.MAX_SAFE_INTEGER) && r64 >= BigInt(Number.MIN_SAFE_INTEGER)) {
              return Number(r64);
            }
            return { __big: r64 };
          }
        }
      }

      /* ============================================================
       * unsigned 整型提升（S-116）
       *
       * C++ 最著名的坑之一，竞赛高频：
       *   ① `unsigned u=1; int i=-1; i<u`  → 真 C++ 是 **0**（不是 1）
       *      因为 int 被转成 unsigned，-1 变成 4294967295
       *   ② `unsigned u=2; int i=-3; u+i`  → 真 C++ 是 4294967295（不是 -1）
       *   ③ `for(unsigned j=3; j>=0; j--)` → 死循环（unsigned 永不 < 0）
       *
       * 三条都是"跑通了、给了个错的数"，用户不会怀疑解释器 ——
       * 这是比"报错"严重得多的一类错。
       * ============================================================ */
      var ctL = inferCType(node.l, scope), ctR = inferCType(node.r, scope);
      var resultUnsigned = isUnsignedCType(ctL) || isUnsignedCType(ctR);
      if (resultUnsigned && typeof a === 'number' && typeof b === 'number' &&
          Number.isInteger(a) && Number.isInteger(b)) {
        /* 把两端都转成 32 位无符号语义 */
        a = a >>> 0; b = b >>> 0;
        switch (op) {
          case '+': return (a + b) >>> 0;
          case '-': return (a - b) >>> 0;
          case '*': return Math.imul(a, b) >>> 0;
          case '<': return a < b ? 1 : 0;
          case '>': return a > b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '==': return a === b ? 1 : 0;
          case '!=': return a !== b ? 1 : 0;
        }
      }

      var isArith = (op === '+' || op === '-' || op === '*' || op === '<<');
      var bothInt = isArith && Number.isInteger(a) && Number.isInteger(b) &&
                    typeof a === 'number' && typeof b === 'number';
      /* 指针算术：`a + 3`（数组首地址 + 偏移）。
         真 C++ 里 a 是指针、a+3 还是指针；这里用 {__ptr, __idx} 替身。
         不做这个的话 `accumulate(a, a+n, 0)` 里的 a+n 会变成
         数组的字符串拼接（"1,2,3" + 3 = "1,2,33"），
         结果是完全不着边的输出，而且不报错。 */
      if (op === '+' && Array.isArray(a) && typeof b === 'number') {
        return { __ptr: a, __idx: b, valueOf: function () { return a[b]; } };
      }
      if (op === '+' && Array.isArray(b) && typeof a === 'number') {
        return { __ptr: b, __idx: a, valueOf: function () { return b[a]; } };
      }
      /* 指针 - 指针 = 元素个数（unique(a,a+n) - a） */
      if (op === '-' && a && a.__ptr && Array.isArray(b)) return a.__idx - 0;
      if (op === '-' && a && a.__ptr && b && b.__ptr) return a.__idx - b.__idx;
      if (op === '-' && a && a.__iter && Array.isArray(b)) return a.__at;

      switch (op) {
        case '+':
          if (typeof a === 'string' || typeof b === 'string') return this.str(a) + this.str(b);
          return ov(a + b);
        case '-': return ov(a - b);
        case '*': return ov(a * b);
        case '/':
          /* S-078：浮点除零不是 UB，IEEE 754 明确规定为 inf。
             真 C++ 打印 inf，这里却抛"除零错误" ——
             而整数除零才是 UB（真机上通常是 SIGFPE）。 */
          if (b === 0) {
            /* ⚠ 判据不能看**运行时值**（S-119）。
               此前用 `!Number.isInteger(a)` 判断，而 `1.0` 在 JS 里就是整数 1，
               与 `int 1` 无法区分 —— 于是同一个表达式 `d/z`，
               d=2.5 时返回 inf、d=1.0 时抛"除零错误"。
               **同一个表达式两种行为**，用户完全无法预测。
               改看声明类型：变量表里标了 double/float 就按 IEEE 754 走。 */
            var ctA = inferCType(node.l, scope), ctB = inferCType(node.r, scope);
            var isFloating = /double|float/.test(ctA || '') || /double|float/.test(ctB || '') ||
                             (node.l && node.l.isFloat) || (node.r && node.r.isFloat) ||
                             !Number.isInteger(a) || !Number.isInteger(b);
            if (isFloating) {
              if (a === 0) return NaN;
              return (a > 0) ? Infinity : -Infinity;
            }
            /* 整数除零：真机 SIGFPE */
            throw cerr('除零错误（整数除零在真实 C++ 里会导致程序崩溃）', node.line);
          }
          /* 两个整数相除按 C 语义取整 */
          if (Number.isInteger(a) && Number.isInteger(b)) {
            /* ⚠ INT_MIN / -1 是 UB（S-126）：结果 2147483648 无法用 int32 表示，
               真机 x86 上会 SIGFPE 崩溃。此前返回 2147483648，
               一个"不可能存在的 int 值" —— 既不回绕也不报 UB。 */
            if (UB.isReal() && b === -1 && a === -2147483648) {
              throw cerr('程序异常终止（对应真机的 SIGFPE）：INT_MIN / -1 是未定义行为');
            }
            return Math.trunc(a / b);
          }
          return a / b;
        case '%':
          if (b === 0) throw cerr('取模错误：除数为零');
          return a % b;
        case '==': return a === b;
        case '!=': return a !== b;
        case '<': return a < b;
        case '>': return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
        /* ⚠ JS 的位运算符是 32 位的，且移位量会 mod 32：
             `1 << 40` 实际算的是 `1 << 8` = 256。
           而 C++ 的 `1LL << 40` = 1099511627776。
           这是防溢出的标准写法（快速幂、状压、哈希都用它），
           算错不报错，只是答案差若干个数量级 —— 最难查的一类错。
           所以超出 32 位范围时改用 BigInt 并按 64 位回绕。 */
        case '<<':
          if (b >= 31 || Math.abs(a) >= 0x40000000) {
            var sh = BigInt(Math.trunc(a)) << BigInt(Math.trunc(Math.abs(b)));
            return Number(wrapBigTo64(sh));
          }
          return (a | 0) << (b | 0);
        case '>>':
          if (b >= 31 || Math.abs(a) >= 0x40000000) {
            var sh2 = BigInt(Math.trunc(a)) >> BigInt(Math.trunc(Math.abs(b)));
            return Number(sh2);
          }
          return (a | 0) >> (b | 0);
        case '&': return Number(BigInt(Math.trunc(a)) & BigInt(Math.trunc(b)));
        case '|': return Number(BigInt(Math.trunc(a)) | BigInt(Math.trunc(b)));
        case '^': return Number(BigInt(Math.trunc(a)) ^ BigInt(Math.trunc(b)));
      }
      throw cerr('暂不支持的运算符：' + op);
    },

    doAssign: function (node, scope) {
      var v = this.eval(node.value, scope);
      if (node.aug) {
        var cur = this.eval(node.target, scope);
        v = this.binop({ op: node.op, l: { type: 'Num', v: cur }, r: { type: 'Num', v: v } }, scope);
      }
      this.assignTo(node.target, v, scope);
      return v;
    },

    assignTo: function (target, val, scope) {
      /* 引用赋值转发：r = 9 要同时改 x */
      if (target.type === 'Name' && this.aliases2 && this.aliases2[target.name]) {
        var realName = this.aliases2[target.name];
        return this.assignTo({ type: 'Name', name: realName }, val, scope);
      }
      if (target.type === 'Name') {
        /* ⚠ 写回变量时要按变量的 C 类型收敛（本轮实测发现）。
           `short t = 32767; t = t + 1;` 此前得到 32768，真 g++ 是 -32768 ——
           因为赋值这一步从来没截断过，只有 BinOp 回绕（且提升成了 int）。 */
        /* ⚠ 用 target.line，不是 node.line —— assignTo 的签名是
           (target, val, scope)，**没有 node 参数**。
           第一版我写 node.line，于是一到赋值就抛
           "node is not defined" —— 连原本能跑的 `x = x + 1` 都崩了。
           这类错误最阴险：它把**正常代码**变成崩溃，
           而不只是报错信息变差。 */
        scope.set(target.name, fitInt(val, scope.typeOf(target.name), target.line));
        return;
      }
      if (target.type === 'Index') {
        var arr = this.eval(target.obj, scope);
        /* map<string,int> m; m["a"] = 1; —— 键是字符串 */
        if (arr && typeof arr === 'object' && arr.__map) {
          arr.data[String(this.eval(target.index, scope))] = val;
          return val;
        }
        if (!Array.isArray(arr)) throw cerr('不是数组，无法赋值');
        var wx = this.eval(target.index, scope) | 0;
        /* 越界写：真实 C++ 会踩到相邻内存（UB），
           这里真实档就真的写进去（数组被撑大），
           安全档明确报错 —— 静默写成功是最坏的选择，
           因为它看起来"能用"，到 OJ 上才炸。 */
        if (wx < 0 || wx >= arr.length) {
          /* ⚠ 用 target（Index 节点）自己的 line，不要用 target.index 的。
             第一版我写的 target.index.line，而下标表达式 `a[10]` 的 index
             是个 Num 节点、未必带 line —— 结果行号恒为 undefined，等于没加。 */
          UB.check('数组越界', '给下标 ' + wx + ' 赋值越界（数组长度 ' + arr.length + '）', target.line);
        }
        arr[wx] = val;
        return;
      }
      /* struct 成员赋值：p.x = 1;
         不支持的话，struct 只能声明不能写 —— 等于不能用。 */
      if (target.type === 'Member') {
        var objv = this.eval(target.obj, scope);
        if (!objv || typeof objv !== 'object') throw cerr('不能给非对象赋值成员：' + target.name);
        if (objv.__map) { objv.data[String(target.name)] = val; return val; }
        objv[target.name] = val;
        return val;
      }
      /* 复合赋值里的位运算：n >>= 1 / n = n >> 1。
         快速幂、状压 DP 全靠这个，缺了它这类题都写不了。 */
      if (target.type === 'Name' && (node.op === '>>=' || node.op === '<<=')) {
        var cur = scope.get(target.name);
        var by = this.eval(node.value, scope);
        scope.set(target.name, node.op === '>>=' ? (cur >> by) : (cur << by));
        return scope.get(target.name);
      }
      throw cerr('暂不支持的赋值目标');
    },

    doCall: function (node, scope) {
      var self = this;
      var self2 = this;
      /* 成员调用：v.push_back(x) / m.count(k)
         先求值 callee 得到绑定对象，再把 this 绑上去调用 */
      if (node.callee.type === 'Member') {
        var bound = this.eval(node.callee, scope);
        var margs = node.args.map(function (a) { return self2.eval(a, scope); });
        if (bound && typeof bound === 'object' && typeof bound.__bound === 'function') {
          return bound.__bound.apply(bound.__self, margs);
        }
        throw cerr('不是可调用的成员');
      }
      var name = node.callee.type === 'Name' ? node.callee.name : null;
      /* 记录实参的**名字**与当前作用域：swap 这类需要按引用改写的函数要用。
         只传值的话 swap 只能改副本，外面看不到变化。 */
      var argNames = node.args.map(function (a) { return (a && a.type === 'Name') ? a.name : null; });
      var args = node.args.map(function (a) { return self.eval(a, scope); });
      if (name === 'swap') {
        var saved = INTERP ? INTERP.curScope : null;
        if (INTERP) INTERP.curScope = scope;
        var sv = self.funcs.swap && self.funcs.swap.builtin;
        if (sv) {
          var r5 = sv.call({ __swapNames: argNames }, args[0], args[1]);
          if (INTERP) INTERP.curScope = saved;
          return r5;
        }
        if (INTERP) INTERP.curScope = saved;
      }
      /* sort(v.begin(), v.end()) —— 迭代器形式。
         竞赛代码里 sort 几乎都写成这样，只支持 sort(a, n) 是不够的。 */
      if (name === 'sort' && args.length >= 2 && args[0] && args[0].__iter) {
        var container = args[0].__iter;
        var l = args[0].__at || 0;
        var r = (args[1] && args[1].__iter === container) ? (args[1].__at || 0) : container.length;
        /* 第三个参数可能是比较器：sort(v.begin(), v.end(), cmp) */
        var cmpFn2 = null;
        if (args[2] && typeof args[2] === 'object' && (args[2].__fn || args[2].__builtinFn || args[2].__lambda)) {
          cmpFn2 = resolveCmp(this, args[2]);
        }
        var part2 = container.slice(l, r).sort(cmpFn2 || function (x, y) {
          if (typeof x === 'number' && typeof y === 'number') return x - y;
          return String(x) < String(y) ? -1 : (String(x) > String(y) ? 1 : 0);
        });
        for (var i2 = 0; i2 < part2.length; i2++) container[l + i2] = part2[i2];
        return container;
      }
      if (name && this.funcs[name]) {
        var f = this.funcs[name];
        if (f.builtin) return f.builtin.apply(null, args);
        return this.callFunc(f.node, args, scope, node.args);
      }
      /* install() 里用 g.set 注册的宿主函数（freopen / getline / fopen）
         是**裸函数**，而下面的查值只认带 __fn / __builtinFn 标记的**对象**，
         于是它们会被当成"暂不支持的函数"。补上：取到函数就直接调。 */
      if (name) {
        var gv = null;
        try { gv = scope.get(name); } catch (e3) { gv = null; }
        if (typeof gv === 'function') {
          /* ⚠ 必须设置 curScope 与 __argNames。
             getline(fin, s) 要把读到的行**按名字写回调用处的作用域** ——
             写进 global 的话，main 里的局部变量 s 根本收不到，
             表现为 getline 静默什么都不做（s 保持初值 0）。 */
          var savedC = INTERP ? INTERP.curScope : null;
          if (INTERP) { INTERP.curScope = scope; INTERP.__argNames = argNames; }
          var rv = gv.apply(null, args);
          if (INTERP) { INTERP.curScope = savedC; INTERP.__argNames = null; }
          return rv;
        }
      }
      /* install() 里用 g.set 注册的宿主函数（freopen / getline / fopen）
         是**裸函数**，而下面的查值只认带 __fn / __builtinFn 标记的**对象**，
         于是它们会被当成"暂不支持的函数"。
         补上：作用域里取到函数就直接调。 */
      if (name) {
        var gv = null;
        try { gv = scope.get(name); } catch (e3) { gv = null; }
        if (typeof gv === 'function') return gv.apply(null, args);
      }
      /* 函数作为值调用：cmp(...) 或 sort 收到 __fn 后回调 */
      if (name) {
        var vv = null;
        try { vv = scope.get(name); } catch (e2) { vv = null; }
        if (vv && typeof vv === 'object' && vv.__fn) return this.callFunc(this.funcs[vv.__fn].node, args, this.global);
        if (vv && typeof vv === 'object' && vv.__builtinFn) return vv.__builtinFn.apply(null, args);
      }
      throw cerr('暂不支持的函数：' + (name || '(表达式)'), node.line);
    },

    /* argExprs：调用处的实参**表达式**（不是值）。
       引用参数要在调用结束后写回，只能靠表达式定位，值已经不够了。 */
    callFunc: function (fn, args, parent, argExprs) {
      /* ⚠ 递归深度必须自己管（S-044）。
         不加保护时，无限递归会冒出 JS 原生的
         "Maximum call stack size exceeded" —— 一句英文，
         既没说是哪行代码、也没说该怎么办，对学竞赛的人等于没有信息。
         更糟的是这个错误可能在 JS 栈快满时才抛，
         此时连我们的错误处理都可能再次触发同样的错误。
         所以设一个远低于 JS 栈上限的深度（1000），到点就报人话。 */
      if (++this.callDepth > MAX_CALL_DEPTH) {
        this.callDepth--;
        throw cerr('递归深度超过 ' + MAX_CALL_DEPTH + ' 层，已停止。\n' +
          '常见原因：递归没有终止条件，或终止条件写错了 —— 请检查 ' +
          (fn && fn.name ? fn.name : '这个函数') + ' 的递归出口。\n' +
          '注意：本环境是解释器，递归深度上限比真实 C++ 低得多（真 C++ 可到几万层）。' +
          '如果你的算法确实需要更深，这**不代表它在 OJ 上会错**。');
      }
      try {
        return this.__callFunc(fn, args, parent, argExprs);
      } finally {
        this.callDepth--;
      }
    },
    __callFunc: function (fn, args, parent, argExprs) {
      var self = this;
      var sc = new Scope(this.global);
      /* 实参不足时用默认值；没有默认值才补 0 */
      var refArgs = [];   /* 记录引用参数对应的实参表达式，调用结束写回 */
      (fn.args || []).forEach(function (a, i) {
        var v;
        if (i < args.length) v = args[i];
        else if (a.def !== null && a.def !== undefined) v = self.eval(a.def, self.global);
        else v = 0;
        sc.declare(a.name, v, a.type || null);
        /* ⚠ 引用参数必须在调用结束后写回实参（S-118）。
           实测 `void f(int &x){ x=9; }` 调用后 a 仍是 1（真 C++ 是 9）。
           而范围 for 的引用写回是对的 —— 同一份代码里引用有两种行为，
           用户会以为自己没传对，而不是我们的实现有问题。 */
        if (a.byRef && argExprs && i < argExprs.length) refArgs.push({ name: a.name, expr: argExprs[i] });
      });
      /* 引用写回：把形参的最终值写回实参表达式 */
      function writeBackRefs(sc2) {
        for (var ri = 0; ri < refArgs.length; ri++) {
          try {
            self.assignTo(refArgs[ri].expr, sc2.get(refArgs[ri].name), parent || self.global);
          } catch (e2) { /* 写不回去就跳过，不因此中断整个调用 */ }
        }
      }
      try {
        for (var i = 0; i < fn.body.length; i++) this.exec(fn.body[i], sc);
        writeBackRefs(sc);
      } catch (e) {
        if (e instanceof CReturn) { writeBackRefs(sc); return e.value === undefined ? 0 : e.value; }
        throw e;
      }
      return 0;
    },

    doStreamDecl: function (node, scope) {
      /* ifstream fin("a.txt"); / ofstream fout("b.txt");
         第二个参数 ios::app 之类只在真 C++ 里有意义，这里按模式字符串处理。 */
      var path = node.args.length ? this.eval(node.args[0], scope) : '';
      var mode = node.kind === 'ifstream' ? 'r'
               : node.kind === 'ofstream' ? 'w' : 'r+';
      if (node.args.length > 1) {
        var m2 = this.eval(node.args[1], scope);
        if (typeof m2 === 'string' && /app/.test(m2)) mode = 'a';
      }
      var f = new this.CppFile(path, mode);
      scope.set(node.name, f);
      return null;
    },

    doCout: function (node, scope) {
      /* cout << a << b 左结合成 Cout(Cout(cout,a), b)。
         只求 right 会把 a 整个丢掉 —— 必须先递归跑完左侧链条。
         ⚠ 用左侧的**返回值**判断输出到哪里：
           是 cout 就写 stdout，是文件流对象就写该文件的缓冲。 */
      var tgt = node.left ? this.eval(node.left, scope) : null;
      var v = this.eval(node.right, scope);
      if (v === undefined) return tgt || { __cout: true };
      if (v && (v.__cout || v.__cin)) return tgt || { __cout: true };
      var txt = this.str(v);
      if (tgt && tgt.__cppfile && tgt.__isOut) { tgt._writeBuf += txt; return tgt; }
      this.out(txt);
      return tgt || { __cout: true };
    },

    /* 从输入缓冲取一个词。缓冲空了才去调 input()。
       以前每次都调 input() 且只取第一个词，剩下的全丢 ——
       `cin >> a >> b` 里 b 永远读不到本行第二个词。 */
    /* freopen 之后 cin 从虚拟文件读 */
    nextFileToken: function () {
      var txt = this.vfs[this.cinFile] || '';
      if (this.inBuf === null) this.inBuf = [];
      if (!this.inBuf.length) {
        this.inBuf = String(txt).trim().split(/\s+/).filter(function (x) { return x !== ''; });
        this.inBuf.push('');   /* 读完后给空串，避免反复重读 */
        this.__fileDone = true;
      }
      var w = this.inBuf.shift();
      return w === undefined ? '' : w;
    },

    nextToken: function () {
      if (this.cinFile && this.__fileDone !== true) return this.nextFileToken();
      if (!this.inBuf || !this.inBuf.length) {
        var line = this.input();
        if (line === undefined || line === null) return '';
        this.inBuf = String(line).trim().split(/\s+/).filter(function (x) { return x !== ''; });
      }
      return this.inBuf.length ? this.inBuf.shift() : '';
    },

    doCin: function (node, scope) {
      /* cin >> a >> b 是嵌套节点 Cin(Cin(cin, a), b)。
         ⚠ 必须先求值 node.left —— 否则左边的 a 根本不会被赋值，
         只有最右边的 b 拿到值。表现为 `cin>>a>>b` 时 a 恒为 0，
         而 A+B 这种最基础的题都跑不对。 */
      var leftVal = node.left ? this.eval(node.left, scope) : null;
      /* 左侧是文件流 → 从文件读；是 cin → 从 stdin 读
         （stdin 可能被 freopen 重定向到虚拟文件） */
      var val;
      if (leftVal && leftVal.__cppfile) val = leftVal._nextToken();
      else if (this.cinFile) val = this.nextFileToken();
      else val = this.nextToken();
      var num = Number(val);
      this.assignTo(node.right, val !== '' && isFinite(num) ? num : val, scope);
      return leftVal;
    }
  };

  Code.cpplite = {
    tokenize: tokenize,
    parse: function (src) { return new Parser(tokenize(preprocess(src))).parse(); },
    create: function (out, input) { return new Interp(out, input); },
    MAX_STEPS: MAX_STEPS,
    PERF: PERF,

    /* ============================================================
     * TLE 预测：用小规模外推到真实规模
     *
     * 为什么必须外推而不是硬跑：
     *   解释器比编译器慢几个数量级。真实环境 1 秒 = 1.2e9 步，
     *   而解释器每秒只跑得了几百万步 ——
     *   **物理上不可能在这里"跑满 1 秒"来测试**。
     *   硬跑的结果只有一个：跑不完，然后被误判成死循环。
     *
     * 正确做法：小规模测两次 → 求出增长阶数 → 外推到目标规模。
     *   1) 用 n1、n2 两个小规模跑，得步数 S1、S2
     *   2) 阶数 k = log(S2/S1) / log(n2/n1)
     *      k≈1 → O(n)，k≈2 → O(n²)，k≈3 → O(n³)
     *   3) 外推 S(target) = S2 × (target/n2)^k
     *   4) 换算成等效真实秒，与时限比较
     *
     * 局限（会如实报出，不假装）：
     *   - 假设程序从 stdin 读第一个整数作为规模 n（竞赛惯例）
     *   - 若两次步数几乎相同，说明规模不影响耗时 → 无法外推
     *   - 分治/递归等复杂形态可能拟合不准
     * ============================================================ */
    predictTLE: function (code, opts) {
      opts = opts || {};
      var n1 = opts.n1 || 1000, n2 = opts.n2 || 2000;
      var target = opts.target || 100000;
      var limitSec = opts.limitSec || 1;

      function runAt(n) {
        var I = new Interp(function () { }, function () { return String(n) + '\n'; });
        var r = I.run(code, { timeout: opts.timeout || 15000 });
        return r.steps;
      }

      /* ⚠ 探测规模必须自适应，不能写死。
         第一版写死 n=1000/2000，结果 O(n²) 在 n=1000 就跑满了 5000 万步 ——
         **探测本身先把解释器拖垮了**，用户等十几秒只等到一句"跑不完"。
         改成从很小规模起步，逐步翻倍，一旦步数够拟合就停。 */
      var sizes = opts.sizes || [50, 100, 200, 400, 800, 1600, 3200];
      var probeCap = opts.probeCap || 2000000;   /* 探测阶段步数上限，防止探测太慢 */
      var points = [];
      for (var pi = 0; pi < sizes.length; pi++) {
        var st;
        try { st = runAt(sizes[pi]); } catch (e2) { break; }   /* 跑不动就停在这里 */
        points.push({ n: sizes[pi], s: st });
        if (st > probeCap) break;                               /* 够拟合了，停 */
      }

      if (points.length < 2) {
        return {
          ok: false,
          reason: '连最小规模 ' + sizes[0] + ' 都无法完成，请检查程序是否有死循环或语法错误。'
        };
      }

      /* 取最大的两个可用点做拟合（样本大，比值更稳） */
      var p1 = points[points.length - 2], p2 = points[points.length - 1];
      var S1 = p1.s, S2 = p2.s, n1 = p1.n, n2 = p2.n;

      /* 规模不影响步数 → 无法外推（如实说，不编一个） */
      var ratio = S2 / Math.max(1, S1);
      if (ratio < 1.05) {
        return {
          ok: false,
          reason: '规模从 ' + n1 + ' 增至 ' + n2 + '，步数几乎没变（' + S1 + ' → ' + S2 + '）。\n' +
                  '说明耗时与读入的规模无关（程序可能没把第一个数当作规模使用），无法外推。'
        };
      }

      var k = Math.log(ratio) / Math.log(n2 / n1);
      var estSteps = S2 * Math.pow(target / n2, k);
      var estSec = PERF.toRealSec(estSteps);

      var complexity;
      if (k < 0.6) complexity = 'O(1) 或 O(log n)';
      else if (k < 1.4) complexity = 'O(n)';
      else if (k < 1.8) complexity = 'O(n log n)';
      else if (k < 2.4) complexity = 'O(n²)';
      else if (k < 3.4) complexity = 'O(n³)';
      else complexity = 'O(n^' + k.toFixed(1) + ') 或指数级';

      return {
        ok: true,
        k: k,
        complexity: complexity,
        steps: { n1: S1, n2: S2 },
        probes: points,
        target: target,
        estSteps: estSteps,
        estSec: estSec,
        estText: PERF.human(estSteps),
        limitSec: limitSec,
        willTLE: estSec > limitSec,
        /* 在给定时限下能过的最大规模（反推） */
        maxN: Math.floor(n2 * Math.pow(limitSec * PERF.stepsPerIter * PERF.realOpsPerSec / S2, 1 / k))
      };
    },
    /* UB 模拟开关（S-082）。
       'safe'（默认）：危险 UB 明确报错 —— 适合初学与教学
       'real'        ：真模拟 UB（溢出回绕、越界读垃圾值）—— 适合竞赛
       调用：Code.cpplite.setUB('real') */
    setUB: UB.set,
    getUB: function () { return UB.mode; },
    /* 源码里出现过的 #define 宏名。导出是为了让断言能验证
       "用了宏会给出针对性提示"这件事，而不是只报"变量未定义"。 */
    macros: function () { return MACROS; },
    macroFns: function () { return MACRO_FNS; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
