#!/usr/bin/env node
/* sync-native-assets.js —— 把自研子集运行时同步进 Android assets
 * ------------------------------------------------------------------
 * native/android/app/src/main/assets/{cpplite,pylite}.js 是 WebView
 * 加载的副本，权威源在 js/ 下。两份都在 git 里，靠人记得同步 = 迟早漂移：
 *
 *   2026-11 实测 js/cpplite.js 已修好 stringstream / scanf / 流状态，
 *   Android 那份还是旧版（少 488 行），WebView 里跑出来的结果和网页版不同。
 *
 * 用法：
 *   node scripts/sync-native-assets.js            # 同步
 *   node scripts/sync-native-assets.js --check    # 只检查，不同步（CI 用）
 *
 * 方向永远是 js/ → assets/，单向，不做双向合并（与云盘那种用户数据
 * 同步不一样，这里是构建副本，源只有一个）。
 * ------------------------------------------------------------------ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['cpplite.js', 'pylite.js'];
const SRC = path.join(ROOT, 'js');
const DST = path.join(ROOT, 'native', 'android', 'app', 'src', 'main', 'assets');

function main() {
  const checkOnly = process.argv.includes('--check');
  let bad = 0;
  for (const f of FILES) {
    const a = path.join(SRC, f), b = path.join(DST, f);
    if (!fs.existsSync(a)) { console.error('✗ 缺源文件 js/' + f); bad++; continue; }
    const sa = fs.readFileSync(a);
    const sb = fs.existsSync(b) ? fs.readFileSync(b) : null;
    if (sb && sa.equals(sb)) { console.log('✓ ' + f + ' 一致'); continue; }
    if (checkOnly) {
      console.error('✗ ' + f + ' 与原生端副本不一致（跑一次脚本同步）');
      bad++;
    } else {
      fs.mkdirSync(DST, { recursive: true });
      fs.copyFileSync(a, b);
      console.log('  已同步 ' + f + ' → native/android/.../assets/');
    }
  }
  if (bad) {
    console.error('\n' + bad + ' 处不一致。' + (checkOnly
      ? '跑 node scripts/sync-native-assets.js 同步后再提交。'
      : '同步后仍不一致，请检查。'));
    process.exit(1);
  }
  console.log(checkOnly ? '\n✅ 原生端运行时副本一致' : '\n✅ 已同步');
}
main();
