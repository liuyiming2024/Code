/* pylite.js —— Python 子集解释器（自研，纯 JS）
 *
 * 定位：教学与日常脚本场景的 Python 语法子集。
 * 它不是 CPython，不支持 import 第三方库、async、生成器、装饰器等。
 * 遇到不支持的语法会给出具体的"暂不支持"提示，绝不静默跑歪。
 *
 * 相比真 Python（WASM 解释器）的两个优势：
 *   1. 体积几十 KB，随仓库自带，file:// 与线上都能跑
 *   2. 带步数上限，死循环能被中断 —— 而 WASM/原生 JS 死循环只能关标签页
 *
 * 实现：分词 → 递归下降生成 AST → 树遍历执行。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  /* ============================================================
   * 一、分词
   * ============================================================ */

  var KEYWORDS = ('False None True and as assert break class continue def del elif else except ' +
    'finally for from global if import in is lambda nonlocal not or pass raise return ' +
    'try while with yield').split(' ');

  var OP3 = ['**=', '//=', '>>=', '<<='];
  var OP2 = ['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '//', '**', '->', '<<', '>>'];
  var OP1 = '+-*/%<>=()[]{}:,.;~&|^@'.split('');

  function tokenize(src) {
    var toks = [], i = 0, n = src.length;
    var indentStack = [0];
    var atLineStart = true, pendingIndent = -1;
    var parenDepth = 0;

    function push(t) { toks.push(t); }

    while (i < n) {
      var c = src[i];

      /* 行首缩进 */
      if (atLineStart) {
        var j = i, spaces = 0, tabs = 0;
        while (j < n && (src[j] === ' ' || src[j] === '\t')) {
          if (src[j] === '\t') tabs++; else spaces++;
          j++;
        }
        var col = spaces + tabs * 8;
        if (j >= n) { i = n; break; }
        /* 空行或纯注释行：不产生任何 token，直接进入下一行 */
        if (src[j] === '\n' || src[j] === '#' || (src[j] === '\r' && src[j + 1] === '\n')) {
          while (j < n && src[j] !== '\n') j++;
          i = j + 1;
          continue;
        }
        if (parenDepth === 0) {
          if (col > indentStack[indentStack.length - 1]) {
            indentStack.push(col);
            push({ t: 'INDENT', v: col });
          } else {
            while (col < indentStack[indentStack.length - 1]) {
              indentStack.pop();
              push({ t: 'DEDENT' });
            }
            if (col !== indentStack[indentStack.length - 1]) throw pyErr('缩进不一致');
          }
        }
        atLineStart = false;
        i = j;
        continue;
      }

      /* 换行 */
      if (c === '\n') {
        if (parenDepth === 0) { push({ t: 'NEWLINE' }); atLineStart = true; }
        i++;
        continue;
      }
      /* 反斜杠续行 */
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '\r') { i++; continue; }

      /* 注释 */
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }

      /* 空白 */
      if (c === ' ' || c === '\t') { i++; continue; }

      /* 括号深度 */
      if (c === '(' || c === '[' || c === '{') { parenDepth++; push({ t: 'OP', v: c }); i++; continue; }
      if (c === ')' || c === ']' || c === '}') { parenDepth--; if (parenDepth < 0) parenDepth = 0; push({ t: 'OP', v: c }); i++; continue; }

      /* 字符串 */
      if (c === '"' || c === "'") {
        var res = readString(src, i, toks);
        i = res.i;
        continue;
      }

      /* 数字 */
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        var m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i));
        if (!m) throw pyErr('无法识别的数字');
        push({ t: 'NUM', v: parseFloat(m[0]), raw: m[0] });
        i += m[0].length;
        continue;
      }

      /* 标识符 / 关键字 */
      if (/[A-Za-z_]/.test(c)) {
        var m2 = /^[A-Za-z_]\w*/.exec(src.slice(i));
        var w = m2[0];
        /* 字符串前缀（f / r / b / u 及其组合）后紧跟引号时，
           这是带前缀的字符串字面量，不是标识符。必须让 readString 处理，
           否则 f"..." 会被拆成 NAME(f) + STR(...)，花括号里的表达式不解析。 */
        if (/^[frbuFRBU]+$/.test(w) && (src[i + w.length] === '"' || src[i + w.length] === "'")) {
          var rs = readString(src, i, toks);
          i = rs.i;
          continue;
        }
        push({ t: KEYWORDS.indexOf(w) >= 0 ? 'KW' : 'NAME', v: w });
        i += w.length;
        continue;
      }

      /* 运算符 */
      var matched = null;
      for (var k = 0; k < OP3.length; k++) if (src.substr(i, 3) === OP3[k]) { matched = OP3[k]; break; }
      if (!matched) for (var k2 = 0; k2 < OP2.length; k2++) if (src.substr(i, 2) === OP2[k2]) { matched = OP2[k2]; break; }
      if (!matched) for (var k3 = 0; k3 < OP1.length; k3++) if (src[i] === OP1[k3]) { matched = OP1[k3]; break; }
      if (!matched) throw pyErr('无法识别的字符：' + c);
      push({ t: 'OP', v: matched });
      i += matched.length;
    }

    if (!atLineStart) push({ t: 'NEWLINE' });
    while (indentStack.length > 1) { indentStack.pop(); push({ t: 'DEDENT' }); }
    push({ t: 'EOF' });
    return toks;
  }

  /* 字符串与 f-string：返回 {i}；可能 push 多个 token（f-string 会被拆成片段） */
  function readString(src, i, toks) {
    var n = src.length;
    var prefix = '', start = i;
    /* 收集前缀字母：引号不是字母，遇到自然停止。
       原写法多加了"下一个字符不是引号"的判断，导致 f"..." 的 f 收不进来。 */
    while (i < n && /[a-zA-Z]/.test(src[i])) { prefix += src[i]; i++; }
    if (i >= n || (src[i] !== '"' && src[i] !== "'")) {
      throw pyErr('字符串前缀写法有误：' + prefix);
    }
    var isF = prefix.indexOf('f') >= 0;
    var isRaw = prefix.indexOf('r') >= 0;
    var isBytes = prefix.indexOf('b') >= 0;
    var triple = src.substr(i, 3) === src[i].repeat(3);
    var quote = triple ? src[i].repeat(3) : src[i];
    i += quote.length;
    var buf = '', parts = null;

    while (i < n) {
      if (!isRaw && src[i] === '\\') {
        var esc = src[i + 1];
        if (esc === 'n') { buf += '\n'; i += 2; continue; }
        if (esc === 't') { buf += '\t'; i += 2; continue; }
        if (esc === 'r') { buf += '\r'; i += 2; continue; }
        if (esc === '\\') { buf += '\\'; i += 2; continue; }
        if (esc === '"' || esc === "'") { buf += esc; i += 2; continue; }
        buf += esc; i += 2; continue;
      }
      if (src.substr(i, quote.length) === quote) { i += quote.length; break; }
      if (isF && src[i] === '{') {
        if (src[i + 1] === '{') { buf += '{'; i += 2; continue; }
        if (!parts) { parts = []; }
        if (buf) { parts.push({ lit: buf }); buf = ''; }
        var depth = 1, j = i + 1, expr = '';
        while (j < n && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') { if (--depth === 0) break; }
          expr += src[j]; j++;
        }
        parts.push({ expr: expr, tok: tokenize(expr).filter(function (t) { return t.t !== 'EOF'; }) });
        i = j + 1;
        continue;
      }
      buf += src[i]; i++;
    }
    if (isF) {
      if (buf) { (parts || (parts = [])).push({ lit: buf }); }
      toks.push({ t: 'FSTR', v: parts });
    } else if (isBytes) {
      toks.push({ t: 'BYTES', v: buf });
    } else {
      toks.push({ t: 'STR', v: buf });
    }
    return { i: i };
  }

  function pyErr(msg, line) {
    var e = new Error(msg);
    e.pyLine = line;
    return e;
  }

  /* ============================================================
   * 二、语法分析（递归下降）
   * ============================================================ */

  function Parser(toks) {
    this.t = toks; this.p = 0;
  }
  Parser.prototype = {
    peek: function (k) { return this.t[this.p + (k || 0)]; },
    next: function () { return this.t[this.p++]; },
    at: function (type, val) {
      var t = this.peek();
      return t && t.t === type && (val === undefined || t.v === val);
    },
    eat: function (type, val) { if (this.at(type, val)) { this.p++; return true; } return false; },
    expect: function (type, val) {
      if (!this.eat(type, val)) {
        var t = this.peek();
        throw pyErr('语法错误：期望 ' + (val || type) + '，实际读到 ' + (t ? (t.v !== undefined ? t.v : t.t) : '文件结束'));
      }
    },
    skipNewlines: function () { while (this.eat('NEWLINE')) { } },

    /* 顶层没有 INDENT，不能走 block()——那条分支只解析单行。
       必须按 NEWLINE 逐条吃到 EOF，否则多行脚本只执行第一行。 */
    parse: function () {
      var body = [];
      this.skipNewlines();
      while (!this.at('EOF')) {
        if (this.at('DEDENT')) { this.p++; continue; }
        var st = this.statement();
        if (st) body.push(st);
        this.skipNewlines();
      }
      return { type: 'Module', body: body };
    },

    block: function () {
      this.skipNewlines();
      if (!this.at('INDENT')) {
        /* 单行块：if x: pass */
        var st = this.statement();
        if (!st) return [];
        return [st];
      }
      this.expect('INDENT');
      this.skipNewlines();
      var out = [];
      while (!this.at('DEDENT') && !this.at('EOF')) {
        var s = this.statement();
        if (s) out.push(s);
        this.skipNewlines();
      }
      this.eat('DEDENT');
      return out;
    },

    statement: function () {
      var t = this.peek();
      if (!t || t.t === 'EOF') return null;
      if (t.t === 'NEWLINE') { this.p++; return null; }

      var kwHandlers = {
        'if': 'ifStmt', 'while': 'whileStmt', 'for': 'forStmt', 'def': 'defStmt',
        'class': 'classStmt', 'return': 'returnStmt', 'break': 'breakStmt',
        'continue': 'continueStmt', 'pass': 'passStmt', 'import': 'importStmt',
        'from': 'importFromStmt', 'raise': 'raiseStmt', 'assert': 'assertStmt',
        'del': 'delStmt', 'global': 'globalStmt', 'try': 'tryStmt', 'with': 'withStmt'
      };
      if (t.t === 'KW' && kwHandlers[t.v]) return this[kwHandlers[t.v]]();
      if (t.t === 'KW' && (t.v === 'async' || t.v === 'yield' || t.v === 'nonlocal' || t.v === 'lambda')) {
        throw pyErr('暂不支持：' + t.v);
      }
      if (t.t === 'OP' && t.v === '@') throw pyErr('暂不支持：装饰器（@）');
      return this.simpleStatement();
    },

    simpleStatement: function () {
      var start = this.p;
      var e = this.expr();
      /* 赋值 */
      if (this.at('OP', '=')) {
        this.p++;
        var val = this.exprList();
        return { type: 'Assign', targets: [e], value: val };
      }
      var augMap = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '//=': '//', '**=': '**' };
      var t = this.peek();
      if (t && t.t === 'OP' && augMap[t.v]) {
        var op = augMap[t.v]; this.p++;
        return { type: 'AugAssign', target: e, op: op, value: this.exprList() };
      }
      /* 多重赋值 a, b = 1, 2 */
      if (this.at('OP', ',')) {
        var targets = [e];
        while (this.eat('OP', ',')) {
          if (this.at('OP', '=') || this.at('NEWLINE') || this.at('EOF')) break;
          targets.push(this.expr());
        }
        if (this.eat('OP', '=')) {
          var vals = [];
          do { vals.push(this.expr()); } while (this.eat('OP', ','));
          return { type: 'Assign', targets: targets, value: vals.length > 1 ? { type: 'Tuple', elts: vals } : vals[0] };
        }
        return { type: 'Expr', value: { type: 'Tuple', elts: targets } };
      }
      return { type: 'Expr', value: e };
    },

    exprList: function () {
      var first = this.expr();
      if (!this.at('OP', ',')) return first;
      var elts = [first];
      while (this.eat(('OP' && 'OP'), ',')) {
        if (this.at('NEWLINE') || this.at('EOF')) break;
        elts.push(this.expr());
      }
      return elts.length > 1 ? { type: 'Tuple', elts: elts } : first;
    },

    /* 循环/推导式的赋值目标：不含 in，但允许逗号构成元组 */
    targetExpr: function () {
      var first = this.expr();
      if (!this.at('OP', ',')) return first;
      var elts = [first];
      while (this.eat('OP', ',')) {
        if (this.at('KW', 'in') || this.at('NEWLINE') || this.at('EOF')) break;
        elts.push(this.expr());
      }
      return { type: 'Tuple', elts: elts };
    },

    ifStmt: function () {
      this.expect('KW', 'if');
      var test = this.expr();
      this.expect('OP', ':');
      var body = this.block();
      var orelse = null;
      this.skipNewlines();
      if (this.at('KW', 'elif')) {
        this.p++;
        var t2 = this.expr();
        this.expect('OP', ':');
        var b2 = this.block();
        /* 后续可能还有 elif / else，交给 elseChain 递归，避免漏掉末尾的 else */
        orelse = [{ type: 'If', test: t2, body: b2, orelse: this.elseChain() }];
      } else if (this.at('KW', 'else')) {
        this.p++; this.expect('OP', ':');
        orelse = this.block();
      }
      return { type: 'If', test: test, body: body, orelse: orelse };
    },
    /* elif / else 的尾巴：可能连续多个 elif，最后是 else */
    elseChain: function () {
      this.skipNewlines();
      if (this.at('KW', 'elif')) {
        this.p++;
        var t = this.expr();
        this.expect('OP', ':');
        var b = this.block();
        return [{ type: 'If', test: t, body: b, orelse: this.elseChain() }];
      }
      if (this.at('KW', 'else')) {
        this.p++; this.expect('OP', ':');
        return this.block();
      }
      return null;
    },

    whileStmt: function () {
      this.expect('KW', 'while');
      var test = this.expr(); this.expect('OP', ':');
      var body = this.block();
      var orelse = null;
      this.skipNewlines();
      if (this.at('KW', 'else')) { this.p++; this.expect('OP', ':'); orelse = this.block(); }
      return { type: 'While', test: test, body: body, orelse: orelse };
    },

    forStmt: function () {
      this.expect('KW', 'for');
      /* target 解析期间禁用 in：`for i in range(3)` 里的 in 是语法关键字，
         不是比较运算符。不禁用会被 comparison() 吃掉，导致报"期望 in"。 */
      this.noIn = true;
      var target = this.targetExpr();
      this.noIn = false;
      this.expect('KW', 'in');
      var iter = this.expr();
      this.expect('OP', ':');
      var body = this.block();
      var orelse = null;
      this.skipNewlines();
      if (this.at('KW', 'else')) { this.p++; this.expect('OP', ':'); orelse = this.block(); }
      return { type: 'For', target: target, iter: iter, body: body, orelse: orelse };
    },

    defStmt: function () {
      this.expect('KW', 'def');
      var name = this.next().v;
      var args = this.params();
      this.expect('OP', ':');
      var body = this.block();
      return { type: 'FuncDef', name: name, args: args, body: body };
    },

    params: function () {
      this.expect('OP', '(');
      var args = [];
      var names = [], defaults = [];
      var kwonly = [], kwdef = [];
      var star = null, kwstar = null, inKw = false;
      while (!this.at('OP', ')')) {
        if (this.eat('OP', '*')) { star = this.next().v; continue; }
        if (this.eat('OP', '**')) { kwstar = this.next().v; continue; }
        var nm = this.next().v;
        if (this.eat('OP', '=')) {
          var d = this.expr();
          if (inKw) { kwonly.push(nm); kwdef.push(d); }
          else { names.push(nm); defaults.push(d); }
        } else {
          if (inKw) { kwonly.push(nm); kwdef.push(undefined); }
          else names.push(nm);
        }
        if (this.at('OP', ',')) { this.p++; if (star && !inKw) inKw = true; }
      }
      this.expect('OP', ')');
      return { names: names, defaults: defaults, kwonly: kwonly, kwdef: kwdef, star: star, kwstar: kwstar };
    },

    classStmt: function () {
      this.expect('KW', 'class');
      var name = this.next().v;
      var bases = [];
      if (this.eat('OP', '(')) {
        do { bases.push(this.expr()); } while (this.eat(('OP'), ','));
        this.expect('OP', ')');
      }
      this.expect('OP', ':');
      var body = this.block();
      return { type: 'ClassDef', name: name, bases: bases, body: body };
    },

    returnStmt: function () {
      this.expect('KW', 'return');
      if (this.at('NEWLINE') || this.at('EOF')) return { type: 'Return', value: null };
      return { type: 'Return', value: this.exprList() };
    },
    breakStmt: function () { this.expect('KW', 'break'); return { type: 'Break' }; },
    continueStmt: function () { this.expect('KW', 'continue'); return { type: 'Continue' }; },
    passStmt: function () { this.expect('KW', 'pass'); return { type: 'Pass' }; },
    globalStmt: function () {
      this.expect('KW', 'global');
      var names = [this.next().v];
      while (this.eat('OP', ',')) names.push(this.next().v);
      return { type: 'Global', names: names };
    },
    delStmt: function () {
      this.expect('KW', 'del');
      var t = this.expr();
      return { type: 'Del', target: t };
    },
    raiseStmt: function () {
      this.expect('KW', 'raise');
      if (this.at('NEWLINE') || this.at('EOF')) return { type: 'Raise', value: null };
      return { type: 'Raise', value: this.expr() };
    },
    assertStmt: function () {
      this.expect('KW', 'assert');
      var test = this.expr();
      var msg = null;
      if (this.eat('OP', ',')) msg = this.expr();
      return { type: 'Assert', test: test, msg: msg };
    },
    importStmt: function () {
      this.expect('KW', 'import');
      var mods = [];
      do {
        var parts = [this.next().v];
        while (this.eat('OP', '.')) parts.push(this.next().v);
        var alias = null;
        if (this.eat('KW', 'as')) alias = this.next().v;
        mods.push({ name: parts.join('.'), path: parts, alias: alias });
      } while (this.eat('OP', ','));
      return { type: 'Import', mods: mods };
    },
    importFromStmt: function () {
      this.expect('KW', 'from');
      var parts = [this.next().v];
      while (this.eat('OP', '.')) parts.push(this.next().v);
      this.expect('KW', 'import');
      var names = [];
      if (this.eat('OP', '*')) names.push({ name: '*', alias: null });
      else do {
        var nm = this.next().v;
        var al = null;
        if (this.eat('KW', 'as')) al = this.next().v;
        names.push({ name: nm, alias: al });
      } while (this.eat('OP', ','));
      return { type: 'ImportFrom', module: parts.join('.'), path: parts, names: names };
    },
    withStmt: function () { throw pyErr('暂不支持：with 语句'); },
    tryStmt: function () {
      this.expect('KW', 'try'); this.expect('OP', ':');
      var body = this.block();
      var handlers = [], orelse = null, finalbody = null;
      while (true) {
        this.skipNewlines();
        if (this.at('KW', 'except')) {
          this.p++;
          var type_ = null, name = null;
          if (!this.at('OP', ':')) {
            type_ = this.expr();
            if (this.eat('KW', 'as')) name = this.next().v;
          }
          this.expect('OP', ':');
          handlers.push({ type: type_, name: name, body: this.block() });
        } else if (this.at('KW', 'else')) {
          this.p++; this.expect('OP', ':'); orelse = this.block();
        } else if (this.at('KW', 'finally')) {
          this.p++; this.expect('OP', ':'); finalbody = this.block();
        } else break;
      }
      return { type: 'Try', body: body, handlers: handlers, orelse: orelse, finalbody: finalbody };
    },

    /* ---------- 表达式 ---------- */
    expr: function () { return this.ternary(); },

    ternary: function () {
      var v = this.orExpr();
      /* 推导式里的 elt / iter 后面跟的 if 属于推导式语法，不是三元运算符。
         不开关会把 [x for x in r if x] 里的 if 当成三元，报"期望 else"。 */
      if (!this.noTernary && this.at('KW', 'if')) {
        this.p++;
        this.noTernary = true;
        var cond = this.orExpr();
        this.noTernary = false;
        this.expect('KW', 'else');
        var other = this.expr();
        return { type: 'IfExp', test: cond, body: v, orelse: other };
      }
      return v;
    },

    exprNoIf: function () {
      this.noTernary = true;
      var e = this.expr();
      this.noTernary = false;
      return e;
    },
    orExpr: function () {
      var l = this.andExpr();
      while (this.at('KW', 'or')) { this.p++; l = { type: 'BoolOp', op: 'or', values: [l, this.andExpr()] }; }
      return l;
    },
    andExpr: function () {
      var l = this.notExpr();
      while (this.at('KW', 'and')) { this.p++; l = { type: 'BoolOp', op: 'and', values: [l, this.notExpr()] }; }
      return l;
    },
    notExpr: function () {
      if (this.at('KW', 'not')) { this.p++; return { type: 'UnaryOp', op: 'not', operand: this.notExpr() }; }
      return this.comparison();
    },
    comparison: function () {
      var l = this.additive();
      var ops = ['==', '!=', '<=', '>=', '<', '>', 'in', 'not in', 'is', 'is not'];
      var list = [];
      while (true) {
        var t = this.peek();
        var op = null;
        if (t.t === 'OP' && ops.indexOf(t.v) >= 0) { op = t.v; this.p++; }
        else if (t.t === 'KW' && t.v === 'in') { if (this.noIn) break; op = 'in'; this.p++; }
        else if (t.t === 'KW' && t.v === 'is') {
          this.p++;
          if (this.at('KW', 'not')) { this.p++; op = 'is not'; } else op = 'is';
        } else if (t.t === 'KW' && t.v === 'not' && this.peek(1) && this.peek(1).t === 'KW' && this.peek(1).v === 'in') {
          if (this.noIn) break;
          this.p += 2; op = 'not in';
        } else break;
        list.push(op);
        if (list.length > 1) break;
        var r = this.additive();
        l = { type: 'Compare', left: l, op: op, right: r };
      }
      return l;
    },
    additive: function () {
      var l = this.multiplicative();
      while (this.at('OP', '+') || this.at('OP', '-')) {
        var op = this.next().v;
        l = { type: 'BinOp', op: op, left: l, right: this.multiplicative() };
      }
      return l;
    },
    multiplicative: function () {
      var l = this.unary();
      while (this.at('OP', '*') || this.at('OP', '/') || this.at('OP', '%') || this.at('OP', '//')) {
        var op = this.next().v;
        l = { type: 'BinOp', op: op, left: l, right: this.unary() };
      }
      return l;
    },
    unary: function () {
      if (this.at('OP', '-')) { this.p++; return { type: 'UnaryOp', op: '-', operand: this.unary() }; }
      if (this.at('OP', '+')) { this.p++; return this.unary(); }
      if (this.at('OP', '~')) { this.p++; return { type: 'UnaryOp', op: '~', operand: this.unary() }; }
      return this.power();
    },
    power: function () {
      var l = this.atom();
      if (this.at('OP', '**')) { this.p++; l = { type: 'BinOp', op: '**', left: l, right: this.unary() }; }
      return l;
    },

    atom: function () {
      var t = this.peek();

      /* 字面量后面也可能跟 .方法() 或 [下标]，必须过 postfix */
      if (t.t === 'NUM') { this.p++; return this.postfix({ type: 'Num', value: t.v }); }
      if (t.t === 'STR') { this.p++; return this.postfix({ type: 'Str', value: t.v }); }
      if (t.t === 'BYTES') { this.p++; return this.postfix({ type: 'Bytes', value: t.v }); }
      if (t.t === 'FSTR') { this.p++; return this.postfix({ type: 'FStr', parts: t.v }); }
      if (t.t === 'KW' && (t.v === 'True' || t.v === 'False')) { this.p++; return { type: 'Bool', value: t.v === 'True' }; }
      if (t.t === 'KW' && t.v === 'None') { this.p++; return { type: 'None' }; }
      if (t.t === 'KW' && t.v === 'lambda') {
        this.p++;
        var names = [];
        while (!this.at('OP', ':')) {
          if (this.eat('OP', '*')) { names.push('*' + this.next().v); continue; }
          if (this.eat('OP', '**')) { names.push('**' + this.next().v); continue; }
          var nm = this.next().v;
          if (this.eat('OP', '=')) { this.expr(); }
          names.push(nm);
          this.eat('OP', ',');
        }
        this.expect('OP', ':');
        return { type: 'Lambda', names: names, body: this.expr() };
      }

      /* 列表 / 元组 / 字典 / 集合 / 推导式 */
      if (t.t === 'OP' && t.v === '[') { this.p++; return this.postfix(this.listOrComp(']', 'List', 'ListComp')); }
      if (t.t === 'OP' && t.v === '(') { this.p++; return this.postfix(this.listOrComp(')', 'Tuple', 'GenExp')); }
      if (t.t === 'OP' && t.v === '{') {
        this.p++;
        if (this.eat('OP', '}')) return { type: 'Dict', keys: [], values: [] };
        var first = this.expr();
        if (this.at('OP', ':')) { this.p++; return this.dictOrComp(first); }
        var elts = [first];
        while (this.eat('OP', ',')) { if (this.at('OP', '}')) break; elts.push(this.expr()); }
        this.expect('OP', '}');
        return { type: 'Set', elts: elts };
      }

      if (t.t === 'OP' && (t.v === '-' || t.v === '+')) return this.unary();

      if (t.t === 'NAME') {
        this.p++;
        var node = { type: 'Name', id: t.v };
        return this.postfix(node);
      }
      if (t.t === 'OP' && t.v === '(') {
        this.p++;
        var e = this.expr();
        if (this.at('OP', ',')) {
          var elts2 = [e];
          while (this.eat('OP', ',')) { if (this.at('OP', ')')) break; elts2.push(this.expr()); }
          this.expect('OP', ')');
          return this.postfix({ type: 'Tuple', elts: elts2 });
        }
        this.expect('OP', ')');
        return this.postfix(e);
      }
      throw pyErr('语法错误：读到意外的 ' + (t.v !== undefined ? t.v : t.t));
    },

    postfix: function (node) {
      while (true) {
        if (this.at('OP', '(')) {
          this.p++;
          var args = [], kwargs = [];
          while (!this.at('OP', ')')) {
            if (this.at('OP', '*') || this.at('OP', '**')) {
              var st = this.next().v; args.push({ star: st, value: this.expr() });
            } else if (this.at('NAME') && this.peek(1) && this.peek(1).t === 'OP' && this.peek(1).v === '=' && !this.at('KW')) {
              var kn = this.next().v; this.p++;
              kwargs.push({ name: kn, value: this.expr() });
            } else {
              args.push({ value: this.expr() });
            }
            if (!this.eat('OP', ',')) break;
          }
          this.expect('OP', ')');
          node = { type: 'Call', func: node, args: args, kwargs: kwargs };
          continue;
        }
        if (this.at('OP', '[')) {
          this.p++;
          var idx = this.subscript();
          this.expect('OP', ']');
          node = { type: 'Subscript', value: node, slice: idx };
          continue;
        }
        if (this.at('OP', '.')) {
          this.p++;
          var attr = this.next().v;
          node = { type: 'Attribute', value: node, attr: attr };
          continue;
        }
        break;
      }
      return node;
    },

    /* 切片：[a:b:c] / [::c] / [:b] / [a:]
       冒号1 后是 stop，冒号2 后是 step。判断 stop 时必须排除 ':'
       否则 [::-1] 的 -1 会被当成 stop 而不是 step。 */
    subscript: function () {
      var parts = [];
      while (true) {
        var lower = null, upper = null, step = null, isSlice = false, sawColon = false;
        /* 切片形如 [start:stop:step]。冒号A 分隔 start|stop，冒号B 分隔 stop|step。
           必须按"当前消费到第几个冒号"推进：若连续两个冒号（如 [::-1]），
           第一个冒号之后紧接着又是冒号，说明 stop 为空，紧接着的 -1 是 step。
           之前写成"消费冒号后立刻读 stop"，会把 [::-1] 的 step 读到 stop 上。 */
        if (this.at('OP', ':')) { isSlice = true; sawColon = true; this.p++; }
        else { lower = this.expr(); }

        if (!sawColon && this.at('OP', ':')) { isSlice = true; sawColon = true; this.p++; }

        if (sawColon) {
          if (!this.at('OP', ':') && !this.at('OP', ']') && !this.at('OP', ',')) upper = this.expr();
          if (this.at('OP', ':')) {
            this.p++;
            if (!this.at('OP', ']') && !this.at('OP', ',')) step = this.expr();
          }
        }
        parts.push(isSlice ? { lower: lower, upper: upper, step: step } : { index: lower });
        if (!this.eat('OP', ',')) break;
      }
      return parts.length === 1 ? parts[0] : { tuple: parts };
    },

    listOrComp: function (close, kind, compKind) {
      if (this.eat('OP', close)) return { type: kind, elts: [] };
      var first = this.exprNoIf();
      /* 推导式 */
      var save = this.p;
      if (this.at('KW', 'for')) {
        var gens = [];
        while (this.at('KW', 'for')) {
          this.p++;
          this.noIn = true;
          var tgt = this.targetExpr();
          this.noIn = false;
          this.expect('KW', 'in');
          var it = this.exprNoIf();
          var ifs = [];
          while (this.at('KW', 'if')) { this.p++; ifs.push(this.expr()); }
          gens.push({ target: tgt, iter: it, ifs: ifs });
        }
        this.expect('OP', close);
        return { type: compKind, elt: first, generators: gens };
      }
      this.p = save;
      var elts = [first];
      while (this.eat('OP', ',')) { if (this.at('OP', close)) break; elts.push(this.expr()); }
      this.expect('OP', close);
      return { type: kind, elts: elts };
    },

    dictOrComp: function (firstKey) {
      var firstVal = this.exprNoIf();
      var save = this.p;
      if (this.at('KW', 'for')) {
        var gens = [];
        while (this.at('KW', 'for')) {
          this.p++;
          this.noIn = true;
          var tgt = this.targetExpr();
          this.noIn = false;
          this.expect('KW', 'in');
          var it = this.exprNoIf();
          var ifs = [];
          while (this.at('KW', 'if')) { this.p++; ifs.push(this.expr()); }
          gens.push({ target: tgt, iter: it, ifs: ifs });
        }
        this.expect('OP', '}');
        return { type: 'DictComp', key: firstKey, value: firstVal, generators: gens };
      }
      this.p = save;
      var keys = [firstKey], values = [firstVal];
      while (this.eat('OP', ',')) {
        if (this.at('OP', '}')) break;
        keys.push(this.expr()); this.expect('OP', ':'); values.push(this.expr());
      }
      this.expect('OP', '}');
      return { type: 'Dict', keys: keys, values: values };
    }
  };

  /* ============================================================
   * 三、执行
   * ============================================================ */

  /* 时间同步（与 cpplite 同一套思路，但系数必须单独标定 ——
     Python 和 C++ 的性能不是一个量级，共用系数会差十几倍）。

     标定（实测）：
       - pylite 一次简单循环迭代 ≈ 4 步
         （实测：n=5000 → 20006 步，n=10000 → 40006 步 → 每迭代 4 步）
       - 真实 CPython 约 1.86e7 次迭代/秒
         （实测本机：n=1e7 循环 537ms → 53.7 ns/迭代）
       → 1 真实秒 ≈ 4 × 1.86e7 ≈ 7.4e7 pylite 步

     对比 C++：1 真实秒 ≈ 1.2e9 cpplite 步
     → Python 比 C++ 慢约 16 倍（与常识吻合：通常认为慢 10~50 倍）

     标定环境：CPython 3.10，2026-10-13。 */
  var PERF = {
    stepsPerIter: 4,
    realOpsPerSec: 1.86e7,
    toRealSec: function (steps) { return steps / PERF.stepsPerIter / PERF.realOpsPerSec; },
    human: function (steps) {
      var sec = PERF.toRealSec(steps);
      if (sec < 0.001) return (sec * 1e6).toFixed(1) + ' 微秒';
      if (sec < 1) return (sec * 1000).toFixed(2) + ' 毫秒';
      if (sec < 60) return sec.toFixed(2) + ' 秒';
      return (sec / 60).toFixed(1) + ' 分钟';
    }
  };

  /* 步数上限：原为 200 万 ≈ 真实 CPython 27 毫秒 ——
     n=5e5 的 O(n) 就会被判死循环，而真实 Python 只要 27 毫秒。
     提到 5e7 ≈ 真实 0.68 秒，可覆盖常规规模。 */
  var MAX_STEPS = 50000000;   /* 步数上限：让死循环可以被中断 */

  function Scope(parent, isGlobal) {
    this.vars = {};
    this.parent = parent || null;
    this.isGlobal = !!isGlobal;
  }
  Scope.prototype.get = function (name) {
    var s = this;
    while (s) {
      if (name in s.vars) return s.vars[name];
      s = s.parent;
    }
    throw pyErr('变量未定义：' + name);
  };
  Scope.prototype.set = function (name, val) { this.vars[name] = val; };
  Scope.prototype.del = function (name) {
    if (!(name in this.vars)) throw pyErr('无法删除：' + name);
    delete this.vars[name];
  };

  function PyFunc(node, scope, name, defaults) {
    this.node = node; this.scope = scope; this.name = name || '<lambda>'; this.defaults = defaults || [];
  }
  function PyMethod(fn, self) { this.fn = fn; this.self = self; }
  function PyClass(name, bases, dict) { this.name = name; this.bases = bases; this.dict = dict; }
  function PyInstance(cls) { this.cls = cls; this.attrs = {}; }
  function PyModule(name, dict) { this.name = name; this.dict = dict; }

  /* 中断信号 */
  function PyBreak() { } function PyContinue() { }
  function PyReturn(v) { this.value = v; }
  function PyRaise(e) { this.err = e; }

  function Interp(stdout, stdin) {
    this.out = stdout || function () { };
    this.stdin = stdin || function () { return ''; };
    this.steps = 0;
    this.global = new Scope(null, true);
    this.builtins = null;
    this.deadline = 0;
    this.installBuiltins();
    this.installStdlib();
  }

  Interp.prototype = {
    tick: function () {
      if (++this.steps > MAX_STEPS) {
        throw pyErr('本环境已跑满 ' + MAX_STEPS.toLocaleString() + ' 步（相当于真实 CPython 约 ' +
          PERF.human(MAX_STEPS) + '），停止执行。\n' +
          '这不代表你的程序会超时 —— 本环境是解释器，比真实的 Python 慢几个数量级。');
      }
      if (this.deadline && Date.now() > this.deadline) {
        throw pyErr('本环境已跑满时间预算，停止执行。\n' +
          '这不代表你的程序会超时 —— 本环境比真实的 Python 慢几个数量级。');
      }
    },

    /* ---------- 内置函数 ---------- */
    installBuiltins: function () {
      var self = this;
      var B = {};
      /* 注册内置函数时同时记下参数名，供关键字实参（如 sorted(..., reverse=True)）匹配 */
      function defB(name, argNames, fn) {
        fn.__pyargs = argNames;
        B[name] = fn;
      }
      function seq(v) {
        if (typeof v === 'string') return v.split('');
        if (Array.isArray(v)) return v;
        if (v && v.__pyiter) return v.__pyiter();
        throw pyErr('对象不可迭代：' + self.repr(v));
      }
      defB('print', [], function () {
        var a = Array.prototype.slice.call(arguments);
        var sep = ' ', end = '\n';
        if (a.length && typeof a[a.length - 1] === 'object' && a[a.length - 1] && a[a.length - 1].__kw) {
          var kw = a.pop().__kw;
          if (kw.sep !== undefined) sep = kw.sep;
          if (kw.end !== undefined) end = kw.end;
        }
        var parts = [];
        for (var i = 0; i < a.length; i++) parts.push(self.str(a[i]));
        /* 每行一次输出，换行由调用方拼接；这里不再追加 end */
        self.out(parts.join(sep));
        return null;
      });
      B.len = function (v) {
        /* dict 先判（S-064）：dict 不是数组，落到 iterable 分支会报
           "对象不可迭代：{1: 'a'}"，而真 Python 的 len({1:'a'}) 就是 1。 */
        if (v && v.__dict) return Object.keys(v.__dict).length;
        return seq(v).length;
      };
      B.range = function () {
        var a = arguments;
        var start = 0, stop, step = 1;
        if (a.length === 1) { stop = a[0]; }
        else if (a.length === 2) { start = a[0]; stop = a[1]; }
        else { start = a[0]; stop = a[1]; step = a[2]; }
        var arr = [];
        if (step > 0) for (var i = start; i < stop; i += step) arr.push(i);
        else if (step < 0) for (var j = start; j > stop; j += step) arr.push(j);
        return arr;
      };
      B.str = function (v) { return self.str(v); };
      B.repr = function (v) { return self.repr(v); };
      B.int = function (v, base) {
        if (arguments.length === 0) return 0;
        if (typeof v === 'number') return v < 0 ? Math.ceil(v) : Math.floor(v);
        return parseInt(String(v).trim(), base || 10);
      };
      B.float = function (v) { return arguments.length === 0 ? 0.0 : parseFloat(v); };
      B.bool = function (v) { return arguments.length === 0 ? false : self.truthy(v); };
      B.list = function (v) { return arguments.length === 0 ? [] : seq(v).slice(); };
      B.tuple = function (v) {
        var a = arguments.length === 0 ? [] : seq(v).slice();
        a.__tuple = true;
        return a;
      };
      B.set = function (v) { return arguments.length === 0 ? [] : dedup(seq(v)); };
      B.dict = function () {
        var d = {};
        if (arguments.length === 1) {
          var pairs = seq(arguments[0]);
          pairs.forEach(function (p) { d[self.hash(p[0])] = { k: p[0], v: p[1] }; });
        }
        return { __dict: d };
      };
      B.abs = function (v) { return Math.abs(v); };
      defB('min', ['iterable', 'key', 'default'], function () {
        var a = flattenArgs(arguments); if (!a.length) throw pyErr('min() 至少需要一个参数');
        return a.reduce(function (x, y) { return self.compare(x, y) < 0 ? x : y; });
      });
      defB('max', ['iterable', 'key', 'default'], function () {
        var a = flattenArgs(arguments); if (!a.length) throw pyErr('max() 至少需要一个参数');
        return a.reduce(function (x, y) { return self.compare(x, y) > 0 ? x : y; });
      });
      B.sum = function (v, start) {
        var a = seq(v), s = start || 0;
        for (var i = 0; i < a.length; i++) s += a[i];
        return s;
      };
      defB('sorted', ['iterable', 'key', 'reverse'], function (v, keyFn, reverse) {
        var a = seq(v).slice();
        var keyed = a.map(function (x) { return { k: keyFn ? self.call(keyFn, [x]) : x, v: x }; });
        keyed.sort(function (p, q) { return self.compare(p.k, q.k); });
        var out = keyed.map(function (p) { return p.v; });
        if (self.truthy(reverse)) out.reverse();
        return out;
      });
      B.reversed = function (v) { return seq(v).slice().reverse(); };
      B.enumerate = function (v, start) {
        var a = seq(v), s = start || 0;
        /* 真 Python 的 enumerate 产出**元组**（对照实测：[(0, 'a'), (1, 'b')]） */
        return a.map(function (x, i) {
          var e = [i + s, x];
          e.__tuple = true;
          return e;
        });
      };
      B.zip = function () {
        /* 真 Python 的 zip 产出**元组**（对照实测：[(1, 3), (2, 4)]），
           此前返回列表的列表 [[1,3],[2,4]] ——
           打印形式不同，且 `for a,b in zip(...)` 里 a,b 的类型认知会错。
           内置 tuple() 已打 __tuple 标记，这里复用它。 */
        var arrs = [];
        for (var i = 0; i < arguments.length; i++) arrs.push(seq(arguments[i]));
        var n = arrs.length ? Math.min.apply(null, arrs.map(function (a) { return a.length; })) : 0;
        var out = [];
        for (var j = 0; j < n; j++) {
          var one = arrs.map(function (a) { return a[j]; });
          one.__tuple = true;           /* zip 产出元组，不是列表 */
          out.push(one);
        }
        return out;
      };
      B.map = function (f, v) { return seq(v).map(function (x) { return self.call(f, [x]); }); };
      B.filter = function (f, v) {
        return seq(v).filter(function (x) { return self.truthy(f ? self.call(f, [x]) : x); });
      };
      B.any = function (v) { return seq(v).some(function (x) { return self.truthy(x); }); };
      B.all = function (v) { return seq(v).every(function (x) { return self.truthy(x); }); };
      defB('round', ['number', 'ndigits'], function (v, n) {
        var p = Math.pow(10, n || 0);
        return Math.round(v * p) / p;
      });
      /* ⚠ 不能靠 t.name 反查（S-064）。
         实测 `type(int)` 是 function，但函数对象的 name 是空字符串
         （注册时被重新赋值过），于是 isinstance 对任何内置类型都返回 False。
         改成在注册完成后建立"函数对象 → 类型名"的反查表，不依赖 name。 */
      var BUILTIN_BY_FN = null;
      function builtinName(t) {
        if (typeof t !== 'function') return null;
        if (!BUILTIN_BY_FN) {
          BUILTIN_BY_FN = new Map();
          ['int', 'float', 'str', 'list', 'tuple', 'dict', 'bool', 'set'].forEach(function (n) {
            if (typeof B[n] === 'function') BUILTIN_BY_FN.set(B[n], n);
          });
        }
        return BUILTIN_BY_FN.get(t) || null;
      }

      B.isinstance = function (v, t) {
        /* ⚠ 类型在 pylite 里是**函数对象**，不是字符串（S-064）。
           写 `isinstance(1, int)` 时 t 是内置函数 int，
           而这里拿 t === 'int' 比较，恒为 false ——
           于是 isinstance 对任何内置类型都返回 False，
           用户会以为自己的用法写错了。
           改：先把函数对象解析成类型名。 */
        if (typeof t === 'function') t = builtinName(t);
        if (t === 'int') return typeof v === 'number' && Number.isInteger(v);
        if (t === 'float') return typeof v === 'number';
        if (t === 'str') return typeof v === 'string';
        if (t === 'tuple') return !!Array.isArray(v) && v.__tuple === true;
        if (t === 'list') return Array.isArray(v) && v.__tuple !== true;
        if (t === 'dict') return !!(v && v.__dict);
        if (t === 'bool') return typeof v === 'boolean';
        if (t instanceof PyClass) {
          if (v instanceof PyInstance) {
            var c = v.cls;
            while (c) { if (c === t) return true; c = c.bases[0]; }
          }
          return false;
        }
        if (Array.isArray(t)) return t.some(function (x) { return B.isinstance(v, x); });
        return false;
      };
      B.type = function (v) { return self.typeName(v); };
      B.input = function (prompt) {
        if (prompt) self.out(String(prompt));
        return self.stdin();
      };
      B.ord = function (c) { return String(c).charCodeAt(0); };
      B.chr = function (n) { return String.fromCharCode(n); };
      B.hash = function (v) { return self.hash(v); };
      B.id = function (v) { return 0; };
      B.dir = function (v) { return Object.keys(v || {}); };
      B.help = function () { self.out('本环境为 Python 子集，暂不支持 help()。'); return null; };
      B.exit = B.quit = function () { throw pyErr('程序退出'); };

      function dedup(arr) {
        var out = [], seen = {};
        arr.forEach(function (x) {
          var h = self.hash(x);
          if (!(h in seen)) { seen[h] = 1; out.push(x); }
        });
        return out;
      }
      function flattenArgs(a) {
        if (a.length === 1 && Array.isArray(a[0])) return a[0];
        return Array.prototype.slice.call(a);
      }
      this.builtins = B;
      var g = this.global.vars;
      for (var k in B) g[k] = B[k];
    },

    /* ---------- 内置模块（只做纯计算，不碰 IO / 网络） ---------- */
    installStdlib: function () {
      var g = this.global.vars;
      var math = {
        pi: Math.PI, e: Math.E, tau: Math.PI * 2, inf: Infinity, nan: NaN,
        sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10,
        floor: Math.floor, ceil: Math.ceil, fabs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
        asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2, degrees: function (r) { return r * 180 / Math.PI; },
        radians: function (d) { return d * Math.PI / 180; }, factorial: function (n) { var r = 1; for (var i = 2; i <= n; i++) r *= i; return r; },
        gcd: function (a, b) { while (b) { var t = b; b = a % b; a = t; } return Math.abs(a); },
        hypot: function () { var s = 0; for (var i = 0; i < arguments.length; i++) s += arguments[i] * arguments[i]; return Math.sqrt(s); }
      };
      g.math = new PyModule('math', math);
      var strM = {
        ascii_lowercase: 'abcdefghijklmnopqrstuvwxyz', ascii_uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        digits: '0123456789', punctuation: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', whitespace: ' \t\n\r\x0b\x0c'
      };
      g.string = new PyModule('string', strM);
      /* 随机数：固定种子实现，保证可复现，不引入外部依赖 */
      var seed = 1;
      function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
      g.random = new PyModule('random', {
        random: rnd,
        randint: function (a, b) { return a + Math.floor(rnd() * (b - a + 1)); },
        choice: function (arr) { return arr[Math.floor(rnd() * arr.length)]; },
        shuffle: function (arr) {
          for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
          return arr;
        },
        seed: function (s) { seed = (s | 0) || 1; }
      });
      this.stdlib = { math: math, string: strM };
    },

    /* ---------- 值语义 ---------- */
    truthy: function (v) {
      if (v === null || v === undefined) return false;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string') return v.length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (v && v.__dict) return Object.keys(v.__dict).length > 0;
      return true;
    },
    hash: function (v) {
      if (typeof v === 'string') return 's' + v;
      if (typeof v === 'number') return 'n' + v;
      if (typeof v === 'boolean') return 'b' + v;
      if (v === null || v === undefined) return 'z';
      if (Array.isArray(v)) return 'a' + v.map(this.hash, this).join(',');
      return 'o' + String(v).slice(0, 40);
    },
    str: function (v) {
      if (v === null || v === undefined) return 'None';
      if (typeof v === 'boolean') return v ? 'True' : 'False';
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'number') return numStr(v);
      if (typeof v === 'string') return v;
      /* 元组打印用圆括号（S-064）。
         此前 (1,2) 打印成 [1, 2] —— 用户看到的是列表的字面量形式，
         会以为自己定义的就是列表。 */
      if (Array.isArray(v)) {
        var inner = v.map(this.repr, this).join(', ');
        if (v.length === 1 && v.__tuple) inner += ',';
        return v.__tuple ? '(' + inner + ')' : '[' + inner + ']';
      }
      if (v && v.__dict) {
        var parts = [];
        for (var k in v) {
          if (k === '__dict') continue;
          parts.push(this.repr(v[k].k !== undefined ? v[k].k : k) + ': ' + this.repr(v[k].v !== undefined ? v[k].v : v[k]));
        }
        var d = v.__dict, inner = [];
        for (var h in d) inner.push(this.repr(d[h].k) + ': ' + this.repr(d[h].v));
        return '{' + inner.join(', ') + '}';
      }
      if (v instanceof PyInstance) return '<' + v.cls.name + ' object>';
      if (v instanceof PyClass) return "<class '" + v.name + "'>";
      if (v instanceof PyModule) return "<module '" + v.name + "'>";
      if (typeof v === 'function') return '<function ' + (v.name || '?') + '>';
      if (v instanceof PyFunc) return '<function ' + v.name + '>';
      return String(v);
    },
    repr: function (v) {
      if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
      return this.str(v);
    },
    typeName: function (v) {
      if (v === null || v === undefined) return 'NoneType';
      if (typeof v === 'boolean') return 'bool';
      if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
      if (typeof v === 'string') return 'str';
      if (Array.isArray(v)) return 'list';
      if (v && v.__dict) return 'dict';
      if (v instanceof PyInstance) return v.cls.name;
      if (v instanceof PyClass) return 'type';
      if (v instanceof PyModule) return 'module';
      if (v instanceof PyFunc || typeof v === 'function') return 'function';
      return 'object';
    },
    compare: function (a, b) {
      /* ⚠ 回退到"字符串比较"前必须先检查类型是否可比（S-060）。
         此前 `1 < 'a'` 走到 str() 回退分支，比较 "1" 与 "a" 得 True ——
         真 Python 抛 TypeError: '<' not supported between instances of 'int' and 'str'。
         静默给一个"看起来有道理"的答案，比报错危险得多：
         用户会以为 Python 的数字和字符串可以互相比较。
         只有 None 参与时才报（真 Python 也是这个错）；
         其余不可比组合同样报，不回退到字符串。 */
      if (typeof a !== typeof b) {
        var ta = this.typeName(a), tb = this.typeName(b);
        var numA = typeof a === 'number', numB = typeof b === 'number';
        var strA = typeof a === 'string', strB = typeof b === 'string';
        if (!((numA && numB) || (strA && strB))) {
          throw pyErr("TypeError: '<' not supported between instances of '" + ta + "' and '" + tb + "'");
        }
      }
      if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : (a < b ? -1 : 1);
      if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : (a < b ? -1 : 1);
      if (Array.isArray(a) && Array.isArray(b)) {
        var n = Math.min(a.length, b.length);
        for (var i = 0; i < n; i++) {
          var c = this.compare(a[i], b[i]);
          if (c) return c;
        }
        return a.length - b.length;
      }
      var sa = this.str(a), sb = this.str(b);
      return sa === sb ? 0 : (sa < sb ? -1 : 1);
    },

    /* ---------- 入口 ---------- */
    run: function (src, opts) {
      opts = opts || {};
      this.steps = 0;
      this.deadline = opts.timeout ? Date.now() + opts.timeout : 0;
      var toks = tokenize(src);
      var tree = new Parser(toks).parse();
      this.execBlock(tree.body, this.global);
      return { steps: this.steps, realSec: PERF.toRealSec(this.steps), realText: PERF.human(this.steps) };
    },

    execBlock: function (body, scope) {
      for (var i = 0; i < body.length; i++) {
        var st = body[i];
        if (!st || st.type === 'Pass') continue;
        var r = this.exec(st, scope);
        if (r) throw r;
      }
    },

    exec: function (node, scope) {
      this.tick();
      switch (node.type) {
        case 'Expr': this.eval(node.value, scope); return null;
        case 'Assign': return this.execAssign(node, scope);
        case 'AugAssign': return this.execAugAssign(node, scope);
        case 'If':
          if (this.truthy(this.eval(node.test, scope))) return this.execBlock(node.body, scope);
          if (node.orelse) return this.execBlock(node.orelse, scope);
          return null;
        case 'While': return this.execWhile(node, scope);
        case 'For': return this.execFor(node, scope);
        case 'FuncDef': return this.execFuncDef(node, scope);
        case 'ClassDef': return this.execClassDef(node, scope);
        case 'Return': throw new PyReturn(node.value ? this.eval(node.value, scope) : null);
        case 'Break': throw new PyBreak();
        case 'Continue': throw new PyContinue();
        case 'Global': node.names.forEach(function (n) { scope.vars['__global_' + n] = true; }); return null;
        case 'Del': return this.execDel(node, scope);
        case 'Raise': {
          var e = node.value ? this.eval(node.value, scope) : new Error('');
          throw new PyRaise(e instanceof Error ? e : new Error(this.str(e)));
        }
        case 'Assert':
          if (!this.truthy(this.eval(node.test, scope))) {
            throw pyErr('断言失败' + (node.msg ? '：' + this.str(this.eval(node.msg, scope)) : ''));
          }
          return null;
        case 'Import': return this.execImport(node, scope);
        case 'ImportFrom': return this.execImportFrom(node, scope);
        case 'Try': return this.execTry(node, scope);
        default: throw pyErr('暂不支持的语句：' + node.type);
      }
    },

    execAssign: function (node, scope) {
      var val = this.eval(node.value, scope);
      if (node.targets.length > 1) {
        if (!Array.isArray(val)) throw pyErr('无法解包：右侧不是序列');
        if (val.length !== node.targets.length) throw pyErr('解包数量不匹配：' + node.targets.length + ' 对 ' + val.length);
        for (var i = 0; i < node.targets.length; i++) this.assignTo(node.targets[i], val[i], scope);
        return null;
      }
      var t = node.targets[0];
      if (t.type === 'Name' && (val === undefined)) throw pyErr('赋值右侧无值');
      this.assignTo(t, val, scope);
      return null;
    },

    assignTo: function (target, val, scope) {
      if (target.type === 'Name') {
        if (scope.vars['__global_' + target.id]) {
          var g = scope; while (!g.isGlobal) g = g.parent;
          g.set(target.id, val);
        } else scope.set(target.id, val);
        return;
      }
      if (target.type === 'Tuple') {
        if (!Array.isArray(val)) {
          if (val && val.__pyiter) val = val.__pyiter();
          else throw pyErr('无法解包：右侧不是序列');
        }
        if (val.length !== target.elts.length) throw pyErr('解包数量不匹配：' + target.elts.length + ' 对 ' + val.length);
        for (var i = 0; i < target.elts.length; i++) this.assignTo(target.elts[i], val[i], scope);
        return;
      }
      if (target.type === 'Subscript') {
        var obj = this.eval(target.value, scope);
        /* 元组不可变 */
        if (obj && obj.__tuple) throw pyErr("TypeError: 'tuple' object does not support item assignment");
        var idx = this.evalIndex(target.slice, scope);
        if (Array.isArray(obj)) {
          if (idx.index !== undefined) {
            var k = idx.index < 0 ? obj.length + idx.index : idx.index;
            obj[k] = val;
          } else if (Array.isArray(idx)) {
            var rep = Array.isArray(val) ? val : [val];
            obj.splice.apply(obj, [idx[0] < 0 ? obj.length + idx[0] : idx[0], idx[1] - idx[0]].concat(rep));
          } else obj[idx] = val;
        } else if (obj && obj.__dict) {
          obj.__dict[this.hash(idx)] = { k: idx, v: val };
        } else if (typeof obj === 'object') {
          obj[idx] = val;
        } else throw pyErr('对象不支持下标赋值：' + this.typeName(obj));
        return;
      }
      if (target.type === 'Attribute') {
        var o = this.eval(target.value, scope);
        if (o instanceof PyInstance) o.attrs[target.attr] = val;
        else if (o && o.__dict) o.__dict[target.attr] = val;
        else if (typeof o === 'object') o[target.attr] = val;
        else throw pyErr('对象不支持属性赋值：' + this.typeName(o));
        return;
      }
      throw pyErr('无法赋值给该目标：' + target.type);
    },

    execAugAssign: function (node, scope) {
      var cur = this.eval(node.target, scope);
      var val = this.eval(node.value, scope);
      this.assignTo(node.target, this.binop(node.op, cur, val), scope);
      return null;
    },

    execDel: function (node, scope) {
      var t = node.target;
      if (t.type === 'Name') { scope.del(t.id); return null; }
      if (t.type === 'Subscript') {
        var obj = this.eval(t.value, scope);
        var idx = this.evalIndex(t.slice, scope);
        if (Array.isArray(obj)) obj.splice(idx, 1);
        else if (obj && obj.__dict) delete obj.__dict[this.hash(idx)];
        return null;
      }
      throw pyErr('暂不支持的 del 目标');
    },

    execWhile: function (node, scope) {
      var n = 0;
      /* while 的 else 同样只在正常结束时执行（S-062），break 出去不执行 */
      var wbroken = false;
      while (this.truthy(this.eval(node.test, scope))) {
        this.tick();
        try { this.execBlock(node.body, scope); }
        catch (e) {
          if (e instanceof PyBreak) { wbroken = true; break; }
          if (e instanceof PyContinue) continue;
          throw e;
        }
        if (++n > 20000000) {
          throw pyErr('单次循环超过 2000 万次，本环境停止执行。\n' +
            '这不代表你的程序会超时 —— 请用小规模实测外推判断。');
        }
      }
      if (node.orelse && !wbroken) this.execBlock(node.orelse, scope);
      return null;
    },

    execFor: function (node, scope) {
      var it = this.eval(node.iter, scope);
      var arr = this.iterable(it);
      /* ⚠ for/while 的 else 只在**正常结束**时执行，break 出去时不执行（S-062）。
         此前无条件执行 orelse，于是 `for ... break` 之后 else 照跑 ——
         真 Python 里 else 的语义正是"没被 break 打断"，
         这个错会让用户用错一个本来就冷门但很有用的语法。 */
      var broken = false;
      for (var i = 0; i < arr.length; i++) {
        this.tick();
        this.assignTo(node.target, arr[i], scope);
        try { this.execBlock(node.body, scope); }
        catch (e) {
          if (e instanceof PyBreak) { broken = true; break; }
          if (e instanceof PyContinue) continue;
          throw e;
        }
      }
      if (node.orelse && !broken) this.execBlock(node.orelse, scope);
      return null;
    },

    iterable: function (v) {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') return v.split('');
      if (v && v.__dict) return Object.keys(v.__dict).map(function (h) { return v.__dict[h].k; });
      if (v && typeof v === 'object' && typeof v.__pyiter === 'function') return v.__pyiter();
      throw pyErr('对象不可迭代：' + this.typeName(v));
    },

    execFuncDef: function (node, scope) {
      var defaults = node.args.defaults.map(function (d) { return d === undefined ? undefined : null; });
      var self = this;
      var rawDefaults = node.args.defaults;
      var fn = new PyFunc(node, scope, node.name, rawDefaults);
      scope.set(node.name, fn);
      return null;
    },

    execClassDef: function (node, scope) {
      var clsScope = new Scope(scope);
      clsScope.set('__name__', node.name);
      var self = this;
      try { this.execBlock(node.body, clsScope); }
      catch (e) { if (!(e instanceof PyReturn)) throw e; }
      var dict = {};
      /* 只排除内部标记 __name__，必须保留 __init__ 等双下划线方法 */
      for (var k in clsScope.vars) if (k !== '__name__') dict[k] = clsScope.vars[k];
      var bases = node.bases.map(function (b) { return self.eval(b, scope); });
      scope.set(node.name, new PyClass(node.name, bases, dict));
      return null;
    },

    execImport: function (node, scope) {
      for (var i = 0; i < node.mods.length; i++) {
        var m = node.mods[i];
        var mod = this.global.vars[m.path[0]];
        if (mod === undefined) {
          throw pyErr('暂不支持导入外部模块：' + m.name +
            '。本环境可用的内置模块：math、random、string。');
        }
        for (var j = 1; j < m.path.length; j++) {
          mod = mod && mod.dict ? mod.dict[m.path[j]] : undefined;
        }
        scope.set(m.alias || m.path[0], mod);
      }
      return null;
    },

    execImportFrom: function (node, scope) {
      var mod = this.global.vars[node.path[0]];
      if (mod === undefined) {
        throw pyErr('暂不支持导入外部模块：' + node.module +
          '。本环境可用的内置模块：math、random、string。');
      }
      var src = mod.dict || mod;
      for (var i = 0; i < node.names.length; i++) {
        var nm = node.names[i];
        if (nm.name === '*') {
          for (var k in src) scope.set(k, src[k]);
          continue;
        }
        if (!(nm.name in src)) throw pyErr('无法从 ' + node.module + ' 导入 ' + nm.name);
        scope.set(nm.alias || nm.name, src[nm.name]);
      }
      return null;
    },

    execTry: function (node, scope) {
      var err = null;
      try { this.execBlock(node.body, scope); }
      catch (e) {
        if (e instanceof PyRaise) err = e.err;
        else if (e instanceof PyBreak || e instanceof PyContinue || e instanceof PyReturn) throw e;
        else err = e;
      }
      if (err) {
        for (var i = 0; i < node.handlers.length; i++) {
          var h = node.handlers[i];
          var hs = new Scope(scope);
          if (h.name) hs.set(h.name, err);
          this.execBlock(h.body, hs);
          err = null;
          break;
        }
      } else if (node.orelse) this.execBlock(node.orelse, scope);
      if (node.finalbody) this.execBlock(node.finalbody, scope);
      if (err) throw err;
      return null;
    },

    /* ---------- 表达式求值 ---------- */
    eval: function (node, scope) {
      this.tick();
      if (!node) return null;
      switch (node.type) {
        case 'Num': return node.value;
        case 'Str': return node.value;
        case 'Bytes': return node.value;
        case 'Bool': return node.value;
        case 'None': return null;
        case 'Name':
          try { return scope.get(node.id); }
          catch (e) {
            if (node.id in this.builtins) return this.builtins[node.id];
            throw e;
          }
        case 'List': return node.elts.map(function (x) { return this.eval(x, scope); }, this);
        /* ⚠ 元组必须区别于列表（S-058）。
           此前 (1,2) 求出来就是普通数组，于是 `t[0]=9` 静默成功、
           `t.append(3)` 也成功、打印成 [9, 2] ——
           用户会以为 Python 的元组可以改，而真 Python 抛 TypeError。
           "支持了但行为错"比"不支持"更有害：学错了概念。 */
        case 'Tuple': {
          var tv = node.elts.map(function (x) { return this.eval(x, scope); }, this);
          tv.__tuple = true;
          return tv;
        }
        case 'Set': {
          var out = [], seen = {};
          for (var i = 0; i < node.elts.length; i++) {
            var v = this.eval(node.elts[i], scope);
            var h = this.hash(v);
            if (!(h in seen)) { seen[h] = 1; out.push(v); }
          }
          return out;
        }
        case 'Dict': {
          var d = { __dict: {} };
          for (var j = 0; j < node.keys.length; j++) {
            var k = this.eval(node.keys[j], scope);
            d.__dict[this.hash(k)] = { k: k, v: this.eval(node.values[j], scope) };
          }
          return d;
        }
        case 'FStr': return this.evalFStr(node, scope);
        case 'BinOp': return this.binop(node.op, this.eval(node.left, scope), this.eval(node.right, scope));
        case 'UnaryOp': return this.unaryop(node.op, this.eval(node.operand, scope));
        case 'BoolOp': return this.boolop(node, scope);
        case 'Compare': return this.compareOp(node, scope);
        case 'IfExp':
          return this.truthy(this.eval(node.test, scope))
            ? this.eval(node.body, scope) : this.eval(node.orelse, scope);
        case 'Call': return this.callExpr(node, scope);
        case 'Attribute': return this.getAttribute(node, scope);
        case 'Subscript': return this.subscriptExpr(node, scope);
        case 'Lambda': return new PyFunc({ args: { names: node.names, defaults: [] }, body: [{ type: 'Return', value: node.body }] }, scope, '<lambda>', []);
        case 'ListComp': return this.evalComp(node, scope, 'list');
        case 'DictComp': return this.evalComp(node, scope, 'dict');
        case 'GenExp': return this.evalComp(node, scope, 'list');
        default: throw pyErr('暂不支持的表达式：' + node.type);
      }
    },

    evalFStr: function (node, scope) {
      var s = '', self = this;
      node.parts.forEach(function (p) {
        if (p.lit !== undefined) { s += p.lit; return; }
        var sub = new Parser(p.tok.concat([{ t: 'EOF' }]));
        var e = sub.expr();
        s += self.str(self.eval(e, scope));
      });
      return s;
    },

    /* ⚠ 超过 2^53 的整数必须走 BigInt（S-057）。
       此前 `2**64` → 18446744073709552000（真值 ...551616），
       `x = 9007199254740992; x + 1` → **x 不变**。
       数字走 JS double，超过 2^53 后相邻整数无法区分 ——
       不报错，只是答案错。而"任意精度整数"正是 Python 的核心优势之一，
       竞赛题常依赖它，静默丢精度等于直接判错。
       只在两端都是整数时启用，浮点路径完全不动，把风险圈在最小范围。 */
    bigSafe: function (v) { return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER; },
    bigBin: function (op, a, b) {
      var BA = BigInt(a), BB = BigInt(b);
      switch (op) {
        case '+': return BA + BB;
        case '-': return BA - BB;
        case '*': return BA * BB;
        default: return null;
      }
    },

    binop: function (op, a, b) {
      /* 大整数：两端都是整数且任一超出安全范围 → 用 BigInt 精确算。
         ⚠ 已是大整数（bigint）的操作数也要接进来 ——
         否则 `2**64 - 1` 会因为一端是 bigint 而掉到普通分支报"- 需要数字"。 */
      if ((op === '+' || op === '-' || op === '*')) {
        var aB = typeof a === 'bigint', bB = typeof b === 'bigint';
        var aN = aB ? a : (typeof a === 'number' && Number.isInteger(a) ? BigInt(a) : null);
        var bN = bB ? b : (typeof b === 'number' && Number.isInteger(b) ? BigInt(b) : null);
        if (aN !== null && bN !== null && (aB || bB || !this.bigSafe(a) || !this.bigSafe(b))) {
          var big2 = (op === '+' ? aN + bN : op === '-' ? aN - bN : aN * bN);
          return (big2 <= BigInt(Number.MAX_SAFE_INTEGER) && big2 >= -BigInt(Number.MAX_SAFE_INTEGER))
            ? Number(big2) : big2;
        }
      }
      switch (op) {
        case '+':
          if (typeof a === 'string' && typeof b === 'string') return a + b;
          if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
          /* ⚠ bool 在 Python 里是 int 的子类（S-059）。
             此前 `True+1` 报错、`True==1` 却是 False、而 `sum([True,True])` 是 2 ——
             **三种行为互相矛盾**，用户无法通过一条推断另一条。
             真 Python：True+1 == 2，True == 1 为 True。
             统一：bool 参与算术时按 1/0。 */
          if (typeof a === 'boolean') a = a ? 1 : 0;
          if (typeof b === 'boolean') b = b ? 1 : 0;
          if (typeof a !== 'number' || typeof b !== 'number') throw pyErr('+ 不支持的类型：' + this.typeName(a) + ' 与 ' + this.typeName(b));
          return a + b;
        case '-':
          if (typeof a === 'boolean') a = a ? 1 : 0;
          if (typeof b === 'boolean') b = b ? 1 : 0;
          if (typeof a !== 'number' || typeof b !== 'number') throw pyErr('- 需要数字');
          return a - b;
        case '*':
          /* bool 参与算术按 1/0（S-059），与 + 保持同一套规则 */
          if (typeof a === 'boolean') a = a ? 1 : 0;
          if (typeof b === 'boolean') b = b ? 1 : 0;
          if (typeof a === 'boolean' || typeof b === 'boolean') { }
          if (typeof a === 'number' && typeof b === 'string') return b.repeat(Math.max(0, a));
          if (typeof a === 'string' && typeof b === 'number') return a.repeat(Math.max(0, b));
          if (Array.isArray(a) && typeof b === 'number') { var r = []; for (var i = 0; i < Math.max(0, b); i++) r = r.concat(a); return r; }
          if (typeof a !== 'number' || typeof b !== 'number') throw pyErr('* 不支持的类型');
          return a * b;
        case '/':
          if (typeof a !== 'number' || typeof b !== 'number') throw pyErr('/ 需要数字');
          if (b === 0) throw pyErr('除零错误');
          return a / b;
        case '//':
          if (typeof a !== 'number' || typeof b !== 'number') throw pyErr('// 需要数字');
          if (b === 0) throw pyErr('除零错误');
          return Math.floor(a / b);
        case '%':
          if (typeof a === 'string') {
            try { return formatPercent(a, b); } catch (e) { throw pyErr('% 格式化失败'); }
          }
          if (typeof a !== 'number' || typeof b !== 'number') throw pyErr('% 需要数字');
          if (b === 0) throw pyErr('取模错误：除数为零');
          return a - b * Math.floor(a / b);
        case '**':
          /* 大整数幂：2**64 必须精确。pow 的结果若超安全范围就走 BigInt */
          if (typeof a === 'number' && typeof b === 'number' &&
              Number.isInteger(a) && Number.isInteger(b) && b >= 0 && b <= 1024 &&
              Math.abs(Math.pow(Math.abs(a), b)) > Number.MAX_SAFE_INTEGER) {
            var pb = BigInt(a) ** BigInt(b);
            return (pb <= BigInt(Number.MAX_SAFE_INTEGER) && pb >= -BigInt(Number.MAX_SAFE_INTEGER)) ? Number(pb) : pb;
          }
          if (typeof a !== 'number' || typeof b !== 'number') throw pyErr('** 需要数字');
          return Math.pow(a, b);
      }
      throw pyErr('暂不支持的运算符：' + op);
    },

    unaryop: function (op, v) {
      if (op === 'not') return !this.truthy(v);
      if (typeof v !== 'number') throw pyErr('该运算需要数字：' + op);
      if (op === '-') return -v;
      if (op === '+') return +v;
      if (op === '~') return ~v;
      throw pyErr('暂不支持的运算符：' + op);
    },

    boolop: function (node, scope) {
      var l = this.eval(node.values[0], scope);
      if (node.op === 'and') {
        if (!this.truthy(l)) return l;
        return this.eval(node.values[1], scope);
      }
      if (this.truthy(l)) return l;
      return this.eval(node.values[1], scope);
    },

    compareOp: function (node, scope) {
      var a = this.eval(node.left, scope);
      var b = this.eval(node.right, scope);
      switch (node.op) {
        case '==': return this.eq(a, b);
        case '!=': return !this.eq(a, b);
        case '<': return this.compare(a, b) < 0;
        case '<=': return this.compare(a, b) <= 0;
        case '>': return this.compare(a, b) > 0;
        case '>=': return this.compare(a, b) >= 0;
        case 'is': return a === b;
        case 'is not': return a !== b;
        case 'in': return this.contains(b, a);
        case 'not in': return !this.contains(b, a);
      }
      throw pyErr('暂不支持的比较：' + node.op);
    },

    eq: function (a, b) {
      /* bool 与数字可比（S-059）：真 Python 里 True == 1 为 True，
         因为 bool 是 int 的子类。此前 `True+1` 报错、`True==1` 为 False、
         而 `sum([True,True])` 是 2 —— 三种行为互相矛盾。 */
      if (typeof a === 'boolean') a = a ? 1 : 0;
      if (typeof b === 'boolean') b = b ? 1 : 0;
      if (typeof a === 'number' && typeof b === 'number') return a === b;
      if (typeof a === 'string' && typeof b === 'string') return a === b;
      if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
      if (a === null && b === null) return true;
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (!this.eq(a[i], b[i])) return false;
        return true;
      }
      if (a && a.__dict && b && b.__dict) {
        var ka = Object.keys(a.__dict), kb = Object.keys(b.__dict);
        if (ka.length !== kb.length) return false;
        for (var j = 0; j < ka.length; j++) {
          if (!(kb.indexOf(ka[j]) >= 0)) return false;
        }
        return true;
      }
      return a === b;
    },

    contains: function (container, item) {
      if (typeof container === 'string') return container.indexOf(String(item)) >= 0;
      if (Array.isArray(container)) {
        for (var i = 0; i < container.length; i++) if (this.eq(container[i], item)) return true;
        return false;
      }
      if (container && container.__dict) {
        for (var h in container.__dict) if (this.eq(container.__dict[h].k, item)) return true;
        return false;
      }
      throw pyErr('对象不支持 in 判断：' + this.typeName(container));
    },

    subscriptExpr: function (node, scope) {
      var obj = this.eval(node.value, scope);
      var idx = this.evalIndex(node.slice, scope);
      if (Array.isArray(idx)) {
        /* 切片 */
        var arr = Array.isArray(obj) ? obj : this.iterable(obj);
        var step2 = (idx[2] === null || idx[2] === undefined) ? 1 : idx[2];
        var start = idx[0] === null || idx[0] === undefined
          ? (step2 > 0 ? 0 : arr.length - 1)
          : normIdx(idx[0], arr.length);
        var stop = idx[1] === null || idx[1] === undefined
          ? (step2 > 0 ? arr.length : -1)
          : normIdx(idx[1], arr.length);
        var step = step2;
        var out = [];
        if (step > 0) { for (var i = Math.max(0, start); i < Math.min(arr.length, stop); i += step) out.push(arr[i]); }
        /* 负步长时 stop 同样是不含的端点：a[3:1:-1] 应得 [4,3] 而非 [4,3,2]。
           默认到头时 stop 传 -1，stop+1=0 正好落在下标 0。 */
        else if (step < 0) { for (var j = Math.min(arr.length - 1, start); j >= Math.max(0, stop + 1); j += step) out.push(arr[j]); }
        return typeof obj === 'string' ? out.join('') : out;
      }
      if (Array.isArray(obj)) {
        var k = idx < 0 ? obj.length + idx : idx;
        if (k < 0 || k >= obj.length) throw pyErr('下标越界：' + idx + '（长度 ' + obj.length + '）');
        return obj[k];
      }
      if (typeof obj === 'string') {
        var k2 = idx < 0 ? obj.length + idx : idx;
        if (k2 < 0 || k2 >= obj.length) throw pyErr('下标越界：' + idx);
        return obj[k2];
      }
      if (obj && obj.__dict) {
        var rec = obj.__dict[this.hash(idx)];
        if (!rec) throw pyErr('键不存在：' + this.str(idx));
        return rec.v;
      }
      if (obj && obj.dict) return obj.dict[idx];
      throw pyErr('对象不支持下标：' + this.typeName(obj));
    },

    evalIndex: function (slice, scope) {
      if (slice.index !== undefined) return this.eval(slice.index, scope);
      if (Array.isArray(slice)) {
        return [
          slice[0] ? (slice[0].lower !== undefined ? this.eval(slice[0].lower, scope) : (slice[0].index !== undefined ? this.eval(slice[0].index, scope) : 0)) : 0,
          slice[0] ? (slice[0].upper ? this.eval(slice[0].upper, scope) : (slice[0].index !== undefined ? this.eval(slice[0].index, scope) + 1 : null)) : null,
          slice[0] && slice[0].step !== undefined ? (slice[0].step ? this.eval(slice[0].step, scope) : 1) : 1
        ];
      }
      if (slice.tuple) return slice.tuple.map(function (s) { return this.evalIndex(s, scope); }, this);
      /* lower 未指定时返回 null，由 subscriptExpr 按步长正负决定默认起点：
         正步长从头、负步长从尾。这里若默认给 0，[::-1] 就只会倒着取到下标 0。 */
      return [
        slice.lower !== null && slice.lower !== undefined ? this.eval(slice.lower, scope) : null,
        slice.upper !== null && slice.upper !== undefined ? this.eval(slice.upper, scope) : null,
        slice.step !== null && slice.step !== undefined ? this.eval(slice.step, scope) : null
      ];
    },

    getAttribute: function (node, scope) {
      var obj = this.eval(node.value, scope);
      var n = node.attr;
      if (obj instanceof PyInstance) {
        if (n in obj.attrs) return obj.attrs[n];
        var m = obj.cls.dict[n];
        if (m !== undefined) return new PyMethod(m, obj);
        var c = obj.cls.bases[0];
        while (c) {
          if (c.dict && c.dict[n] !== undefined) return new PyMethod(c.dict[n], obj);
          c = c.bases[0];
        }
        throw pyErr(obj.cls.name + ' 对象没有属性：' + n);
      }
      if (obj instanceof PyModule) {
        if (!(n in obj.dict)) throw pyErr('模块 ' + obj.name + ' 没有属性：' + n);
        return obj.dict[n];
      }
      if (typeof obj === 'string') return strMethods(n, obj, this);
      if (Array.isArray(obj)) return listMethods(n, obj, this);
      if (obj && obj.__dict) return dictMethods(n, obj, this);
      if (obj && typeof obj === 'object' && n in obj) return obj[n];
      throw pyErr('对象没有属性：' + n + '（类型 ' + this.typeName(obj) + '）');
    },

    callExpr: function (node, scope) {
      var fn = this.eval(node.func, scope);
      var args = node.args.map(function (a) { return this.eval(a.value, scope); }, this);
      var kwargs = {};
      node.kwargs.forEach(function (k) { kwargs[k.name] = this.eval(k.value, scope); }, this);
      return this.call(fn, args, kwargs);
    },

    call: function (fn, args, kwargs) {
      kwargs = kwargs || {};
      if (typeof fn === 'function') {
        /* 内置函数：默认按位置传参；若带关键字实参且注册时记过参数名，按名字补位 */
        var kwKeys = Object.keys(kwargs || {});
        if (fn.__pyargs && kwKeys.length) {
          var argv = args.slice();
          fn.__pyargs.forEach(function (nm, i) {
            if (kwargs[nm] !== undefined) argv[i] = kwargs[nm];
          });
          /* 注册时未列出的关键字（如 print 的 sep/end）整包追加，由函数自行读取 */
          var known = fn.__pyargs;
          var extra = {};
          var hasExtra = false;
          kwKeys.forEach(function (k) { if (known.indexOf(k) < 0) { extra[k] = kwargs[k]; hasExtra = true; } });
          if (hasExtra) { extra.__kw = extra; argv.push(extra); }
          return fn.apply(null, argv);
        }
        return fn.apply(null, args);
      }
      if (fn instanceof PyMethod) {
        return this.callFunc(fn.fn, [fn.self].concat(args), kwargs);
      }
      if (fn instanceof PyClass) {
        var inst = new PyInstance(fn);
        var init = fn.dict.__init__;
        if (init) this.callFunc(init, [inst].concat(args), kwargs);
        return inst;
      }
      if (fn instanceof PyFunc) return this.callFunc(fn, args, kwargs);
      throw pyErr('对象不可调用：' + this.typeName(fn));
    },

    callFunc: function (fn, args, kwargs) {
      var node = fn.node;
      var spec = node.args || { names: [], defaults: [] };
      var sc = new Scope(fn.scope);
      var names = spec.names || [];
      var i;
      for (i = 0; i < names.length; i++) {
        if (i < args.length) sc.set(names[i], args[i]);
        else if (kwargs[names[i]] !== undefined) sc.set(names[i], kwargs[names[i]]);
        else {
          var di = i - (names.length - (spec.defaults || []).length);
          if (di >= 0 && spec.defaults[di] !== undefined) sc.set(names[i], this.eval(spec.defaults[di], fn.scope));
          else sc.set(names[i], null);
        }
      }
      if (spec.star) sc.set(spec.star, args.slice(names.length));
      if (spec.kwstar) sc.set(spec.kwstar, kwargs);
      try {
        this.execBlock(node.body, sc);
      } catch (e) {
        if (e instanceof PyReturn) return e.value;
        if (e instanceof PyRaise) throw e.err;
        throw e;
      }
      return null;
    },

    evalComp: function (node, scope, kind) {
      var self = this;
      function rec(gi, env) {
        if (gi >= node.generators.length) {
          /* 字典推导保留键值原类型，不能拼成字符串 */
          if (kind === 'dict') return [self.eval(node.key, env), self.eval(node.value, env)];
          return self.eval(node.elt, env);
        }
        var g = node.generators[gi];
        var arr = self.iterable(self.eval(g.iter, env));
        var out = [];
        for (var i = 0; i < arr.length; i++) {
          self.tick();
          var sub = new Scope(env);
          self.assignTo(g.target, arr[i], sub);
          var ok = true;
          for (var j = 0; j < g.ifs.length; j++) if (!self.truthy(self.eval(g.ifs[j], sub))) { ok = false; break; }
          if (!ok) continue;
          var r = rec(gi + 1, sub);
          /* ⚠ 只有"中间层"的递归结果才展开，最后一层的元素本身要整体 push（S-061）。
             此前对任何数组都 concat，于是 `[[i,j] for i in range(2) for j in range(2)]`
             被扁平成 8 个标量（真 Python 是 4 个二元列表），而且不报错 ——
             用户拿到一个长度翻倍的一维列表，完全无从察觉。
             判据：gi+1 已经到最后一层时，r 就是元素，不是待展开的中间结果。 */
          if (kind === 'dict') out.push(r);
          else if (gi + 1 >= node.generators.length) out.push(r);
          else if (Array.isArray(r)) out = out.concat(r);
          else out.push(r);
        }
        return out;
      }
      var res = rec(0, scope);
      if (kind === 'dict') {
        var d = { __dict: {} };
        res.forEach(function (pair) {
          d.__dict[self.hash(pair[0])] = { k: pair[0], v: pair[1] };
        });
        return d;
      }
      return res;
    }
  };

  /* ---------- 字符串方法 ---------- */
  function strMethods(n, s, I) {
    var f = {
      upper: function () { return s.toUpperCase(); },
      lower: function () { return s.toLowerCase(); },
      title: function () { return s.replace(/\w\S*/g, function (t) { return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(); }); },
      capitalize: function () { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); },
      strip: function (c) { return c ? s.replace(new RegExp('^[' + c + ']+|[' + c + ']+$', 'g'), '') : s.trim(); },
      lstrip: function (c) { return c ? s.replace(new RegExp('^[' + c + ']+'), '') : s.replace(/^\s+/, ''); },
      rstrip: function (c) { return c ? s.replace(new RegExp('[' + c + ']+$'), '') : s.replace(/\s+$/, ''); },
      split: function (sep, max) { return sep === undefined || sep === '' ? s.trim().split(/\s+/) : s.split(sep); },
      rsplit: function (sep) { return s.split(sep || ' '); },
      join: function (arr) { return (arr || []).join(s); },
      replace: function (a, b, c) { return c === undefined ? s.split(a).join(b) : s.split(a).slice(0, c + 1).join(b) + (s.split(a).length > c + 1 ? a + s.split(a).slice(c + 1).join(a) : ''); },
      find: function (sub) { return s.indexOf(sub); },
      rfind: function (sub) { return s.lastIndexOf(sub); },
      index: function (sub) { var i = s.indexOf(sub); if (i < 0) throw pyErr('子串不存在'); return i; },
      count: function (sub) { return s.split(sub).length - 1; },
      startswith: function (p) { return s.indexOf(p) === 0; },
      endswith: function (p) { return s.length >= p.length && s.lastIndexOf(p) === s.length - p.length; },
      format: function () {
        var a = arguments, out = s, idx = 0;
        out = out.replace(/\{\}|\{(\d+)\}|\{(\w+)\}/g, function (m, num, name) {
          var v;
          if (num !== undefined) v = a[parseInt(num, 10)];
          else if (name !== undefined) v = a[0] && typeof a[0] === 'object' ? a[0][name] : undefined;
          else v = a[idx++];
          return v === undefined ? m : I.str(v);
        });
        return out;
      },
      zfill: function (w) { return s.padStart(w, '0'); },
      ljust: function (w, c) { return s.padEnd(w, c || ' '); },
      rjust: function (w, c) { return s.padStart(w, c || ' '); },
      center: function (w, c) {
        var p = Math.max(0, w - s.length), l = Math.floor(p / 2);
        return (c || ' ').repeat(l) + s + (c || ' ').repeat(p - l);
      },
      isdigit: function () { return /^\d+$/.test(s); },
      isalpha: function () { return /^[A-Za-z]+$/.test(s); },
      isalnum: function () { return /^[A-Za-z0-9]+$/.test(s); },
      isspace: function () { return /^\s+$/.test(s); },
      isupper: function () { return s === s.toUpperCase() && /[A-Z]/.test(s); },
      islower: function () { return s === s.toLowerCase() && /[a-z]/.test(s); },
      swapcase: function () { return s.replace(/[a-zA-Z]/g, function (c) { return c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase(); }); },
      encode: function () { return s; },
      partition: function (sep) { var i = s.indexOf(sep); return i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)]; }
    };
    if (!(n in f)) throw pyErr('字符串没有方法：' + n);
    return f[n];
  }

  /* ---------- 列表方法 ---------- */
  /* 元组只有不可变方法。此前 (1,2).append(3) 静默成功（S-058）——
     元组内部就是数组，于是列表的方法全都能用。
     真 Python 抛 AttributeError: 'tuple' object has no attribute 'append'。 */
  var TUPLE_MUTATORS = ('append extend insert remove pop clear sort reverse').split(' ');

  function listMethods(n, arr, I) {
    if (arr && arr.__tuple && TUPLE_MUTATORS.indexOf(n) >= 0) {
      throw pyErr("AttributeError: 'tuple' object has no attribute '" + n + "'");
    }
    var f = {
      append: function (v) { arr.push(v); return null; },
      extend: function (v) { I.iterable(v).forEach(function (x) { arr.push(x); }); return null; },
      insert: function (i, v) { arr.splice(i < 0 ? arr.length + i : i, 0, v); return null; },
      remove: function (v) {
        for (var i = 0; i < arr.length; i++) if (I.eq(arr[i], v)) { arr.splice(i, 1); return null; }
        throw pyErr('remove：值不在列表中');
      },
      pop: function (i) {
        if (i === undefined) return arr.length ? arr.pop() : null;
        var k = i < 0 ? arr.length + i : i;
        if (k < 0 || k >= arr.length) throw pyErr('pop：下标越界');
        return arr.splice(k, 1)[0];
      },
      clear: function () { arr.length = 0; return null; },
      index: function (v) {
        for (var i = 0; i < arr.length; i++) if (I.eq(arr[i], v)) return i;
        throw pyErr('index：值不在列表中');
      },
      count: function (v) { var c = 0; for (var i = 0; i < arr.length; i++) if (I.eq(arr[i], v)) c++; return c; },
      sort: function (keyFn, reverse) {
        var keyed = arr.map(function (x) { return { k: keyFn ? I.call(keyFn, [x]) : x, v: x }; });
        keyed.sort(function (p, q) { return I.compare(p.k, q.k); });
        var out = keyed.map(function (p) { return p.v; });
        if (reverse) out.reverse();
        for (var i = 0; i < out.length; i++) arr[i] = out[i];
        return null;
      },
      reverse: function () { arr.reverse(); return null; },
      copy: function () { return arr.slice(); },
      join: null
    };
    if (n === 'join' && typeof arr[0] !== 'string') throw pyErr('列表没有方法：join');
    if (!(n in f)) throw pyErr('列表没有方法：' + n);
    return f[n];
  }

  /* ---------- 字典方法 ---------- */
  function dictMethods(n, d, I) {
    var keys = function () { return Object.keys(d.__dict).map(function (h) { return d.__dict[h].k; }); };
    var vals = function () { return Object.keys(d.__dict).map(function (h) { return d.__dict[h].v; }); };
    var f = {
      keys: function () { return keys(); },
      values: function () { return vals(); },
      items: function () { return keys().map(function (k, i) { return [k, vals()[i]]; }); },
      get: function (k, def) {
        var r = d.__dict[I.hash(k)];
        return r ? r.v : (def === undefined ? null : def);
      },
      pop: function (k, def) {
        var h = I.hash(k), r = d.__dict[h];
        if (!r) { if (def !== undefined) return def; throw pyErr('键不存在：' + I.str(k)); }
        delete d.__dict[h];
        return r.v;
      },
      update: function (other) {
        if (other && other.__dict) {
          for (var h in other.__dict) d.__dict[h] = other.__dict[h];
        }
        return null;
      },
      clear: function () { d.__dict = {}; return null; },
      copy: function () { var n2 = { __dict: {} }; for (var h in d.__dict) n2.__dict[h] = d.__dict[h]; return n2; },
      setdefault: function (k, def) {
        var h = I.hash(k);
        if (!d.__dict[h]) d.__dict[h] = { k: k, v: def === undefined ? null : def };
        return d.__dict[h].v;
      }
    };
    if (!(n in f)) throw pyErr('字典没有方法：' + n);
    return f[n];
  }

  function normIdx(i, len) {
    if (i === null) return null;
    if (i < 0) return Math.max(0, len + i);
    return Math.min(len, i);
  }

  function numStr(v) {
    if (Number.isInteger(v)) return String(v);
    return String(parseFloat(v.toFixed(10)));
  }

  function formatPercent(fmt, arg) {
    var args = Array.isArray(arg) ? arg : [arg];
    var i = 0;
    return fmt.replace(/%([sdif%]|(?:0?\d+)?(?:\.\d+)?[fF])/g, function (m, spec) {
      if (spec === '%') return '%';
      var v = args[i++];
      if (spec === 'd' || spec === 'i') return String(Math.floor(Number(v)));
      if (spec === 's') return String(v);
      var prec = /\.(\d+)/.exec(spec);
      if (prec) return Number(v).toFixed(parseInt(prec[1], 10));
      return String(Number(v));
    });
  }

  Code.pylite = {
    tokenize: tokenize,
    parse: function (src) { return new Parser(tokenize(src)).parse(); },
    create: function (stdout, stdin) { return new Interp(stdout, stdin); },
    MAX_STEPS: MAX_STEPS,
    PERF: PERF
  };
})(typeof window !== 'undefined' ? window : globalThis);
