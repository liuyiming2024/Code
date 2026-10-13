/* snippets.js —— Tab 片段展开
 *
 * 用户要的效果：敲 `for` 再按 Tab，直接展开成完整的 for 循环骨架，
 * 光标停在变量名上，改完再按 Tab 跳到下一个要填的地方。
 *
 * 为什么不用设置面板控制：
 *   这是"打字时的肌肉记忆"，不是偏好项。摆进设置里反而增加负担。
 *   开关放在命令面板（Ctrl+Shift+P 搜"片段"），默认开。
 *
 * 为什么内置一张表而不是全交给 AI：
 *   AI 需要密钥、有网络延迟、还可能失败。
 *   `for` / `if` / `while` 这种骨架是**确定的、不需要智能**的东西，
 *   本地展开是零延迟、离线可用、百分百可靠的。
 *   AI 适合的是"帮我写个快排"这种需要理解意图的活，
 *   不是"补全 for 的括号"。两者不是替代关系。
 *
 * 占位符语法：$1 $2 … 是跳转点，$0 是终点。同名占位会一起改（如 ${1:i}）。
 * 简化实现：只支持数字 tabstop，先不做同名联动（够用且不易出错）。
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  /* 片段表。key 是触发词，body 是模板数组（每行一个元素）。
     缩进用 \t 占位，插入时按当前文件的缩进风格换成实际的空格或 tab。 */
  var COMMON = {
    if: { body: ['if ($1) {', '\t$0', '}'], desc: 'if 语句' },
    while: { body: ['while ($1) {', '\t$0', '}'], desc: 'while 循环' }
  };

  var BY_LANG = {
    javascript: {
      for: { body: ['for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {', '\t$0', '}'], desc: 'for 循环' },
      forof: { body: ['for (const ${1:item} of ${2:list}) {', '\t$0', '}'], desc: 'for...of' },
      func: { body: ['function ${1:name}(${2:args}) {', '\t$0', '}'], desc: '函数' },
      arrow: { body: ['const ${1:name} = (${2:args}) => {', '\t$0', '};'], desc: '箭头函数' },
      try: { body: ['try {', '\t$1', '} catch (${2:e}) {', '\t$0', '}'], desc: 'try/catch' }
    },
    cpp: {
      for: { body: ['for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {', '\t$0', '}'], desc: 'for 循环' },
      main: { body: ['int main() {', '\t$0', '\treturn 0;', '}'], desc: 'main 函数' },
      func: { body: ['${1:void} ${2:name}(${3:args}) {', '\t$0', '}'], desc: '函数' },
      class: { body: ['class ${1:Name} {', 'public:', '\t$0', '};'], desc: '类' },
      cout: { body: ['std::cout << $0 << std::endl;'], desc: '输出' }
    },
    python: {
      for: { body: ['for ${1:i} in range(${2:n}):', '\t$0'], desc: 'for 循环' },
      def: { body: ['def ${1:name}(${2:args}):', '\t$0'], desc: '函数' },
      class: { body: ['class ${1:Name}:', '\tdef __init__(self, $2):', '\t\t$0'], desc: '类' },
      ifmain: { body: ['if __name__ == "__main__":', '\t$0'], desc: '主入口' },
      try: { body: ['try:', '\t$1', 'except ${2:Exception} as e:', '\t$0'], desc: 'try/except' }
    },
    html: {
      html: { body: ['<!DOCTYPE html>', '<html lang="zh-CN">', '<head>', '\t<meta charset="utf-8">', '\t<title>$1</title>', '</head>', '<body>', '\t$0', '</body>', '</html>'], desc: 'HTML 骨架' },
      div: { body: ['<div class="$1">', '\t$0', '</div>'], desc: 'div' }
    },
    sql: {
      sel: { body: ['SELECT $1', 'FROM ${2:table}', 'WHERE $0;'], desc: 'SELECT' }
    }
  };

  /* 触发词：只匹配光标前紧邻的标识符。
     这样 `myfor` 不会误触发，`x.for` 也不会（前面是点）。 */
  var WORD = /[A-Za-z_][A-Za-z0-9_]*$/;

  function table(lang) {
    var t = BY_LANG[lang] || {};
    /* 通用片段兜底：语言专属表里的同名项优先 */
    var out = {};
    Object.keys(COMMON).forEach(function (k) { out[k] = COMMON[k]; });
    Object.keys(t).forEach(function (k) { out[k] = t[k]; });
    return out;
  }

  /* 这一行光标前的文本里，目标词是否落在字符串或注释中。
     只做粗判断：算到目标词为止的引号奇偶，以及 // 和 # 的位置。
     不做完整词法分析 —— 那是过度设计，而这里要的只是"别在写句子时插进来"。 */
  function inStringOrComment(lineText, word) {
    var idx = lineText.lastIndexOf(word);
    if (idx < 0) idx = lineText.length;
    var head = lineText.slice(0, idx);
    /* 注释：// 或 # 在目标词之前 */
    var c1 = head.indexOf('//');
    var c2 = head.indexOf('#');
    if (c1 >= 0 || c2 >= 0) {
      var cp = c1 >= 0 ? (c2 >= 0 ? Math.min(c1, c2) : c1) : c2;
      /* 但 # 也可能是 CSS 颜色或 shebang，只有它在行首或空白之后才算注释 */
      if (c1 >= 0 && cp === c1) return true;
      if (c2 >= 0 && cp === c2) {
        var beforeHash = head.charAt(c2 - 1);
        if (c2 === 0 || !beforeHash || /\s/.test(beforeHash)) return true;
      }
    }
    /* 字符串：统计未转义的引号，奇数个说明此刻正处在字符串里 */
    var dq = 0, sq = 0;
    for (var i = 0; i < head.length; i++) {
      var c = head.charAt(i);
      if (c === '\\') { i++; continue; }
      if (c === '"') dq++;
      else if (c === "'") sq++;
    }
    if (dq % 2 === 1 || sq % 2 === 1) return true;
    return false;
  }

  /* 找出光标前的触发词。返回 null 表示不该展开。 */
  function triggerAt(text, pos) {
    if (pos <= 0) return null;
    var before = text.slice(0, pos);
    var m = WORD.exec(before);
    if (!m) return null;
    /* 前面是点或字母数字之外又不是空白/行首 → 不展开（避免 a.for 之类） */
    var ch = before.charAt(m.index - 1);
    if (ch && /[.\w]/.test(ch)) return null;
    /* E-029：在字符串或注释里敲 for + Tab 也会展开 —— 比如 print("for")。
       写注释"for 循环"打到一半按 Tab 就冒出一段骨架，很突然。
       所以先看这一行光标之前的部分，判断是不是处在字符串/注释里。
       判断做得很保守：引号成奇数个才算在字符串里，行内 // 或 # 之后算注释。
       宁可少展开一次，也不要在人家写句子时插进来。 */
    var lineStart = before.lastIndexOf('\n') + 1;
    var lineBefore = before.slice(lineStart);
    if (inStringOrComment(lineBefore, m[0])) return null;
    return { word: m[0], start: m.index };
  }

  /* 把模板渲染成文本，并算出 tabstop 的位置。
     indent 是当前文件的缩进单元（'\t' 或若干空格）。 */
  /* 运算符间距：模板统一写 x == y，若当前文件是 x==y 就收紧。
     只对明确的二元运算符生效，且要求两侧是空白——不会误伤字符串内容。 */
  var TIGHT_OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '=', '+', '-'];

  function tighten(text) {
    var out = text;
    TIGHT_OPS.forEach(function (op) {
      var re = new RegExp('\\s*' + escapeRe(op) + '\\s*', 'g');
      out = out.replace(re, op);
    });
    return out;
  }

  function render(body, indent, spacing) {
    var out = [], stops = [];
    var lineStart = 0;
    /* 先把所有行拼起来，记录每个 $n 的偏移 */
    var text = '';
    body.forEach(function (line, i) {
      var seg = line.replace(/\t/g, indent);
      /* 运算符间距跟随当前文件：模板写的是 x == y，文件若用 x==y 就收紧 */
      if (spacing === 'tight') seg = tighten(seg);
      /* 先处理 ${n:default}，再处理 $n */
      seg = seg.replace(/\$\{(\d+):([^}]*)\}/g, function (_, n, d) {
        stops.push({ n: +n, pos: -1, def: d });
        return d;
      });
      if (i > 0) text += '\n';
      /* 记录这一行里 tabstop 的绝对位置 */
      seg.replace(/\$(\d+)/g, function (_, n, offset) {
        stops.push({ n: +n, pos: text.length + offset, def: '' });
        return '';
      });
      text += seg.replace(/\$(\d+)/g, '');
    });

    /* 处理 ${n:default} 的位置：它们在上述 replace 中被替换成 default，
       需要在最终 text 里找到对应偏移。简单起见按出现顺序二次扫描。 */
    var idx = 0;
    var finalStops = [];
    var scan = text;
    stops.sort(function (a, b) { return (a.pos < 0 ? 1e9 : a.pos) - (b.pos < 0 ? 1e9 : b.pos); });
    stops.forEach(function (s) {
      if (s.pos >= 0) { finalStops.push({ n: s.n, start: s.pos, end: s.pos }); return; }
      /* 有默认值的：找到它在原模板里的次序，用第 idx 次出现定位 */
      var from = 0, found = -1, count = 0;
      var re = new RegExp(escapeRe(s.def), 'g');
      var mt;
      while ((mt = re.exec(scan))) {
        if (count === idx) { found = mt.index; break; }
        count++;
      }
      idx++;
      if (found >= 0) finalStops.push({ n: s.n, start: found, end: found + s.def.length });
    });

    finalStops.sort(function (a, b) { return a.n - b.n || a.start - b.start; });
    return { text: text, stops: finalStops };
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* 对外：给定语言、全文、光标位置，返回展开方案或 null */
  function expand(lang, text, pos) {
    if (off) return null;   /* 用户关掉了 Tab 片段展开（S-040） */
    var t = triggerAt(text, pos);
    if (!t) return null;
    var snip = table(lang)[t.word];
    if (!snip) return null;
    return {
      start: t.start,
      end: pos,
      word: t.word,
      desc: snip.desc,
      render: function (indent, spacing) { return render(snip.body, indent, spacing); }
    };
  }

  /* 命令面板用：列出当前语言可用的片段 */
  function listFor(lang) {
    var t = table(lang);
    return Object.keys(t).sort().map(function (k) {
      return { key: k, desc: t[k].desc };
    });
  }

  /* ⚠ 开关必须真的存在（S-040）。
     注释里写"片段开关在命令面板"，而命令面板里根本没有这一项、
     代码里也没有任何判据读这个开关 —— 于是用户无法关闭 Tab 片段展开。
     对写竞赛代码的人来说，Tab 片段展开很碍事：
     打 `for` 按 Tab 想缩进，结果被展开成一段模板。
     他连关掉的地方都找不到。 */
  var off = false;
  try {
    var st = (global.localStorage && global.localStorage.getItem('code_snippets_off'));
    off = (st === '1');
  } catch (e) { }

  Code.snippets = {
    expand: expand,
    listFor: listFor,
    isOff: function () { return off; },
    setOff: function (v) {
      off = !!v;
      try { if (global.localStorage) global.localStorage.setItem('code_snippets_off', off ? '1' : '0'); } catch (e) { }
      return off;
    },
    toggle: function () { return this.setOff(!off); },
    /* 给测试用 */
    _render: render,
    _triggerAt: triggerAt
  };
})(typeof window !== 'undefined' ? window : globalThis);
