#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Highlighter.kt 的 Python 复刻。
环境无 kotlinc，编译不了；但 highlight() 是纯算法，复刻一份就能验行为。
重点验的是"正则高亮会翻车"的那几个场景。
"""
import sys

CPP = {"if","else","for","while","do","return","break","continue","switch","case","default",
 "goto","struct","union","enum","typedef","const","static","extern","volatile","inline",
 "public","private","protected","virtual","template","typename","namespace","using","new",
 "delete","try","catch","throw","sizeof","nullptr","true","false","this","operator","friend",
 "explicit","const_cast","static_cast","reinterpret_cast"}
CPP_T = {"int","char","float","double","void","bool","long","short","unsigned","signed","auto",
 "size_t","string","vector","map","set","pair","list","deque","array","stack","queue","iostream"}
PY = {"def","class","if","elif","else","for","while","return","break","continue","pass","import",
 "from","as","try","except","finally","raise","with","lambda","global","nonlocal","assert","del",
 "yield","async","await","True","False","None","and","or","not","in","is"}
PY_T = {"str","int","float","bool","list","dict","set","tuple","print"}
JS = {"var","let","const","function","class","if","else","for","while","do","return","break",
 "continue","switch","case","default","new","delete","try","catch","finally","throw","typeof",
 "instanceof","this","true","false","null","undefined","async","await","yield","import",
 "export","extends","super"}
JS_T = {"String","Number","Boolean","Array","Object","Math","JSON","Promise"}

def lang_of(p):
    if "." not in p: return ""
    ext = p.rsplit(".", 1)[1].lower()
    return {"c":"cpp","cc":"cpp","cpp":"cpp","cxx":"cpp","h":"cpp","hpp":"cpp",
            "py":"py","js":"js","mjs":"js","ts":"js"}.get(ext, "")

def highlight(src, lang):
    out = []
    n = len(src)
    if n == 0 or lang == "": return out
    kw = {"cpp":CPP,"py":PY,"js":JS}.get(lang, set())
    ty = {"cpp":CPP_T,"py":PY_T,"js":JS_T}.get(lang, set())
    hash_comment = (lang == "py")
    triple = (lang == "py")
    i = 0
    while i < n:
        c = src[i]
        if (c == "/" and i+1 < n and src[i+1] == "/") or (hash_comment and c == "#"):
            j = i
            while j < n and src[j] != "\n": j += 1
            out.append((i, j, "Comment")); i = j; continue
        if c == "/" and i+1 < n and src[i+1] == "*":
            close = src.find("*/", i+2)
            j = n if close < 0 else close + 2
            out.append((i, j, "Comment")); i = j; continue
        if triple and (src.startswith('"""', i) or src.startswith("'''", i)):
            q = src[i:i+3]
            close = src.find(q, i+3)
            j = n if close < 0 else close + 3
            out.append((i, j, "String")); i = j; continue
        if c == '"' or c == "'":
            j = i + 1
            while j < n:
                if src[j] == "\\": j += 2
                elif src[j] == c: j += 1; break
                elif src[j] == "\n": break
                else: j += 1
            e = min(j, n)
            out.append((i, e, "String")); i = e; continue
        if c.isdigit() or (c == "." and i+1 < n and src[i+1].isdigit()):
            j = i + 1
            while j < n:
                ch = src[j]; prev = src[j-1]
                ok = ch.isdigit() or ch == "." or ch == "_" or ch.isalpha() or \
                     ((prev in "eE") and (ch in "+-"))
                if not ok: break
                j += 1
            out.append((i, j, "Number")); i = j; continue
        if c.isalpha() or c == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] == "_"): j += 1
            w = src[i:j]
            if w in kw: t = "Keyword"
            elif w in ty: t = "Type"
            else:
                k = j
                while k < n and src[k] in " \t": k += 1
                t = "Func" if (k < n and src[k] == "(") else "Plain"
            out.append((i, j, t)); i = j; continue
        out.append((i, i+1, "Plain")); i += 1
    merged = []
    for t in out:
        if merged and merged[-1][2] == "Plain" and t[2] == "Plain" and merged[-1][1] == t[0]:
            merged[-1] = (merged[-1][0], t[1], "Plain")
        else:
            merged.append(t)
    return merged

P = F = 0
def t(n, c, e=""):
    global P, F
    if c: P += 1; print("  ✅ " + n)
    else: F += 1; print("  ❌ " + n + (" —— " + e if e else ""))

def contiguous(src, toks):
    """token 必须首尾相接、完整覆盖"""
    if not toks: return len(src) == 0
    if toks[0][0] != 0 or toks[-1][1] != len(src): return False
    for a, b in zip(toks, toks[1:]):
        if a[1] != b[0]: return False
    return True

def kinds(src, lang, start, end):
    return [k for (s, e, k) in highlight(src, lang) if s >= start and e <= end and s < end]

print("语法高亮验证")

# --- 语言判定 ---
t("cpp 扩展名", lang_of("a/b.cpp") == "cpp")
t("hpp 也算 cpp", lang_of("x.hpp") == "cpp")
t("py", lang_of("a.py") == "py")
t("js", lang_of("a.mjs") == "js")
t("认不出不涂色", lang_of("README") == "")
t("奇怪扩展名不涂色", lang_of("a.xyz") == "")

# --- 正则会翻车的经典场景 ---
s = 'printf("a//b");'
t("字符串里的 // 不是注释（正则会串色）",
  all(k != "Comment" for k in kinds(s, "cpp", 7, 13)), str(kinds(s, "cpp", 0, len(s))))
s = '// "not a string"'
t("注释里的引号不是字符串",
  [k for (a, b, k) in highlight(s, "cpp") if a == 0][0] == "Comment")
s = '"a\\"b"'
t("转义引号不提前结束字符串",
  [ (a,b,k) for (a,b,k) in highlight(s, "cpp") if k == "String" ] == [(0, 6, "String")],
  str(highlight(s, "cpp")))

# --- 未闭合字符串不能吞掉后面 ---
s = 'a = "abc\nb = 2\n'
toks = highlight(s, "py")
strs = [(a, b) for (a, b, k) in toks if k == "String"]
t("未闭合字符串只到行尾（不吞掉后面的行）", strs == [(4, 8)], str(strs))
# ⚠ 不能指望 'b' 是独立 token —— 相邻的 Plain 会被合并成一大段。
#   所以按**位置查覆盖**：看 index 9 落在哪个 token 里。
#   （我第一次就写成了"必须存在 s[a:b]=='b' 的 Plain token"，于是对的代码被判失败。）
def kind_at(src_, lang_, pos):
    for (a, b, k) in highlight(src_, lang_):
        if a <= pos < b: return k
    return None
t("下一行的 b 位置仍是普通（没被吞进字符串色）", kind_at(s, "py", 9) == "Plain", str(kind_at(s, "py", 9)))
t("下一行的数字 2 位置是 Number", kind_at(s, "py", 13) == "Number", str(kind_at(s, "py", 13)))

# --- Python 三引号跨行 ---
s = 'x = """a\nb"""\ny = 1'
toks = highlight(s, "py")
st = [(a, b) for (a, b, k) in toks if k == "String"]
t("三引号跨行", st == [(4, 13)], str(st))

# --- 注释优先级 ---
t("/* 里含 // 时按块注释走", [k for (a,b,k) in highlight("/* // */", "cpp") if a == 0][0] == "Comment")
t("// 里含 /* 时按行注释走",
  [(a,b) for (a,b,k) in highlight("// /* \nx", "cpp") if k == "Comment"] == [(0, 6)])

# --- 数字 ---
for num, want in [("123", (0,3)), ("1.5", (0,3)), ("0x1f", (0,4)), ("1e+5", (0,4)), (".5", (0,2))]:
    got = [(a,b) for (a,b,k) in highlight(num, "cpp") if k == "Number"]
    t("数字 %s" % num, got == [want], str(got))
t("1+2 是两个数字", len([1 for (a,b,k) in highlight("1+2", "cpp") if k == "Number"]) == 2)

# --- 关键字 vs 标识符前缀 ---
t("if 是关键字", [k for (a,b,k) in highlight("if", "cpp") if a == 0][0] == "Keyword")
t("iffy 不是关键字（前缀不能误判）",
  [k for (a,b,k) in highlight("iffy", "cpp") if a == 0][0] == "Plain")
t("int 是类型", [k for (a,b,k) in highlight("int", "cpp") if a == 0][0] == "Type")

# --- 函数调用识别 ---
t("foo( 识别为函数", [k for (a,b,k) in highlight("foo(", "cpp") if a == 0][0] == "Func")
t("foo 后面没括号就是普通", [k for (a,b,k) in highlight("foo", "cpp") if a == 0][0] == "Plain")
t("foo ( 带空格也算", [k for (a,b,k) in highlight("foo (", "cpp") if a == 0][0] == "Func")

# --- 覆盖性（最关键的一条） ---
CASES = [
    ('#include <iostream>\nint main() { cout << "hi"; return 0; }', "cpp"),
    ('def f(x):\n    return x + 1  # ok\n', "py"),
    ('const a = "x"; // c\nfunction f(){ return 1 }', "js"),
    ('a = "abc\nb = 2\n', "py"),
    ('x = """a\nb"""\ny = 1', "py"),
    ('/* unterminated\nfoo', "cpp"),
    ("'", "cpp"), ('"', "cpp"), ("", "cpp"), ("   \n\n", "cpp"),
    ('中文注释 // 你好 "引号"', "cpp"),
    ("0x1f 1e+5 .5 1+2", "cpp"),
]
bad = [(s, l) for (s, l) in CASES if not contiguous(s, highlight(s, l))]
t("所有用例 token 首尾相接且完整覆盖", not bad, str(bad))

# --- 空与纯文本 ---
t("空串无 token", highlight("", "cpp") == [])
t("未知语言不涂色", highlight("int x = 1;", "") == [])

print("\n通过 %d / %d" % (P, P + F))
sys.exit(1 if F else 0)
