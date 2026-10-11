/* style-adapt.js —— 代码风格自适应
 *
 * 解决的问题：打开别人的文件，缩进风格跟你自己的偏好不一样。
 * 逐行手改太累，进设置面板选一次也还是"全局一刀切"——
 * 这个项目里 A 文件用 tab、B 文件用 4 空格是很常见的。
 *
 * 所以：打开文件时**从文件内容自己推断**缩进风格，只对当前文件生效。
 *
 * 三条硬规矩：
 *   1. **不写回全局设置**——推断结果只存在内存里，按文件路径记。
 *      否则打开一个 tab 缩进的文件，会把你自己的偏好改掉，这很糟。
 *   2. **不进设置面板**——不需要用户做任何选择，自动完成。
 *   3. **推断不出来就用用户原来的偏好**，不硬套。
 *
 * 推断依据（只用行首缩进，不解析语法，所以任何语言都适用）：
 *   - 行首第一个字符是 \t 还是空格 → 决定 tab / space
 *   - 空格缩进时，相邻缩进层级的最小正差值 → 决定宽度（2/4/8）
 *   - 取众数而不是第一行，避免被个别对齐的续行带偏
 */
(function (global) {
  'use strict';
  var Code = global.Code || (global.Code = {});

  var byPath = {};        /* path -> { mode, size } 仅内存，不持久化 */
  var current = null;

  /* 最多看多少行。够判断风格了，也避免大文件卡顿。 */
  var MAX_LINES = 400;

  /* ---------- 推断 ---------- */
  function detect(text) {
    if (!text) return null;
    var lines = text.split('\n');
    var n = Math.min(lines.length, MAX_LINES);

    var tabLead = 0, spaceLead = 0;
    var gaps = {};          /* 缩进宽度差 -> 出现次数 */
    var prevDepth = 0;
    var samples = 0;

    for (var i = 0; i < n; i++) {
      var line = lines[i];
      if (!line) continue;
      var m = /^([ \t]+)/.exec(line);
      if (!m) { prevDepth = 0; continue; }
      var ind = m[1];
      /* 混合缩进（" \t"）说明这文件本身就不规范，跳过这一行别被带偏 */
      if (/ /.test(ind) && /\t/.test(ind)) continue;

      var isTab = ind.charAt(0) === '\t';
      if (isTab) tabLead++; else spaceLead++;
      samples++;

      var depth = ind.length;
      if (!isTab && prevDepth > 0) {
        var d = depth - prevDepth;
        /* 只统计正差（进入更深的层级），且限制在合理范围 */
        if (d > 0 && d <= 8) gaps[d] = (gaps[d] || 0) + 1;
      }
      prevDepth = depth;
    }

    /* 样本太少不足以判断，交给用户原本的偏好。
       阈值取 2：三四行的小文件也得能跟上它自己的风格，
       只有"有缩进的行"才计数，样本虽少但很纯。 */
    if (samples < 2) return null;

    var mode;
    /* 只有一种缩进字符出现过时也能判定（小文件常见），
       不要求"压倒性多数"，只要另一种没出现即可 */
    if (tabLead > 0 && spaceLead === 0) mode = 'tab';
    else if (spaceLead > 0 && tabLead === 0) mode = 'space';
    else if (tabLead > spaceLead * 2) mode = 'tab';
    else if (spaceLead > tabLead * 2) mode = 'space';
    else return null;   /* 势均力敌 = 判断不了，不硬猜 */

    /* ---- 运算符间距：x==y 还是 x == y ----
       同样只统计、取多数。判断不了就返回 null（沿用模板默认）。 */
    var spacing = detectSpacing(lines, n);

    var size = 0;
    if (mode === 'space') {
      /* 取出现次数最多的宽度差 */
      var best = 0, bestN = 0;
      Object.keys(gaps).forEach(function (k) {
        var v = gaps[k];
        if (v > bestN || (v === bestN && +k < best)) { bestN = v; best = +k; }
      });
      /* 常见值优先：2/4/8。不是这三个就取推断值（限制 1..8） */
      if (bestN > 0) {
        if (gaps[4] && gaps[4] >= bestN * 0.6) size = 4;
        else if (gaps[2] && gaps[2] >= bestN * 0.6) size = 2;
        else if (gaps[8] && gaps[8] >= bestN * 0.6) size = 8;
        else size = best;
        size = Math.max(1, Math.min(8, size));
      }
    }

    return { mode: mode, size: size || 0, spacing: spacing, samples: samples };
  }

  /* 二元运算符两侧的空格习惯。
     返回 'spaced'（x == y）/ 'tight'（x==y）/ null（看不出来）。 */
  var BINOPS = ['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '=', '+', '-', '*', '<', '>'];

  function detectSpacing(lines, n) {
    var spaced = 0, tight = 0;
    for (var i = 0; i < n; i++) {
      var line = lines[i] || '';
      /* 跳过字符串密集的行（引号会干扰判断，简单起见整行跳过） */
      if (/'|"|`/.test(line)) continue;
      for (var k = 0; k < BINOPS.length; k++) {
        var op = BINOPS[k];
        var from = 0, idx;
        while ((idx = line.indexOf(op, from)) >= 0) {
          var left = idx > 0 ? line.charAt(idx - 1) : '';
          var right = line.charAt(idx + op.length) || '';
          /* 两侧是空格 → spaced；两侧都是代码字符 → tight。
             其余情况（$$、->、连续符号）不算样本。
             注意不能先要求"两侧都是代码字符"再判断是不是空格 ——
             那样 spaced 永远统计不到，因为空格本来就不是代码字符。 */
          var isSp = /[ \t]/.test(left) || /[ \t]/.test(right);
          var isTight = /[A-Za-z0-9_)\]]/.test(left) && /[A-Za-z0-9_(\[]/.test(right);
          if (isSp) spaced++;
          else if (isTight) tight++;
          from = idx + op.length;
        }
      }
    }
    var total = spaced + tight;
    /* 阈值取 2：小文件里往往只有一两个运算符，
       但它们就是这个文件风格的证据，不该放过。 */
    if (total < 2) return null;              /* 样本不足，不猜 */
    if (spaced > tight * 1.5) return 'spaced';
    if (tight > spaced * 1.5) return 'tight';
    return null;
  }

  /* ---------- 文件打开时调用 ---------- */
  function apply(path, text) {
    current = null;
    var r = detect(text);
    if (!r) { delete byPath[path]; return null; }
    var style = { mode: r.mode, size: r.size || null, spacing: r.spacing || null };
    byPath[path] = style;
    current = style;
    return style;
  }

  function forget(path) {
    delete byPath[path];
    if (current && !path) current = null;
  }

  function of(path) { return byPath[path] || null; }
  function now() { return current; }

  /* 给状态栏用的一句话说明。推断不出来就如实说"沿用偏好"。 */
  function describe(path) {
    var s = of(path);
    if (!s) return '缩进：沿用偏好';
    if (s.mode === 'tab') return '缩进：Tab（检测到）';
    return '缩进：' + (s.size || '?') + ' 空格（检测到）';
  }

  Code.styleAdapt = {
    detect: detect,
    apply: apply,
    forget: forget,
    of: of,
    now: now,
    describe: describe
  };
})(typeof window !== 'undefined' ? window : globalThis);
