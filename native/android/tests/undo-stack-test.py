#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""撤销栈算法验证 —— Kotlin 版 UndoStack.kt 的 Python 复刻。
环境里没有 kotlinc / Android SDK，编译不了。
所以把这个**纯算法**用同样的逻辑抄一遍，跑行为测试。
它验证的是算法（合并策略、区间计算、重做清空），不是 Kotlin 语法。
"""
import sys

COALESCE_MS = 600

class UndoStack:
    def __init__(self, limit=100, coalesce_ms=COALESCE_MS):
        self.limit = limit
        self.coalesce = coalesce_ms
        self.undo = []
        self.redo = []
        self.base = ""

    def reset(self, text):
        self.undo = []; self.redo = []; self.base = text

    @property
    def depth(self): return len(self.undo)
    @property
    def can_undo(self): return len(self.undo) > 0
    @property
    def can_redo(self): return len(self.redo) > 0

    def push(self, before, after, start, end, now):
        if before == after: return
        insert = end <= start
        e = {"text": after, "start": start,
             "end": start + (len(after) - len(before)) if insert else end,
             "insert": insert, "at": now}
        top = self.undo[-1] if self.undo else None
        if top:
            contiguous = (e["start"] == top["end"]) if insert else (e["end"] == top["start"])
        else:
            contiguous = False
        merge = (top is not None and top["insert"] == insert
                 and now - top["at"] <= self.coalesce and contiguous)
        if merge:
            self.undo.pop()
            self.undo.append({"text": after,
                              "start": min(top["start"], e["start"]),
                              "end": max(top["end"], e["end"]),
                              "insert": insert, "at": now})
        else:
            self.undo.append(e)
            while len(self.undo) > self.limit:
                self.base = self.undo.pop(0)["text"]
        self.redo = []

    def do_undo(self, current, now=0):
        if not self.undo: return None
        e = self.undo.pop()
        self.redo.append({"text": current, "start": e["start"], "end": e["end"],
                          "insert": e["insert"], "at": now})
        return self.base if not self.undo else self.undo[-1]["text"]

    def do_redo(self):
        if not self.redo: return None
        e = self.redo.pop()
        self.undo.append(e)
        return e["text"]


P = F = 0
def t(name, cond, extra=""):
    global P, F
    if cond: P += 1; print("  ✅ " + name)
    else: F += 1; print("  ❌ " + name + (" —— " + extra if extra else ""))

def type_run(st, text, start, now):
    """模拟逐字输入"""
    cur = st.base if not st.undo else st.undo[-1]["text"]
    for i, ch in enumerate(text):
        before = cur
        cur = cur[:start + i] + ch + cur[start + i:]
        st.push(before, cur, start + i, start + i, now)

print("撤销栈算法验证")

# ---- 1. 连打合并成一步 ----
st = UndoStack(); st.reset("")
type_run(st, "hello", 0, 1000)
t("连打 5 个字符合并成 1 步（不是 5 步）", st.depth == 1, "实际 %d 步" % st.depth)
t("撤销一次回到空", st.do_undo("hello", 2000) == "")
t("再撤销没有了", st.do_undo("", 2000) is None)
t("重做回到 hello", st.do_redo() == "hello")

# ---- 2. 中间停顿不合并 ----
st = UndoStack(); st.reset("")
type_run(st, "ab", 0, 1000)
type_run(st, "cd", 2, 1000 + COALESCE_MS + 500)   # 停了超过时间窗
t("停顿超过时间窗 → 分成 2 步", st.depth == 2, "实际 %d 步" % st.depth)
t("撤销一次回到 'ab'", st.do_undo("abcd", 9000) == "ab")
t("再撤销回到空", st.do_undo("ab", 9000) == "")

# ---- 3. 不连续（跳到别处）不合并 ----
st = UndoStack(); st.reset("xxxx")
st.push("xxxx", "axxxx", 0, 0, 1000)
st.push("axxxx", "axxxxb", 5, 5, 1100)
t("两处不相邻的插入不合并", st.depth == 2, "实际 %d 步" % st.depth)

# ---- 4. 连续退格合并 ----
st = UndoStack(); st.reset("abcde")
cur = "abcde"
for i in range(3):
    before = cur; cur = cur[:-1]
    st.push(before, cur, len(cur), len(before), 1000)
t("连续退格 3 次合并成 1 步", st.depth == 1, "实际 %d 步" % st.depth)
t("撤销一次回到 abcde", st.do_undo(cur, 2000) == "abcde")

# ---- 5. 插入与删除不互相合并 ----
st = UndoStack(); st.reset("")
st.push("", "a", 0, 0, 1000)
st.push("a", "", 0, 1, 1050)
t("插入后紧接着删除不合并", st.depth == 2, "实际 %d 步" % st.depth)

# ---- 6. 新编辑必须清空重做栈 ----
st = UndoStack(); st.reset("")
st.push("", "a", 0, 0, 1000)
st.do_undo("a", 2000)
t("撤销后可重做", st.can_redo)
st.push("", "b", 0, 0, 3000)
t("撤销后改了别的 → 重做栈清空（不能重做出对不上的内容）", not st.can_redo)

# ---- 7. 上限与 base 推进 ----
st = UndoStack(limit=3); st.reset("0")
for i in range(1, 8):
    st.push(str(i - 1), str(i), 0, 1, 1000 + i * 1000)   # 每次都超过时间窗，不合并
t("栈深不超过上限", st.depth == 3, "实际 %d" % st.depth)
t("撤销到底能回到合法文本（不是撤到已丢弃的）",
  st.do_undo("7", 99999) is not None)

# ---- 8. reset ----
st = UndoStack(); st.reset("")
st.push("", "a", 0, 0, 1000)
st.reset("new")
t("reset 后不能撤销（换文件不该带着旧文件的历史）", not st.can_undo)
t("reset 后不能重做", not st.can_redo)

# ---- 9. 空操作不入栈 ----
st = UndoStack(); st.reset("same")
st.push("same", "same", 0, 0, 1000)
t("内容没变不入栈", st.depth == 0)

print("\n通过 %d / %d" % (P, P + F))
sys.exit(1 if F else 0)
