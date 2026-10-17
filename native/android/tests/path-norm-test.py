#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PathNorm.kt 的 Python 复刻 —— 验证目录穿越防护与规范化规则。"""
import re, sys

def norm(raw):
    s = raw.strip()
    if not s: return None
    absolute = s.startswith("/") or re.match(r"^[A-Za-z]:", s)
    body = s.replace("\\", "/")
    if absolute:
        body = re.sub(r"^[A-Za-z]?:", "", body).lstrip("/")
    out = []
    for seg in body.split("/"):
        if seg == "" or seg == ".":
            continue
        if seg == "..":
            if not out: return None
            out.pop()
        else:
            out.append(seg)
    if not out: return None
    return "/".join(out)

def parent(p):
    i = p.rfind("/")
    return "" if i < 0 else p[:i]

def name(p):
    return p[p.rfind("/") + 1:] if "/" in p else p

def ext(p):
    n = name(p); i = n.rfind(".")
    return "" if i <= 0 else n[i+1:].lower()

P = F = 0
def t(n, c, e=""):
    global P, F
    if c: P += 1; print("  ✅ " + n)
    else: F += 1; print("  ❌ " + n + (" —— " + e if e else ""))

print("路径规范化验证")

# --- 基本 ---
t("简单路径", norm("a/b/c") == "a/b/c")
t("多余斜杠合并", norm("a//b") == "a/b")
t("去掉 . 段", norm("a/./b") == "a/b")
t("去掉首尾空白", norm("  a/b  ") == "a/b")
t("反斜杠当分隔符", norm("a\\b\\c") == "a/b/c")
t("绝对路径当相对处理", norm("/a/b") == "a/b")
t("Windows 盘符", norm("C:\\a\\b") == "a/b")

# --- 目录穿越（真漏洞，必须挡） ---
t("单点 .. 拒绝", norm("..") is None)
t("../etc/passwd 拒绝", norm("../etc/passwd") is None)
t("a/../../b 拒绝（退到根以上）", norm("a/../../b") is None)
t("深层穿越拒绝", norm("a/b/../../../c") is None)
t("中间 .. 正常回退", norm("a/b/../c") == "a/c")
t("连续 .. 合法时正常", norm("a/b/../../c") == "c")

# --- 空与非法 ---
t("空串拒绝", norm("") is None)
t("纯空白拒绝", norm("   ") is None)
t("只有斜杠拒绝", norm("/") is None)
t("只有点拒绝", norm(".") is None)
t("点斜杠拒绝", norm("./") is None)

# --- 辅助函数 ---
t("parent", parent("a/b/c") == "a/b")
t("顶层 parent 为空", parent("a.txt") == "")
t("name", name("a/b/c.txt") == "c.txt")
t("ext", ext("a/b/c.PY") == "py")
t("无扩展名返回空", ext("Makefile") == "")
t("点开头的文件不算扩展名", ext(".gitignore") == "")

print("\n通过 %d / %d" % (P, P + F))
sys.exit(1 if F else 0)
