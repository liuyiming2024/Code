#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""只检查一类零误报的 CSS 错误：var(--x) 无 fallback 且 --x 从未定义。

为什么只做这一类：仓库里的 css-wiring / var-wiring 是「只报告不阻断」的
人工报告工具，因为类名动态拼接、作用域等会有误报。但**变量名精确比对**
没有这个问题：`var(--x)` 取不到值时整条声明被浏览器静默丢弃，
不报错、不警告，是纯失效。曾经 style.css 里 4 处写成
--err / --border / --accent-dim / --bg-1，而定义里只有
--danger / --line / --sel / --bg-2 / --bg-3，错误输出没颜色、
扩展行没边框、修饰键没背景，一直没人发现。

刻意不查（会误报）：
  · var(--x, 兜底值)  → 有 fallback，取不到也能用
  · 发布页.html 的内联 <style> → 它是独立页面，自带一套变量
  · 类名、函数、作用域 → 交给那三个报告型工具

用法：python3 scripts/check-css-vars.py    # 有漂移退出码 1
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = ['css/style.css', 'css/fx-plus.css']

text = ''
for p in FILES:
    f = ROOT / p
    if f.exists():
        text += '\n' + f.read_text(encoding='utf-8')

# CSS 注释里常拿 var(--x) 举例，不剥离会把死变量判成活的
stripped = re.sub(r'/\*[\s\S]*?\*/', '', text)
defined = set(re.findall(r'(--[A-Za-z0-9_-]+)\s*:', stripped))
# 捕获 var(--x) 后面紧跟的分隔符：) = 无 fallback；, = 有 fallback
used = re.findall(r'var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])', stripped)
missing = sorted({name for name, sep in used if sep == ')' and name not in defined})

print('CSS 变量：定义 %d 个，无 fallback 引用 %d 处' % (len(defined), len(used)))
if missing:
    print('✗ 引用了未定义且无兜底的变量（整条声明会被丢弃）：', file=sys.stderr)
    for m in missing:
        print('    ' + m, file=sys.stderr)
    print('\n修法：改成已定义的变量名，或在 :root / [data-theme] 里补定义。',
          file=sys.stderr)
    sys.exit(1)
print('✅ 无 fallback 的 var() 全部有定义')
