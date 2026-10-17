#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""diffRange 的 Python 复刻 —— 重点是"前缀后缀重叠"那个坑。"""
import sys

def diff_range(before, after):
    if before == after: return (0, 0)
    maxlen = min(len(before), len(after))
    a = 0
    while a < maxlen and before[a] == after[a]: a += 1
    b = 0
    while b < maxlen - a and before[len(before)-1-b] == after[len(after)-1-b]: b += 1
    return (a, len(before) - b)

P = F = 0
def t(n, c, e=""):
    global P, F
    if c: P += 1; print("  ✅ " + n)
    else: F += 1; print("  ❌ " + n + (" —— " + e if e else ""))

print("差异区间验证")

# --- 重叠坑（关键） ---
# before="aa" after="a"：前缀 1、后缀 1，加起来 2 > min(2,1)=1
r = diff_range("aa", "a")
t("删尾部重复字符：识别出 [1,2) 是删除", r == (1, 2), "实际 %s" % str(r))
r = diff_range("aaa", "aa")
t("aaa→aa 识别出 [2,3)", r == (2, 3), "实际 %s" % str(r))
r = diff_range("abab", "aba")
t("abab→aba 正确", r == (3, 4), "实际 %s" % str(r))

# --- 普通插入 ---
t("末尾追加", diff_range("ab", "abc") == (2, 2))
t("开头插入", diff_range("bc", "abc") == (0, 0))
t("中间插入", diff_range("ac", "abc") == (1, 1))

# --- 普通删除 ---
t("删末尾", diff_range("abc", "ab") == (2, 3))
t("删开头", diff_range("abc", "bc") == (0, 1))
t("删中间", diff_range("abc", "ac") == (1, 2))

# --- 替换 ---
t("单字替换", diff_range("abc", "axc") == (1, 2))
t("整篇替换", diff_range("abc", "xyz") == (0, 3))

# --- 边界 ---
t("空→有", diff_range("", "a") == (0, 0))
t("有→空", diff_range("a", "") == (0, 1))
t("相同返回 (0,0)", diff_range("same", "same") == (0, 0))
t("两个都空", diff_range("", "") == (0, 0))

# --- 区间必须合法 ---
cases = [("aa","a"),("aaa","aa"),("abab","aba"),("abc","abcd"),("x",""),("","y"),
         ("hello","hell"),("hello","hello!"),("aab","ab"),("abc","abc")]
bad = [c for c in cases if not (0 <= diff_range(*c)[0] <= diff_range(*c)[1] <= len(c[0]))]
t("所有区间满足 0<=start<=end<=len(before)", not bad, str(bad))

print("\n通过 %d / %d" % (P, P + F))
sys.exit(1 if F else 0)
