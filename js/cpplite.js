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
    check: function (kind, msg) {
      if (UB.isReal()) return true;
      throw cerr('暂不支持（安全模式）：' + msg + '。' +
        '切换到「真实 UB」模式可模拟真实 C++ 的行为（' + kind + '）');
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
    if (r2 >= mod / 2) r2 -= mod;
    return r2;
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
  function collectAndStripMacros(src) {
    var lines = src.split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var tr = ln.replace(/^\s+/, '');
      if (tr.charAt(0) !== '#') { out.push(ln); continue; }
      var body = tr.slice(1);
      var dm = /^\s*define\s+([A-Za-z_]\w*)/.exec(body);
      if (dm) {
        var name = dm[1];
        var rest = body.slice(dm[0].length);
        /* 宏函数：名字后紧跟着左括号（不能有空格，这是 C 的规定） */
        if (/^\s*\(/.test(rest) && !/^\s*\(\s*\)/.test(rest)) {
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
      /* #ifdef / #pragma 等：明确不支持，但只在用到条件编译分支时才可能出错，
         这里静默跳过（条件编译在竞赛里相对少见，且不影响主流程） */
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
              /* 参数替换要保留运算优先级：包一层括号更稳妥 */
              rep = rep.replace(new RegExp('\\b' + mf.params[a] + '\\b', 'g'), '(' + av + ')');
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
    MACROS = {}; MACRO_FNS = {};
    var stripped = collectAndStripMacros(src);
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

  function tokenize(src) {
    var t = [], i = 0, n = src.length;
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
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
        i = j0;
        continue;
      }
      /* 注释 */
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }

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
        t.push({ t: q === '"' ? 'STR' : 'CHAR', v: buf });
        continue;
      }
      /* 数字 */
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        var m = /^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i));
        /* ⚠ parseFloat 会把 1.0 变成整数 1，浮点性就此丢失。
           于是 `1.0/0` 被当成整数除零而报错，真 C++ 却是 inf。
           保留原始文本，供后面判断"这个字面量是浮点还是整数"。 */
        t.push({ t: 'NUM', v: parseFloat(m[0]), raw: m[0] });
        i += m[0].length;
        continue;
      }
      /* 标识符 */
      if (/[A-Za-z_]/.test(c)) {
        var m2 = /^[A-Za-z_]\w*/.exec(src.slice(i));
        var w = m2[0];
        t.push({ t: (TYPES.indexOf(w) >= 0 ? 'TYPE' : KEYWORDS.indexOf(w) >= 0 ? 'KW' : 'NAME'), v: w });
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
        t.push({ t: 'OP', v: hit });
        i += hit.length;
        continue;
      }
      throw cerr('无法识别的字符：' + c);
    }
    t.push({ t: 'EOF' });
    return t;
  }

  function cerr(msg) { return new Error(msg); }

  /* ============================================================
   * 二、语法分析
   * ============================================================ */
  /* 容器类型识别：vector<int> / map<string,int> / set<int>。
     这些名字不在 TYPES 里，走普通声明解析会当成表达式，
     报"读到意外的 int"——用户看不出这是"不支持 vector"。
     所以单独识别，并明确告诉用户支持到什么程度。 */
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
      if (t.t === 'OP' && t.v === '<') depth++;
      if (t.t === 'OP' && t.v === '>') { depth--; if (depth === 0) { parser.p++; break; } }
      elem.push(t.v); parser.p++;
    }
    if (depth !== 0) { parser.p = save; return null; }
    /* 后面必须跟标识符才是声明 */
    if (!parser.at('NAME')) { parser.p = save; return null; }
    return { kind: kind, elem: elem.join('') };
  }

  function Parser(t) { this.t = t; this.p = 0; }
  Parser.prototype = {
    peek: function (k) { return this.t[this.p + (k || 0)]; },
    next: function () { return this.t[this.p++]; },
    at: function (type, val) { var t = this.peek(); return t && t.t === type && (val === undefined || t.v === val); },
    atOp: function (v) { return this.at('OP', v); },
    eat: function (type, val) { if (this.at(type, val)) { this.p++; return true; } return false; },
    expect: function (type, val) {
      if (!this.eat(type, val)) {
        var t = this.peek();
        throw cerr('语法错误：期望 ' + (val || type) + '，实际读到 ' + (t ? (t.v !== undefined ? t.v : t.t) : '文件结束'));
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
        init = this.assign();
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
      if (!this.at('NAME')) throw cerr('struct 后面需要名字');
      var name = this.next().v;
      /* 前置声明 struct P; —— 只登记名字，成员未知 */
      if (this.eat('OP', ';')) return { type: 'StructDecl', name: name, fields: null };
      this.expect('OP', '{');
      var fields = [];
      while (!this.atOp('}') && !this.at('EOF')) {
        /* 成员声明：类型 名字;  —— 同样支持 long long */
        while (this.at('TYPE') && (this.peek().v === 'const' || this.peek().v === 'unsigned' || this.peek().v === 'signed')) this.p++;
        var ftype = this.at('TYPE') ? this.next().v : 'int';
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
      if (this.at('KW', 'namespace') || this.at('KW', 'template')) throw cerr('暂不支持：' + this.peek().v);
      if (this.at('KW', 'struct') || this.at('KW', 'class')) {
        return this.structDecl();
      }
      if (this.at('KW', 'enum') || this.at('KW', 'union')) {
        throw cerr('暂不支持：' + this.peek().v + '（本环境只支持基础类型、数组与函数）');
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
      if (!this.at('TYPE') && !this.at('NAME')) throw cerr('无法识别的声明');
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
      var nameTok = this.peek();
      if (!this.at('NAME')) throw cerr('期望标识符，实际读到 ' + (nameTok && nameTok.v));
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
        var ty = this.at('TYPE') ? this.next().v : 'auto';
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
          case 'try': case 'catch': case 'throw': throw cerr('暂不支持：' + t.v);
          case 'new': case 'delete': throw cerr('暂不支持：' + t.v + '（本环境无动态内存）');
        }
      }
      /* using namespace std; */
      if (this.at('KW', 'using')) { while (!this.atOp(';') && !this.at('EOF')) this.p++; this.eat('OP', ';'); return null; }
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
        if (this.atOp('*')) throw cerr('暂不支持：指针（本环境无地址与内存操作）');
        /* 引用变量 `int &r = x;`
           本环境没有真地址，用"绑定名"实现：记录别名 → 真实变量名，
           读写都转发到原变量。`r = 9` 之后 x 也变成 9 ——
           这才是引用的语义。直接报错的话，
           凡是用引用传参的函数都得改写，代码就不是原样了。 */
        var refTarget = null;
        if (this.atOp('&')) { this.p++; var rt = this.peek(); if (rt && rt.t === 'NAME') refTarget = rt.v; }
        if (!this.at('NAME')) throw cerr('期望标识符，实际读到 ' + (this.peek().v || this.peek().t));
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
      while (this.atOp('|')) { this.p++; l = { type: 'BinOp', op: '|', l: l, r: this.bitXor() }; }
      return l;
    },
    bitXor: function () {
      var l = this.bitAnd();
      while (this.atOp('^')) { this.p++; l = { type: 'BinOp', op: '^', l: l, r: this.bitAnd() }; }
      return l;
    },
    bitAnd: function () {
      var l = this.equality();
      while (this.atOp('&')) { this.p++; l = { type: 'BinOp', op: '&', l: l, r: this.equality() }; }
      return l;
    },
    equality: function () {
      var l = this.relational();
      while (this.atOp('==') || this.atOp('!=')) { var op = this.next().v; l = { type: 'BinOp', op: op, l: l, r: this.relational() }; }
      return l;
    },
    relational: function () {
      var l = this.shift();
      while (this.atOp('<') || this.atOp('>') || this.atOp('<=') || this.atOp('>=')) { var op = this.next().v; l = { type: 'BinOp', op: op, l: l, r: this.shift() }; }
      return l;
    },
    shift: function () {
      var l = this.additive();
      while (this.atOp('<<') || this.atOp('>>')) { var op = this.next().v; l = { type: 'BinOp', op: op, l: l, r: this.additive() }; }
      return l;
    },
    additive: function () {
      var l = this.multiplicative();
      while (this.atOp('+') || this.atOp('-')) { var op = this.next().v; l = { type: 'BinOp', op: op, l: l, r: this.multiplicative() }; }
      return l;
    },
    multiplicative: function () {
      var l = this.unary();
      while (this.atOp('*') || this.atOp('/') || this.atOp('%')) { var op = this.next().v; l = { type: 'BinOp', op: op, l: l, r: this.unary() }; }
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
      if (this.atOp('&')) throw cerr('暂不支持：取地址');
      if (this.at('KW', 'sizeof')) throw cerr('暂不支持：sizeof');
      if (this.at('KW', 'new')) throw cerr('暂不支持：new');
      return this.postfix();
    },
    postfix: function () {
      var e = this.primary();
      while (true) {
        if (this.atOp('(')) {
          this.p++;
          var args = [];
          while (!this.atOp(')')) { args.push(this.assign()); if (!this.eat('OP', ',')) break; }
          this.expect('OP', ')');
          e = { type: 'Call', callee: e, args: args };
          continue;
        }
        if (this.atOp('[')) {
          this.p++;
          var idx = this.expr();
          this.expect('OP', ']');
          e = { type: 'Index', obj: e, index: idx };
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
            return { type: 'Name', name: n2, std: true };
          }
        }
        this.p++;
        return { type: 'Name', name: nm };
      }
      throw cerr('语法错误：读到意外的 ' + (t.v !== undefined ? t.v : t.t));
    }
  };

  /* ============================================================
   * 三、执行
   * ============================================================ */
  var MAX_STEPS = 2000000;

  function Scope(parent) { this.v = {}; this.parent = parent || null; }
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
  Scope.prototype.declare = function (n, val) { this.v[n] = val; };

  /* 控制流信号用异常实现。
     ⚠ 必须带可识别的标记 —— 否则 switch / 循环分不清是哪个信号，
     只能靠 `instanceof` 或字符串比较，容易漏。
     给每个信号一个 __break / __continue / __return 标记，
     捕获方一眼能认出来。 */
  function CBreak() { this.__break = true; }
  function CContinue() { this.__continue = true; }
  function CReturn(v) { this.value = v; this.__return = true; }

  function Interp(out, input) {
    this.out = out || function () { };
    this.input = input || function () { return ''; };
    this.steps = 0;
    this.deadline = 0;
    this.global = new Scope(null);
    this.funcs = {};

    this.inBuf = [];   /* cin 的输入词缓冲，跨多次 >> 共享 */

    this.structs = {};   /* struct 名 → 字段列表 */
    this.install();
  }

  Interp.prototype = {
    tick: function () {
      if (++this.steps > MAX_STEPS) throw cerr('执行步数超过 ' + MAX_STEPS + ' 步，已中断（可能存在死循环）');
      if (this.deadline && Date.now() > this.deadline) throw cerr('执行超时，已中断（可能存在死循环）');
    },

    install: function () {
      var self = this;
      var g = this.global;
      g.set('cout', { __cout: true });
      g.set('cin', { __cin: true });
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
        builtin: function (a, b, c) {
          if (!Array.isArray(a)) throw cerr('sort 的第一个参数必须是数组');
          var arr = a;
          var l = 0, r = arr.length;
          if (typeof b === 'number') {
            /* sort(a, n)：第二个参数是个数 */
            if (c === undefined) { l = 0; r = Math.min(b, arr.length); }
            /* sort(a, l, r)：左闭右开区间 */
            else { l = b; r = Math.min(c, arr.length); }
          }
          var part = arr.slice(l, r).sort(function (x, y) {
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
      this.funcs.swap = {
        builtin: function (a, b) {
          /* swap(a[i], a[j]) 形式：传进来已经是值，改不了 —— 明确告知 */
          if (!Array.isArray(a)) throw cerr('swap 需要数组形式：swap(a[i], a[j]) 在本环境不支持（无法按引用传值），请手写临时变量');
          return a;
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
      if (typeof v === 'number') {
        if (Number.isInteger(v)) return String(v);
        return String(Math.round(v * 1e10) / 1e10);
      }
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return '[' + v.map(this.str, this).join(', ') + ']';
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
      tree.body.forEach(function (n) {
        if (n.type === 'VarDecl') self.exec(n, g);
      });
      this.callFunc(main, [], g);
      return { steps: this.steps };
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
              for (var ci = 0; ci < cnt; ci++) val2.push(fill);
            } else if (node.init) {
              var iv = self.eval(node.init, scope);
              if (Array.isArray(iv)) val2 = iv.slice();
            }
          }
          scope.declare(node.name, val2);
          return null;
        }

        /* struct 变量：按登记的字段建对象，数值字段默认 0 */
        case 'StructVarDecl': {
          var fields = self.structs[node.typeName] || [];
          var mkInst = function () {
            var o = { __struct: true, __type: node.typeName };
            fields.forEach(function (f) {
              o[f.name] = (f.type === 'char') ? '' : (f.type === 'string' ? '' : 0);
            });
            return o;
          };
          if (node.sizes) {
            var cnt2 = self.eval(node.sizes[0] || { type: 'Num', v: 0 }, scope) | 0;
            var arr2 = [];
            for (var si = 0; si < cnt2; si++) arr2.push(mkInst());
            scope.declare(node.name, arr2);
          } else {
            scope.declare(node.name, mkInst());
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
            }
            scope.declare(d.name, val);
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
        if (++n > 1000000) throw cerr('循环次数过多，已中断（可能存在死循环）');
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
        if (++n > 1000000) throw cerr('循环次数过多，已中断（可能存在死循环）');
        try { this.execBody(node.body, sc); } catch (e) {
          if (e instanceof CBreak) break;
          if (e instanceof CContinue) continue;
          throw e;
        }
      }
      return null;
    },

    truthy: function (v) {
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
        case 'Num': return node.v;
        case 'Str': return node.v;
        case 'Char': return node.v;
        case 'InitList': return node.elts.map(function (e) { return self.eval(e, scope); });
        case 'Bool': return node.v;
        case 'Null': return null;
        case 'Name':
          try { return scope.get(node.name); } catch (e) {
            /* 与 Scope.get 里同样的宏提示。
               表达式里用到宏（`int x = N;`）走的是这里，
               只在 Scope.get 里加提示的话，这个最常见的场景反而漏了。 */
            if (MACROS[node.name]) {
              throw cerr('变量未定义：' + node.name + '。' +
                '注意：源码里有 #define ' + node.name + '，' +
                '本环境暂不支持预处理宏，请用常量或 enum 代替');
            }
            throw cerr('变量未定义：' + node.name);
          }
        case 'BinOp': return this.binop(node, scope);
        /* Logic 节点（&& / ||）与 BinOp 是两种节点类型。
           只接了 BinOp 的话，`a==0 || b==1` 这种最常见的条件判断
           会报"暂不支持的表达式：Logic" —— 而它在 if 里无处不在。 */
        case 'Logic': return this.binop(node, scope);
        case 'Cast': {
          var cv = this.eval(node.v, scope);
          if (node.ctype === 'int' || node.ctype === 'long' || node.ctype === 'long long' ||
              node.ctype === 'short' || node.ctype === 'char' || node.ctype === 'unsigned') {
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
            UB.check('数组越界', '下标 ' + ix + ' 越界（数组长度 ' + arr.length + '）');
            return undefined;
          }
          return arr[ix];
        }
        case 'Call': return this.doCall(node, scope);
        case 'Cout': return this.doCout(node, scope);
        case 'Cin': return this.doCin(node, scope);
        /* vector 的方法。竞赛里 vector 用得极多，
           而它的 .size() / .push_back() 都是成员调用 ——
           不支持成员访问，等于 vector 整体不可用。 */
        case 'Member': {
          var obj = this.eval(node.obj, scope);
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
        if (!UB.isReal()) return v;
        if (typeof v !== 'number' || !Number.isInteger(v) || !isFinite(v)) return v;
        return wrapInt(v, node.type || 'int');
      }
      /* && 与 || 短路 */
      if (op === '&&') return this.truthy(this.eval(node.l, scope)) && this.truthy(this.eval(node.r, scope));
      if (op === '||') return this.truthy(this.eval(node.l, scope)) || this.truthy(this.eval(node.r, scope));
      var a = this.eval(node.l, scope), b = this.eval(node.r, scope);
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
            /* 只要有一端是浮点（或字面量带小数），就按 IEEE 754 走 */
            /* 判据：值本身是浮点，或任一端字面量带小数点/指数 */
          var isFloatExpr = !Number.isInteger(a) || !Number.isInteger(b) ||
                            (node.l && node.l.isFloat) || (node.r && node.r.isFloat);
            if (isFloatExpr || a === 0) {
              if (a === 0) return NaN;
              return (a > 0) ? Infinity : -Infinity;
            }
            /* 整数除零：安全档报错，真实档也报错（真机 SIGFPE，不是可模拟的值） */
            throw cerr('除零错误（整数除零在真实 C++ 里会导致程序崩溃）');
          }
          /* 两个整数相除按 C 语义取整 */
          if (Number.isInteger(a) && Number.isInteger(b)) return Math.trunc(a / b);
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
        case '<<': return (a | 0) << (b | 0);
        case '>>': return (a | 0) >> (b | 0);
        case '&': return (a | 0) & (b | 0);
        case '|': return (a | 0) | (b | 0);
        case '^': return (a | 0) ^ (b | 0);
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
      if (target.type === 'Name') { scope.set(target.name, val); return; }
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
          UB.check('数组越界', '给下标 ' + wx + ' 赋值越界（数组长度 ' + arr.length + '）');
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
      var args = node.args.map(function (a) { return self.eval(a, scope); });
      /* sort(v.begin(), v.end()) —— 迭代器形式。
         竞赛代码里 sort 几乎都写成这样，只支持 sort(a, n) 是不够的。 */
      if (name === 'sort' && args.length >= 2 && args[0] && args[0].__iter) {
        var container = args[0].__iter;
        var l = args[0].__at || 0;
        var r = (args[1] && args[1].__iter === container) ? (args[1].__at || 0) : container.length;
        var part2 = container.slice(l, r).sort(function (x, y) {
          if (typeof x === 'number' && typeof y === 'number') return x - y;
          return String(x) < String(y) ? -1 : (String(x) > String(y) ? 1 : 0);
        });
        for (var i2 = 0; i2 < part2.length; i2++) container[l + i2] = part2[i2];
        return container;
      }
      if (name && this.funcs[name]) {
        var f = this.funcs[name];
        if (f.builtin) return f.builtin.apply(null, args);
        return this.callFunc(f.node, args, this.global);
      }
      throw cerr('暂不支持的函数：' + (name || '(表达式)'));
    },

    callFunc: function (fn, args, parent) {
      var self = this;
      var sc = new Scope(this.global);
      /* 实参不足时用默认值；没有默认值才补 0 */
      (fn.args || []).forEach(function (a, i) {
        var v;
        if (i < args.length) v = args[i];
        else if (a.def !== null && a.def !== undefined) v = self.eval(a.def, self.global);
        else v = 0;
        sc.declare(a.name, v);
      });
      try {
        for (var i = 0; i < fn.body.length; i++) this.exec(fn.body[i], sc);
      } catch (e) {
        if (e instanceof CReturn) return e.value === undefined ? 0 : e.value;
        throw e;
      }
      return 0;
    },

    doCout: function (node, scope) {
      /* cout << a << b 左结合成 Cout(Cout(cout,a), b)。
         只求 right 会把 a 整个丢掉 —— 必须先递归跑完左侧链条。 */
      if (node.left && node.left.type === 'Cout') this.eval(node.left, scope);
      var v = this.eval(node.right, scope);
      if (v !== undefined && !(v && (v.__cout || v.__cin))) this.out(this.str(v));
      return { __cout: true };
    },

    /* 从输入缓冲取一个词。缓冲空了才去调 input()。
       以前每次都调 input() 且只取第一个词，剩下的全丢 ——
       `cin >> a >> b` 里 b 永远读不到本行第二个词。 */
    nextToken: function () {
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
      var val = this.nextToken();
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
