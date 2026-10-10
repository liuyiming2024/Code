/* highlight.js —— 手写语法着色
   不引入任何高亮库。做法：对每个语言定义一组带 sticky 标志的正则，
   从头扫到尾，未命中的字符原样输出，因此任意输入都不会卡死或报错。
   输出为已完成 HTML 转义的字符串。 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});
  var U = Code.util;

  function words(list, cls) {
    return { re: new RegExp('\\b(?:' + list.join('|') + ')\\b', 'y'), cls: cls };
  }

  var JS_KW = ['var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
    'break', 'continue', 'new', 'class', 'extends', 'super', 'this', 'typeof', 'instanceof',
    'try', 'catch', 'finally', 'throw', 'switch', 'case', 'default', 'delete', 'in', 'of',
    'void', 'yield', 'async', 'await', 'static', 'get', 'set', 'null', 'undefined', 'true',
    'false', 'NaN', 'Infinity', 'export', 'import', 'from', 'as', 'with', 'debugger'];
  var JS_BI = ['console', 'document', 'window', 'Math', 'JSON', 'Object', 'Array', 'String',
    'Number', 'Boolean', 'Date', 'Promise', 'Set', 'Map', 'RegExp', 'Error', 'Symbol',
    'BigInt', 'globalThis', 'localStorage', 'setTimeout', 'setInterval', 'fetch'];

  var PY_KW = ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not',
    'and', 'or', 'is', 'None', 'True', 'False', 'import', 'from', 'as', 'with', 'try',
    'except', 'finally', 'raise', 'lambda', 'yield', 'global', 'nonlocal', 'pass', 'break',
    'continue', 'assert', 'del', 'async', 'await', 'self'];
  var PY_BI = ['print', 'len', 'range', 'int', 'str', 'float', 'list', 'dict', 'set', 'tuple',
    'sum', 'min', 'max', 'abs', 'open', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'input'];

  var CPP_KW = ['int', 'char', 'float', 'double', 'void', 'bool', 'long', 'short', 'unsigned',
    'signed', 'auto', 'struct', 'class', 'enum', 'union', 'typedef', 'template', 'namespace',
    'using', 'public', 'private', 'protected', 'virtual', 'override', 'inline', 'const',
    'static', 'extern', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'default', 'break', 'continue', 'new', 'delete', 'this', 'try', 'catch', 'throw',
    'sizeof', 'operator', 'friend', 'explicit', 'constexpr', 'nullptr', 'true', 'false',
    'include', 'define', 'ifdef', 'endif', 'pragma', 'typename'];
  var CPP_BI = ['std', 'cout', 'cin', 'endl', 'vector', 'string', 'map', 'set', 'size_t',
    'printf', 'scanf', 'malloc', 'free', 'memcpy', 'strlen'];

  var SQL_KW = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
    'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD', 'JOIN', 'LEFT', 'RIGHT', 'INNER',
    'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT',
    'NULL', 'DISTINCT', 'HAVING', 'UNION', 'INDEX', 'PRIMARY', 'KEY', 'DEFAULT', 'BEGIN',
    'COMMIT', 'ROLLBACK'];

  var SH_KW = ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
    'esac', 'function', 'return', 'export', 'local', 'echo', 'cd', 'set', 'source', 'exit'];

  var LANGS = {
    javascript: [
      { re: /\/\/[^\n]*/y, cls: 'tk-com' },
      { re: /\/\*[\s\S]*?\*\//y, cls: 'tk-com' },
      { re: /`(?:\\.|[^`\\])*`/y, cls: 'tk-str' },
      { re: /"(?:\\.|[^"\\\n])*"/y, cls: 'tk-str' },
      { re: /'(?:\\.|[^'\\\n])*'/y, cls: 'tk-str' },
      { re: /\/[^\/\\\n]*(?:\\.[^\/\\\n]*)*\/[gimsuy]*/y, cls: 'tk-str' },
      words(JS_KW, 'tk-key'),
      words(JS_BI, 'tk-typ'),
      { re: /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'tk-num' },
      { re: /[A-Za-z_$][\w$]*(?=\s*\()/y, cls: 'tk-fun' },
      { re: /[{}()\[\];,.]/y, cls: 'tk-pun' },
      { re: /[+\-*/%=<>!&|^~?:]+/y, cls: 'tk-op' }
    ],
    python: [
      { re: /#[^\n]*/y, cls: 'tk-com' },
      { re: /"""[\s\S]*?"""|'''[\s\S]*?'''/y, cls: 'tk-str' },
      { re: /[rbfuRBFU]?"(?:\\.|[^"\\\n])*"|[rbfuRBFU]?'(?:\\.|[^'\\\n])*'/y, cls: 'tk-str' },
      words(PY_KW, 'tk-key'),
      words(PY_BI, 'tk-typ'),
      { re: /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'tk-num' },
      { re: /[A-Za-z_]\w*(?=\s*\()/y, cls: 'tk-fun' },
      { re: /@\w+/y, cls: 'tk-att' },
      { re: /[{}()\[\];,.]/y, cls: 'tk-pun' },
      { re: /[+\-*/%=<>!&|^~:]+/y, cls: 'tk-op' }
    ],
    cpp: [
      { re: /#[^\n]*/y, cls: 'tk-key' },
      { re: /\/\/[^\n]*/y, cls: 'tk-com' },
      { re: /\/\*[\s\S]*?\*\//y, cls: 'tk-com' },
      { re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y, cls: 'tk-str' },
      words(CPP_KW, 'tk-key'),
      words(CPP_BI, 'tk-typ'),
      { re: /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?[fFlL]?\b/y, cls: 'tk-num' },
      { re: /[A-Za-z_]\w*(?=\s*\()/y, cls: 'tk-fun' },
      { re: /[{}()\[\];,.]/y, cls: 'tk-pun' },
      { re: /[+\-*/%=<>!&|^~?:]+/y, cls: 'tk-op' }
    ],
    html: [
      { re: /<!--[\s\S]*?-->/y, cls: 'tk-com' },
      { re: /<!\w+[^>]*>/y, cls: 'tk-key' },
      { re: /<\/?[A-Za-z][\w:-]*/y, cls: 'tk-tag' },
      { re: /\/?>/y, cls: 'tk-tag' },
      { re: /[A-Za-z_:][\w:.-]*(?=\s*=)/y, cls: 'tk-att' },
      { re: /"(?:[^"\n]*)"|'(?:[^'\n]*)'/y, cls: 'tk-str' },
      { re: /&\w+;/y, cls: 'tk-num' },
      { re: /=/y, cls: 'tk-pun' }
    ],
    css: [
      { re: /\/\*[\s\S]*?\*\//y, cls: 'tk-com' },
      { re: /"(?:[^"\n]*)"|'(?:[^'\n]*)'/y, cls: 'tk-str' },
      { re: /@[\w-]+/y, cls: 'tk-key' },
      { re: /[.#][\w-]+|&|:{1,2}[\w-]+|::?[\w-]+/y, cls: 'tk-tag' },
      { re: /[a-zA-Z-]+(?=\s*:)/y, cls: 'tk-att' },
      { re: /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/y, cls: 'tk-num' },
      { re: /[{}();,:]/y, cls: 'tk-pun' }
    ],
    json: [
      { re: /"(?:\\.|[^"\\])*"(?=\s*:)/y, cls: 'tk-att' },
      { re: /"(?:\\.|[^"\\])*"/y, cls: 'tk-str' },
      { re: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'tk-num' },
      words(['true', 'false', 'null'], 'tk-key'),
      { re: /[{}[\],:]/y, cls: 'tk-pun' }
    ],
    markdown: [
      { re: /^#{1,6}[^\n]*/ym, cls: 'tk-key' },
      { re: /```[\s\S]*?```|`[^`\n]+`/y, cls: 'tk-str' },
      { re: /(?:^|\n)\s*(?:[-*+]\s|\d+\.\s|>\s)/y, cls: 'tk-tag' },
      { re: /\*\*[^*\n]+\*\*|__[^_\n]+__/y, cls: 'tk-typ' },
      { re: /!?\[[^\]\n]*\]\([^)\n]*\)/y, cls: 'tk-fun' },
      { re: /(?:^|\n)\s*[-=]{3,}/y, cls: 'tk-pun' }
    ],
    yaml: [
      { re: /#[^\n]*/y, cls: 'tk-com' },
      { re: /(?:^|\n)\s*[\w.-]+(?=\s*:)/y, cls: 'tk-att' },
      { re: /"(?:[^"\n]*)"|'(?:[^'\n]*)'/y, cls: 'tk-str' },
      words(['true', 'false', 'null', 'yes', 'no'], 'tk-key'),
      { re: /\b-?\d+(?:\.\d+)?\b/y, cls: 'tk-num' },
      { re: /(?:^|\n)\s*-\s/y, cls: 'tk-pun' }
    ],
    sql: [
      { re: /--[^\n]*/y, cls: 'tk-com' },
      { re: /\/\*[\s\S]*?\*\//y, cls: 'tk-com' },
      { re: /'(?:[^'\n]*)'/y, cls: 'tk-str' },
      { re: new RegExp('\\b(?:' + SQL_KW.join('|') + ')\\b', 'yi'), cls: 'tk-key' },
      { re: /\b-?\d+(?:\.\d+)?\b/y, cls: 'tk-num' },
      { re: /[(),;*]/y, cls: 'tk-pun' }
    ],
    shell: [
      { re: /#[^\n]*/y, cls: 'tk-com' },
      { re: /"(?:\\.|[^"\\])*"|'[^'\n]*'/y, cls: 'tk-str' },
      words(SH_KW, 'tk-key'),
      { re: /\$\{?\w+\}?/y, cls: 'tk-att' },
      { re: /\b\d+\b/y, cls: 'tk-num' },
      { re: /[|&;()<>]/y, cls: 'tk-pun' }
    ],
    text: []
  };

  /* 逐字符扫描，产出 [{text, cls}] */
  function tokenize(src, lang) {
    var rules = LANGS[lang] || LANGS.text || [];
    var out = [], i = 0, n = src.length, guard = 0;
    var plain = '';
    while (i < n && guard++ < 400000) {
      var hit = null;
      for (var r = 0; r < rules.length; r++) {
        var re = rules[r].re;
        re.lastIndex = i;
        var m = re.exec(src);
        if (m && m.index === i && m[0].length > 0) { hit = { text: m[0], cls: rules[r].cls }; break; }
      }
      if (hit) {
        if (plain) { out.push({ text: plain, cls: '' }); plain = ''; }
        out.push(hit);
        i += hit.text.length;
      } else {
        plain += src[i];
        i++;
      }
    }
    if (plain) out.push({ text: plain, cls: '' });
    return out;
  }

  /* 按行渲染，当前行加 curline 类（用于整行底色） */
  /* 把一行里行尾的连续空白包进 .tk-ws，只上底色不改字符，避免与输入层错位 */
  function markTrailing(html) {
    var body = html, tail = '';
    while (/<\/span>$/.test(body)) { tail = '</span>' + tail; body = body.slice(0, body.length - 7); }
    var m = /([\t ]+)$/.exec(body);
    if (!m) return html;
    return body.slice(0, m.index) + '<span class="tk-ws">' + m[1] + '</span>' + tail;
  }

  function render(src, lang, currentLine, opts) {
    opts = opts || {};
    var showWS = !!opts.showWS;
    var pieces = tokenize(src, lang || 'text');
    var html = '', line = [], ln = 1, buf = '';
    function push(txt, cls) {
      buf += cls ? '<span class="' + cls + '">' + U.esc(txt) + '</span>' : U.esc(txt);
    }
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i], s = p.text, k = 0;
      while (true) {
        var nl = s.indexOf('\n', k);
        if (nl < 0) { push(s.slice(k), p.cls); break; }
        push(s.slice(k, nl), p.cls);
        if (showWS) buf = markTrailing(buf);
        html += '<span class="' + (ln === currentLine ? 'curline' : 'line') + '">' + (buf || '\n') + '\n</span>';
        buf = ''; ln++;
        k = nl + 1;
      }
    }
    html += '<span class="' + (ln === currentLine ? 'curline' : 'line') + '">' + (buf || '') + '</span>';
    return html;
  }

  Code.highlight = { render: render, tokenize: tokenize, langs: LANGS };
})(window);
