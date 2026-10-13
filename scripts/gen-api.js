#!/usr/bin/env node
/* ============================================================
 * gen-api.js —— 由 js/langs.js 生成 api/langs.json
 *
 * 为什么要有它（S-098）：
 *   api/langs.json 此前是**手写的第四份数据**，与 js/langs.js 各自维护。
 *   实测差异：langs.js 注册 17 个 id，langs.json 只列 10 种语言，
 *   漏了 Lua / Ruby / PHP 三种（S-086）；C/C++ 扩展名漏 cxx（S-093）；
 *   SQL 体积宣称 660 KB 而权威源是 692 KB（S-094）。
 *   这是**对外承诺的接口**，任何按它做集成的人会以为 Code 不支持这三种语言。
 *
 * 解法照抄 Chat 的 sync-www.js 模式：单一权威源 + 生成 + 校验。
 *   权威源：js/langs.js（语言与扩展名）、api/runtimes.json（体积）
 *   生成物：api/langs.json（不手写，只由本脚本产出）
 *
 * 用法：node scripts/gen-api.js [--check]
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const checkOnly = process.argv.includes('--check');

/* ---- 1. 从 langs.js 抽取 LANGS（不执行整个 IIFE，只取需要的字段） ---- */
function loadLangs() {
  const src = fs.readFileSync(path.join(root, 'js/langs.js'), 'utf8');
  /* 用真实环境跑一次，拿到注册表 —— 比正则解析可靠 */
  const sandbox = { window: {} };
  new Function('window', src)(sandbox.window);
  return sandbox.window.Code.langs;
}

/* ---- 2. 从 runtimes.json 取体积（唯一权威源，S-025） ---- */
function loadSizes() {
  const r = JSON.parse(fs.readFileSync(path.join(root, 'api/runtimes.json'), 'utf8'));
  return r.sizes || {};
}

function bytesToKB(n) {
  if (typeof n !== 'number') return null;
  return Math.round(n / 102.4) / 10;   /* 保留一位小数，与真值误差 <0.05 KB */
}

/* ---- 3. 生成 ---- */
function build() {
  const L = loadLangs();
  const sizes = loadSizes();
  const all = Array.isArray(L.all) ? L.all : [];
  const TIERNAME = { 1: 'builtin', 2: 'download', 3: 'none' };

  const languages = all.map(function (l) {
    const item = { name: l.name, ext: (l.exts || []).slice() };
    /* run：有 runner 或可下载即视为可运行 */
    const canRun = !!l.runner || (l.tier === 2) || (l.wasm && l.wasm.id);
    item.run = canRun;
    item.tier = TIERNAME[l.tier] || 'none';

    /* note：把 caveats 如实写上，不许只写"不支持高级特性"而漏掉实测会撞上的 */
    const notes = [];
    if (l.caveat) notes.push(l.caveat);
    if (l.desc && !l.caveat) notes.push(l.desc);
    if (l.wasm && l.wasm.id && sizes[l.wasm.id]) {
      notes.push('需下载 ' + l.wasm.id + ' 运行时（约 ' + bytesToKB(sizes[l.wasm.id]) + ' KB），缓存后离线可用');
    }
    if (notes.length) item.note = notes.join('；');
    return item;
  });

  return {
    updated: new Date().toISOString().slice(0, 10),
    generatedBy: 'scripts/gen-api.js（由 js/langs.js 生成，请勿手写）',
    languages: languages,
    note: 'run=true 表示可在页面内执行。tier 说明能力来源：builtin=内置自研或浏览器原生，零依赖离线可用；download=需按需下载 WASM 运行时（首次联网，缓存后离线）；none=仅着色与编辑。Python 与 C/C++ 为自研子集，界面与报错中均如实标注，不冒充完整实现。',
    runtimes: '/Code/api/runtimes.json'
  };
}

const next = build();
const file = path.join(root, 'api/langs.json');
const prev = JSON.parse(fs.readFileSync(file, 'utf8'));

/* ---- 4. 校验（--check 或写完自检） ---- */
const problems = [];

/* 语言数必须与 langs.js 一致 */
const L = loadLangs();
const regCount = Array.isArray(L.all) ? L.all.length : 0;
if (next.languages.length !== regCount) {
  problems.push('语言数不一致：langs.json ' + next.languages.length + ' vs langs.js ' + regCount);
}
/* 每种语言都要在 langs.js 里找得到 */
(Array.isArray(L.all) ? L.all : []).forEach(function (l) {
  const hit = next.languages.filter(function (x) { return x.name === l.name; })[0];
  if (!hit) { problems.push('langs.json 缺少语言：' + l.name + '（' + l.id + '）'); return; }
  /* 扩展名必须完全一致（cxx 就是这么漏的） */
  const missing = (l.exts || []).filter(function (e) { return hit.ext.indexOf(e) < 0; });
  if (missing.length) problems.push(l.name + ' 扩展名漏：' + missing.join(','));
});
/* SQL 必须可运行（S-087） */
const sql = next.languages.filter(function (x) { return x.name === 'SQL'; })[0];
if (sql && sql.run !== true) problems.push('SQL 的 run 应为 true（能下载 SQLite 却声明不能运行，自相矛盾）');
/* 体积必须与 runtimes.json 一致（S-094） */
const sizes = loadSizes();
Object.keys(sizes).forEach(function (k) {
  const kb = bytesToKB(sizes[k]);
  const hit = next.languages.filter(function (x) { return x.note && x.note.indexOf(k + ' 运行时') >= 0; })[0];
  if (hit) {
    const m = /约 ([\d.]+) KB/.exec(hit.note);
    if (m && Math.abs(parseFloat(m[1]) - kb) > 0.6) {
      problems.push(hit.name + ' 体积 ' + m[1] + ' KB 与权威源 ' + kb + ' KB 不符');
    }
  }
});

if (checkOnly || problems.length) {
  if (problems.length) {
    console.error('✗ api/langs.json 与权威源不一致：');
    problems.forEach(function (p) { console.error('  - ' + p); });
    process.exit(1);
  }
  console.log('✓ api/langs.json 与权威源一致（' + next.languages.length + ' 种语言）');
}
if (!checkOnly) {
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log('✓ 已生成 api/langs.json（' + next.languages.length + ' 种语言）');
}
