# 复刻 EditorOps.kt 的纯逻辑，验证算法正确性
# （Kotlin 编译不了，但算法对不对照样能验）

INDENT = "    "

def insert(s, caret, text):
    return s[:caret] + text + s[caret:], caret + len(text)

def insert_bracket(s, caret, open_c, close_c):
    after = s[caret] if caret < len(s) else None
    if after is not None and (after.isspace() or after in ")]}>"):
        return s[:caret] + open_c + close_c + s[caret:], caret + len(open_c)
    # 先插一对，再把光标退回中间
    s2, _ = insert(s, caret, open_c + close_c)
    return s2, caret + len(open_c)

def backspace(s, caret):
    if caret == 0: return s, 0
    n = len(INDENT)
    if n > 1 and caret >= n and s[caret-n:caret] == INDENT:
        return s[:caret-n] + s[caret:], caret - n
    return s[:caret-1] + s[caret:], caret - 1

def indent_of(line):
    i = 0
    while i < len(line) and line[i] in ' \t': i += 1
    return line[:i]

def enter(s, caret):
    ls = s.rfind('\n', 0, caret)
    ls = 0 if ls < 0 else ls + 1
    cur = s[ls:caret]
    lead = indent_of(cur)
    t = cur.rstrip()
    extra = INDENT if t.endswith(('{', ':', '(', '[')) else ""
    ins = "\n" + lead + extra
    return s[:caret] + ins + s[caret:], caret + len(ins)

def lines_of(s): return s.split('\n')

def move_vertical(s, caret, delta):
    lines = lines_of(s)
    line = 0; consumed = 0
    for i in range(len(lines)):
        if caret <= consumed + len(lines[i]):
            line = i; break
        consumed += len(lines[i]) + 1
        line = i + 1
    col = caret - consumed
    target = max(0, min(len(lines)-1, line + delta))
    newcol = min(col, len(lines[target]))
    pos = sum(len(lines[i]) + 1 for i in range(target)) + newcol
    return max(0, min(len(s), pos))

def home(s, caret):
    ls = s.rfind('\n', 0, caret)
    ls = 0 if ls < 0 else ls + 1
    line = s[ls:caret]
    n = len(indent_of(line))
    return ls if (caret == ls + n or n == 0) else ls + n

def end(s, caret):
    nl = s.find('\n', caret)
    return len(s) if nl < 0 else nl

P=F=0
def ck(c, m, extra=""):
    global P,F
    if c: P+=1; print("  ✅ %s" % m)
    else: F+=1; print("  ❌ %s %s" % (m, extra))

print("=== insertText ===")
s,c = insert("hello", 5, "!")
ck(s=="hello!" and c==6, "末尾插入", (s,c))
s,c = insert("abcd", 2, "X")
ck(s=="abXcd" and c==3, "中间插入", (s,c))

print("\n=== insertBracket（自动配对）===")
s,c = insert_bracket("", 0, "(", ")")
ck(s=="()" and c==1, "空处插入括号，光标在中间", (s,c))
s,c = insert_bracket("f(x)", 4, "(", ")")
ck(s=="f(x)()" and c==5, "右侧是闭括号时插入一对", (s,c))
s,c = insert_bracket("if ", 3, "(", ")")
ck(s=="if ()" and c==4, "右侧是空格时插入一对", (s,c))
s,c = insert_bracket("for", 3, "(", ")")
ck(s=="for()" and c==4, "紧邻字符时也配对", (s,c))

print("\n=== backspace 删缩进 ===")
s,c = backspace("a" + INDENT, 1+len(INDENT))
ck(s=="a" and c==1, "一次删掉整个缩进单位（4空格）", repr(s))
s,c = backspace("ab", 2)
ck(s=="a" and c==1, "普通字符删一个")
s,c = backspace("", 0)
ck(s=="" and c==0, "行首退格不越界")

print("\n=== enter 缩进继承 ===")
s,c = enter(INDENT+"int a;", len(INDENT)+6)
ck(s == INDENT+"int a;\n"+INDENT, "继承前导缩进", repr(s))
s,c = enter("if (x) {", 8)
ck(s == "if (x) {\n"+INDENT, "行尾是 { 时多缩进一级", repr(s))
s,c = enter("def f():", 8)
ck(s == "def f():\n"+INDENT, "行尾是 : 时多缩进一级（Python）", repr(s))
s,c = enter("x", 1)
ck(s == "x\n", "无缩进不加多余空白", repr(s))

print("\n=== moveVertical 保持列号 ===")
# ⚠ 这几个用例的预期我一开始写错了（把列号数错），
#   于是**正确的代码被判成失败**。修正的是预期，不是实现。
#   教训：测试写错会掩盖真问题，也会冤枉对的代码 ——
#   所以动手改实现之前，先照位置表把预期数一遍。
txt = "abc\nhello\nxy"
# 位置: a0 b1 c2 \n3 h4 e5 l6 l7 o8 \n9 x10 y11
ck(move_vertical(txt, 5, -1) == 1, "'e'(5,col1) 上移 → 'b'(1)", move_vertical(txt,5,-1))
ck(move_vertical(txt, 2, 1) == 6, "'c'(2,col2) 下移 → 'l'(6)", move_vertical(txt,2,1))
ck(move_vertical("abc\nxy", 5, -1) == 1, "'y'(5,col1) 上移 → 'b'(1)", move_vertical("abc\nxy",5,-1))
t3 = "abcdef\nxy"
ck(move_vertical(t3, 4, 1) == 9, "'e'(col4) 下移到短行，列号夹到2 → 9", move_vertical(t3,4,1))
ck(move_vertical("abc", 1, -1) == 1, "首行再上移不动")
ck(move_vertical(txt, 11, 1) == 11, "末行再下移不动")
ck(move_vertical("", 0, 1) == 0, "空文本不崩")

print("\n=== Home 两级 ===")
t2 = INDENT + "int a;"
ck(home(t2, 8) == len(INDENT), "第一次到缩进之后", home(t2,8))
ck(home(t2, len(INDENT)) == 0, "再按到行首", home(t2,len(INDENT)))

print("\n=== End ===")
ck(end("abc\ndef", 1) == 3, "跳到本行末尾", end("abc\ndef",1))
ck(end("abc", 1) == 3, "最后一行跳到结尾", end("abc",1))

print("\n通过 %d / %d" % (P, P+F))
