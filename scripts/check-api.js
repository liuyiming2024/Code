#!/usr/bin/env node
/* ============================================================
 * check-api.js —— 校验三份对外 API 与权威源一致
 *
 * 存在的理由（S-098）：三份 JSON 此前全部手写、无任何生成或校验机制，
 * 与 js/langs.js 是四份独立维护的数据，已经撞出：
 *   S-086 少报 Lua/Ruby/PHP 三种语言
 *   S-093 C/C++ 扩展名漏 cxx
 *   S-094 SQL 体积宣称 660 KB 而权威源 692 KB
 *   S-085 endpoints 漏 runtimes.json
 *   S-090 pageApi 漏 manifest()
 *   S-092 路径风格三种（裸 api/... 在子路径下会 404）
 *   S-099 缺 updated 字段
 *
 * 用法：node scripts/check-api.js [--check]
 * 退出码：不一致则 1（CI 可拦）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const problems = [];
function bad(msg) { problems.push(msg); }

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); }
  catch (e) { bad(p + ' 不是合法 JSON：' + e.message); return null; }
}

const manifest = readJSON('api/manifest.json');
const langs = readJSON('api/langs.json');
const runtimes = readJSON('api/runtimes.json');
const apiSrc = fs.readFileSync(path.join(root, 'js/api.js'), 'utf8');

/* ---- 1. updated 字段（S-099） ---- */
[['api/manifest.json', manifest], ['api/langs.json', langs], ['api/runtimes.json', runtimes]].forEach(function (pair) {
  if (!pair[1]) return;
  if (!pair[1].updated) bad(pair[0] + ' 缺 updated 字段：对外接口没有时间戳，集成方无法判断自己拿到的是不是过期的');
});

/* ---- 2. endpoints 必须覆盖实际存在的三个文件（S-085） ---- */
if (manifest && manifest.endpoints) {
  const listed = manifest.endpoints.map(function (e) { return e.path; });
  ['/Code/api/manifest.json', '/Code/api/langs.json', '/Code/api/runtimes.json'].forEach(function (need) {
    if (listed.indexOf(need) < 0) bad('endpoints 漏了 ' + need);
  });
  /* 路径风格统一（S-092）：必须是 /Code/ 开头的绝对路径 */
  manifest.endpoints.forEach(function (e) {
    if (!/^\/Code\/api\//.test(e.path)) bad('endpoints 路径风格不统一：' + e.path + '（应写成 /Code/api/...，裸 api/... 在子路径下会 404）');
  });
}

/* ---- 3. langs.json 的 runtimes 字段也要用绝对路径（S-092） ---- */
if (langs && langs.runtimes && !/^\/Code\//.test(langs.runtimes)) {
  bad('langs.json 的 runtimes 字段用了相对路径：' + langs.runtimes + '（应为 /Code/api/runtimes.json）');
}

/* ---- 4. pageApi 必须覆盖 Code.api 的全部方法（S-090） ---- */
if (manifest && manifest.pageApi) {
  const declared = [];
  const re = /^\s{4}(\w+):\s*function/gm;
  let m;
  while ((m = re.exec(apiSrc)) !== null) declared.push(m[1]);
  declared.forEach(function (name) {
    const hit = manifest.pageApi.some(function (s) { return s.indexOf('Code.api.' + name + '(') === 0; });
    if (!hit) bad('pageApi 漏了方法：Code.api.' + name + '()');
  });
}

/* ---- 5. 语言与扩展名必须和 js/langs.js 一致（S-086 / S-093） ---- */
const sandbox = { window: {} };
new Function('window', fs.readFileSync(path.join(root, 'js/langs.js'), 'utf8'))(sandbox.window);
const LANGS = (sandbox.window.Code && sandbox.window.Code.langs && sandbox.window.Code.langs.all) || [];
if (langs && langs.languages) {
  const byName = {};
  langs.languages.forEach(function (l) { byName[l.name] = l; });
  LANGS.forEach(function (l) {
    const hit = byName[l.name];
    if (!hit) { bad('langs.json 缺少语言：' + l.name + '（' + l.id + '）'); return; }
    (l.exts || []).forEach(function (e) {
      if (hit.ext.indexOf(e) < 0) bad(l.name + ' 扩展名漏：' + e);
    });
  });
}

/* ---- 6. 体积必须与 runtimes.json（唯一权威源）一致（S-094 / S-025） ---- */
if (langs && runtimes && runtimes.sizes) {
  langs.languages.forEach(function (l) {
    if (!l.note) return;
    const m = /(\w+) 运行时（约 ([\d.]+) KB）/.exec(l.note);
    if (!m) return;
    const real = runtimes.sizes[m[1]];
    if (typeof real !== 'number') { bad(l.name + ' 引用了不存在的运行时：' + m[1]); return; }
    const realKB = Math.round(real / 102.4) / 10;
    if (Math.abs(parseFloat(m[2]) - realKB) > 0.6) {
      bad(l.name + ' 体积 ' + m[2] + ' KB 与权威源 ' + realKB + ' KB 不符');
    }
  });
}

/* ---- 7. SQL 必须声明可运行（S-087） ---- */
if (langs) {
  const sql = langs.languages.filter(function (l) { return l.name === 'SQL'; })[0];
  if (sql && sql.run !== true) bad('SQL 的 run 应为 true（能下载 SQLite 却声明不能运行，自相矛盾）');
}

/* ---- 8. langs.json 不能是手写的（S-098） ---- */
if (langs && !langs.generatedBy) {
  bad('api/langs.json 缺少 generatedBy 标记：它应由 scripts/gen-api.js 生成，不能手写');
}

if (problems.length) {
  console.error('✗ 对外 API 与权威源不一致（' + problems.length + ' 项）：');
  problems.forEach(function (p) { console.error('  - ' + p); });
  process.exit(1);
}
console.log('✓ 三份对外 API 与权威源一致');
