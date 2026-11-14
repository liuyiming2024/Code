#!/usr/bin/env node
/* check-runtime-claims.js —— 运行时可用性的「声明一致性」断言
 * ------------------------------------------------------------------
 * 这个仓库吃过一次亏：2026-10-16 的条款与 README 判定「Clang 接线未完成、
 * 下载了也跑不了」，10-17/18 代码就接通并端到端跑通了，但文案没跟上；
 * 于是出现「清单 ready=true / 条款说暂不可用 / 发布页照旧并列」三种口径。
 * 更危险的是照着过时的历史要求去改 —— 会把对的改成错的。
 *
 * 这里不判断「能不能跑」（那要真机），只钉住两件能静态确定的事：
 *   1. 若 cpp.ready===true，对外文案里不许再出现旧的「没跑过 / 接线未完成」断言
 *   2. 扩展中心必须仍按 ready===false 置灰（否则 ready 字段形同虚设）
 *
 * 用法：node scripts/check-runtime-claims.js     # 不一致退出码 1
 * ------------------------------------------------------------------ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = m => console.log('  ✓ ' + m);
const fail = m => { console.error('  ✗ ' + m); bad++; };

const rt = JSON.parse(read('api/runtimes.json'));
const runtimes = rt.runtimes || [];
const cpp = runtimes.find(r => r.id === 'cpp');
const notReady = runtimes.filter(r => r.ready === false).map(r => r.id);

console.log('运行时：%d 个，未就绪：%s', runtimes.length, notReady.join(', ') || '（无）');

// 旧断言：只要 cpp 已就绪，这些句子就是错的
const STALE = [
  '六种语言一次都没真跑过',
  '一次都没真跑过',
  '资源已就位但接线未完成',
  '扩展中心里标为「暂不可用」',
  '下载后暂时无法运行',
  '至今一次都没跑通过',
];
if (cpp && cpp.ready === true) {
  for (const f of ['README.md', 'TERMS.md', 'api/runtimes.json']) {
    const t = read(f);
    const hits = STALE.filter(s => t.includes(s));
    if (hits.length) fail(f + ' 仍含过时断言：' + hits.join('、'));
    else ok(f + ' 无过时断言');
  }
} else {
  ok('cpp.ready 不是 true，跳过旧断言检查（此时文案应说明未就绪）');
}

const ui = read('js/ui.js');
if (/rt\s*&&\s*rt\.ready\s*===\s*false/.test(ui)) {
  ok('扩展中心仍按 ready===false 置灰');
} else {
  fail('js/ui.js 里找不到 ready===false 的置灰判断，ready 字段可能已失效');
}

if (notReady.length) {
  const terms = read('TERMS.md');
  if (terms.includes('ready: false') || terms.includes('置灰')) ok('条款已说明未就绪运行时');
  else fail('清单里有 ready=false 的运行时，但条款没说明');
}

if (bad) {
  console.error('\n%d 处声明与清单不一致。改 ready 字段时请同步改 README / TERMS。', bad);
  process.exit(1);
}
console.log('\n✅ 运行时可用性声明与清单一致');
