#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JudgeOps 的 Python 复刻对拍。

Kotlin 编不了（环境没 Android SDK），但**逻辑**可以复刻验证。
重点在那些"不做就会误报 WA"的边界 ——
误报 WA 会让用户去查自己根本没错的算法。
"""
import sys

# ---------- normalize：复刻 Kotlin 实现 ----------
def normalize(s):
    if not s:
        return ""
    unified = s.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.rstrip() for ln in unified.split("\n")]
    return "\n".join(lines).rstrip("\n")

def compare(actual, expected):
    return normalize(actual or "") == normalize(expected or "")

P = F = 0
def t(name, ok, extra=""):
    global P, F
    if ok:
        P += 1; print("  ✅ " + name)
    else:
        F += 1; print("  ❌ " + name + (" —— " + extra if extra else ""))

print("判题纯函数测试")

# ---------- 1. 必须归一化（否则大量误报 WA） ----------
t("末尾多一个换行 → 相等", compare("3\n", "3"))
t("末尾多个换行 → 相等", compare("3\n\n\n", "3"))
t("行尾空格 → 相等", compare("1 2 \n", "1 2"))
t("Windows 换行 → 相等", compare("3\r\n", "3\n"))
t("混合换行 → 相等", compare("a\r\nb\r\n", "a\nb"))
t("多行末尾换行 → 相等", compare("1\n2\n", "1\n2"))

# ---------- 2. 绝不能归一化（做了就是 bug） ----------
t("行首空格必须保留（缩进有意义）", not compare("  ab", "ab"))
t("中间空行必须保留", not compare("a\n\nb", "a\nb"))
t("大小写敏感", not compare("Abc", "abc"))
t("数字格式不同 → 不相等", not compare("3", "3.0"))
t("内容不同 → 不相等", not compare("3", "4"))
t("多余行 → 不相等", not compare("3\n4", "3"))

# ---------- 3. normalize 的细节 ----------
t("空串不炸", normalize("") == "")
t("纯换行归一成空", normalize("\n\n") == "")
t("只去末尾换行，不去开头", normalize("\na\n") == "\na")
t("末尾空格行不会残留空行", normalize("a\n  \n") == "a")

# ---------- 4. 样例解析 ----------
def parse_cases(text):
    if not text.strip():
        return []
    body = text[:-1] if text.endswith("\n") else text
    out = []
    inp, exp = [], []
    target = None
    for raw in body.split("\n"):
        line = raw.rstrip()
        if line.startswith("---"):
            tag = line[3:].strip().lower()
            if tag.startswith("in"):
                target = inp
            elif tag.startswith("exp") or tag.startswith("out"):
                target = exp
            else:
                target = None
        elif line == "===":
            out.append(("\n".join(inp), "\n".join(exp)))
            inp, exp, target = [], [], None
        else:
            if target is not None:
                target.append(line)
    if inp or exp:
        out.append(("\n".join(inp), "\n".join(exp)))
    return out

sample = "--- input\n1 2\n--- expected\n3\n===\n--- input\n3 4\n--- expected\n7"
cases = parse_cases(sample)
t("解析出两组", len(cases) == 2, str(len(cases)))
t("第一组正确", cases[0] == ("1 2", "3"), str(cases[0]))
t("第二组正确", cases[1] == ("3 4", "7"), str(cases[1]))

# 最后一组没有 === 收尾
tail = parse_cases("--- input\n5\n--- expected\n5")
t("最后一组无 === 也能解析", len(tail) == 1 and tail[0] == ("5", "5"))

# 多行输入（这是用显式分隔符的原因）
multi = parse_cases("--- input\n3\n1 2 3\n--- expected\n6")
t("多行输入解析正确", multi[0][0] == "3\n1 2 3", str(multi[0]))
t("空文本返回空列表", parse_cases("") == [] and parse_cases("   ") == [])

# ---------- 5. 往返 ----------
def format_cases(cs):
    parts = []
    for i, (i_, e_) in enumerate(cs):
        if i > 0:
            parts.append("===")
        parts.append("--- input")
        parts.append(i_)
        parts.append("--- expected")
        parts.append(e_)
    return "\n".join(parts) + "\n"

rt = parse_cases(format_cases(cases))
t("序列化→解析能还原（用户每次打开不会变）", rt == cases, str(rt))

# ---------- 6. 汇总 ----------
def all_passed(vs):
    return len(vs) > 0 and all(v == "AC" for v in vs)
def summary(vs):
    if not vs:
        return "还没有样例"
    ac = vs.count("AC")
    return "全部通过（%d/%d）" % (ac, len(vs)) if ac == len(vs) else "%d/%d 通过" % (ac, len(vs))
def first_failure(vs):
    for i, v in enumerate(vs):
        if v != "AC":
            return i + 1
    return None

t("全 AC 才算通过", all_passed(["AC", "AC"]) and not all_passed(["AC", "WA"]))
t("空列表不算通过（不能说没测就通过）", not all_passed([]))
t("UNKNOWN 不算通过（等于撒谎）", not all_passed(["AC", "UNKNOWN"]))
t("汇总文案 全通过", summary(["AC", "AC"]) == "全部通过（2/2）")
t("汇总文案 部分通过", summary(["AC", "WA"]) == "1/2 通过")
t("定位第一组失败（不是最后一组）", first_failure(["AC", "WA", "WA"]) == 2)
t("全通过时没有失败项", first_failure(["AC", "AC"]) is None)

print("\n通过 %d / %d" % (P, P + F))
sys.exit(1 if F else 0)
