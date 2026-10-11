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
  function tokenize(src) {
    var t = [], i = 0, n = src.length;
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      /* 预处理指令整行忽略 */
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
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
        t.push({ t: 'NUM', v: parseFloat(m[0]) });
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

    parse: function () {
      var out = [];
      while (!this.at('EOF')) {
        if (this.eat('OP', ';')) continue;
        out.push(this.topLevel());
      }
      return { type: 'Program', body: out };
    },

    topLevel: function () {
      /* using namespace std; */
      if (this.at('KW', 'using')) { while (!this.atOp(';') && !this.at('EOF')) this.p++; this.eat('OP', ';'); return { type: 'Pass' }; }
      if (this.at('KW', 'namespace') || this.at('KW', 'template')) throw cerr('暂不支持：' + this.peek().v);
      if (this.at('KW', 'struct') || this.at('KW', 'class') || this.at('KW', 'enum') || this.at('KW', 'union')) {
        throw cerr('暂不支持：' + this.peek().v + '（本环境只支持基础类型、数组与函数）');
      }
      return this.funcOrDecl();
    },

    /* 识别函数定义：类型 名字 ( ... ) { */
    funcOrDecl: function () {
      if (!this.at('TYPE') && !this.at('NAME')) throw cerr('无法识别的声明');
      /* 可能带 const / unsigned */
      while (this.at('TYPE') && (this.peek().v === 'const' || this.peek().v === 'unsigned' || this.peek().v === 'signed')) this.p++;
      var type = this.at('TYPE') ? this.next().v : 'auto';
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
        var nm = null;
        if (this.at('NAME')) nm = this.next().v;
        if (this.atOp('[')) { while (!this.atOp(',') && !this.atOp(')')) this.p++; }
        if (nm) args.push({ name: nm, type: ty });
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
          case 'switch': throw cerr('暂不支持：switch');
          case 'try': case 'catch': case 'throw': throw cerr('暂不支持：' + t.v);
          case 'new': case 'delete': throw cerr('暂不支持：' + t.v + '（本环境无动态内存）');
        }
      }
      /* using namespace std; */
      if (this.at('KW', 'using')) { while (!this.atOp(';') && !this.at('EOF')) this.p++; this.eat('OP', ';'); return null; }
      /* 局部声明 */
      if (this.at('TYPE')) {
        while (this.at('TYPE') && (this.peek().v === 'const' || this.peek().v === 'unsigned' || this.peek().v === 'signed')) this.p++;
        var ty = this.next().v;
        /* int *p —— 星号在变量名之前，必须先看，否则会当成"期望标识符"报错，
           用户看到的是语法错而不是"不支持指针" */
        if (this.atOp('*')) throw cerr('暂不支持：指针（本环境无地址与内存操作）');
        if (this.atOp('&')) throw cerr('暂不支持：引用（&）');
        if (!this.at('NAME')) throw cerr('期望标识符，实际读到 ' + (this.peek().v || this.peek().t));
        var nm = this.next().v;
        /* 可能是函数声明 */
        if (this.atOp('(')) { this.paramList(); this.expect('OP', ';'); return null; }
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
    forStmt: function () {
      this.expect('KW', 'for');
      this.expect('OP', '(');
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
      if (this.atOp('*')) throw cerr('暂不支持：指针解引用');
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
        if (!this.noStream && this.atOp('<<')) {
          this.p++;
          this.noStream = true;
          var r = this.unary();
          this.noStream = false;
          e = { type: 'Cout', left: e, right: r };
          continue;
        }
        if (!this.noStream && this.atOp('>>')) {
          this.p++;
          this.noStream = true;
          var r2 = this.unary();
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
        this.p++;
        var e = this.expr();
        this.expect('OP', ')');
        return e;
      }
      if (t.t === 'NUM') { this.p++; return { type: 'Num', v: t.v }; }
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

  function CBreak() { } function CContinue() { } function CReturn(v) { this.value = v; }

  function Interp(out, input) {
    this.out = out || function () { };
    this.input = input || function () { return ''; };
    this.steps = 0;
    this.deadline = 0;
    this.global = new Scope(null);
    this.funcs = {};
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
    },

    str: function (v) {
      if (v === null || v === undefined) return 'null';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'number') return String(Math.round(v * 1e10) / 1e10);
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return '[' + v.map(this.str, this).join(', ') + ']';
      return String(v);
    },

    run: function (src, opts) {
      opts = opts || {};
      this.steps = 0;
      this.deadline = opts.timeout ? Date.now() + opts.timeout : 0;
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
        case 'VarDecl':
          node.decls.forEach(function (d) {
            var val;
            if (d.sizes) {
              /* 初始化列表是 AST 节点（InitList），先求值再取长度 */
              var initArr = d.init ? self.eval(d.init, scope) : null;
              if (initArr !== null && !Array.isArray(initArr)) initArr = [initArr];
              var n0 = initArr ? initArr.length : (d.sizes[0] ? self.eval(d.sizes[0], scope) : 0);
              val = new Array(Math.max(0, n0 | 0));
              var def = d.type === 'char' ? '' : 0;
              for (var i = 0; i < val.length; i++) val[i] = def;
              if (initArr) for (var j = 0; j < initArr.length && j < val.length; j++) val[j] = initArr[j];
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
          try { return scope.get(node.name); } catch (e) { throw cerr('变量未定义：' + node.name); }
        case 'BinOp': return this.binop(node, scope);
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
          if (!Array.isArray(arr)) throw cerr('不是数组：' + this.str(arr));
          return arr[i | 0];
        }
        case 'Call': return this.doCall(node, scope);
        case 'Cout': return this.doCout(node, scope);
        case 'Cin': return this.doCin(node, scope);
        case 'Member': throw cerr('暂不支持：结构体 / 类成员访问');
      }
      throw cerr('暂不支持的表达式：' + node.type);
    },

    binop: function (node, scope) {
      var op = node.op;
      /* && 与 || 短路 */
      if (op === '&&') return this.truthy(this.eval(node.l, scope)) && this.truthy(this.eval(node.r, scope));
      if (op === '||') return this.truthy(this.eval(node.l, scope)) || this.truthy(this.eval(node.r, scope));
      var a = this.eval(node.l, scope), b = this.eval(node.r, scope);
      switch (op) {
        case '+':
          if (typeof a === 'string' || typeof b === 'string') return this.str(a) + this.str(b);
          return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) throw cerr('除零错误');
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
      if (target.type === 'Name') { scope.set(target.name, val); return; }
      if (target.type === 'Index') {
        var arr = this.eval(target.obj, scope);
        if (!Array.isArray(arr)) throw cerr('不是数组，无法赋值');
        arr[this.eval(target.index, scope) | 0] = val;
        return;
      }
      throw cerr('暂不支持的赋值目标');
    },

    doCall: function (node, scope) {
      var self = this;
      var name = node.callee.type === 'Name' ? node.callee.name : null;
      var args = node.args.map(function (a) { return self.eval(a, scope); });
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
      (fn.args || []).forEach(function (a, i) { sc.declare(a.name, i < args.length ? args[i] : 0); });
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

    doCin: function (node, scope) {
      /* cin >> x：从输入行读一个词 */
      var line = this.input();
      var parts = String(line).trim().split(/\s+/);
      var val = parts.shift() || '';
      var num = Number(val);
      this.assignTo(node.right, val !== '' && isFinite(num) ? num : val, scope);
      return node.left;
    }
  };

  Code.cpplite = {
    tokenize: tokenize,
    parse: function (src) { return new Parser(tokenize(src)).parse(); },
    create: function (out, input) { return new Interp(out, input); },
    MAX_STEPS: MAX_STEPS
  };
})(typeof window !== 'undefined' ? window : globalThis);
