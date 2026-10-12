# C++ 支持范围（cpplite）

> 自研教学级解释器，不是编译器。写在这里的是**实测跑通过的**，不是"打算支持"。

## 基础

`main` / `cin` `cout` / `printf` / `#include <bits/stdc++.h>` / `using namespace std`
- 流操纵符 `endl`（换行）、`fixed`、`hex`、`boolalpha` 等（格式类只影响格式，不报错）
- `cout << bool` 输出 `1`/`0`
- 数字后缀 `1LL` `1000000007LL` `3.5f`
- 位运算按 64 位算：`1LL << 40` = 1099511627776（JS 原生 32 位会算成 256）

## 类型

`int` `long long` `unsigned` `unsigned long long` `long double` `short` `char`
`bool` `float` `double` `string` `auto`

- `typedef int ll;`
- C 风格强制转换 `(int)3.9` `(char)200`
- `long long` 等多词类型（防溢出必需）

## 控制流

`if` / `else` / `for` / `while` / `do-while` / `switch`（含 case 穿透与 default）
`break` / `continue` / `return`

- **范围 for**：`for (auto x : v)`、`for (int &x : a)`（引用形式会写回容器）

## 数组与容器

- 一维与多维数组 `int a[2][2]`
- **二维 vector** `vector<vector<int>>`（含 `g(n)` 构造与 `g[i].push_back(x)`）
- 花括号初始化 `vector<int> v = {3,1,2}`、`int a[3] = {1,2,3}`
- `vector`（`push_back` `size` `pop_back` `begin` `end` `front` `back`）
- `set`（`insert` `count` `erase` `size`）
- `map`（下标读写、`size` `count` `find` `erase`）
- `stack` `queue` `priority_queue` `deque`
- `pair`（`first` `second`、`make_pair`）

## <algorithm>

`sort`（三种调用形式，含迭代器）`reverse` `unique` `fill` `swap`
`max_element` `min_element` `accumulate` `count` `find`
`lower_bound` `upper_bound` `binary_search` `next_permutation` `distance`
`__gcd` `__builtin_popcount`

## 预处理

- `#define N 5` 常量宏（会真正展开）
- `#define SQ(x) ((x)*(x))` 宏函数（带参替换）
- 宏套宏（迭代展开，深度上限 12）

**不支持**：`#ifdef` 条件编译、`#` 字符串化、`##` 连接。用到时会明确报出。

## 函数

- 递归、默认参数 `int f(int a, int b = 10)`
- 引用参数 `int &n`
- 引用变量 `int &r = x;`（读写转发到原变量）
- 函数名可当值传（比较器依赖它）
- `swap(a, b)` 交换变量

## struct

声明、变量、成员读写、struct 数组、`for (auto &n : arr)`

## 未定义行为（UB）

两档可选，`Code.cpplite.setUB('real')` 切换：

| | safe（默认） | real |
|---|---|---|
| 整数溢出 | 数学正确结果 | 按宽度回绕（`2147483647+1 → -2147483648`）|
| 数组越界 | 明确报错 | 模拟读到不确定值 |
| 未初始化变量 | 0 | 垃圾值 |
| 浮点除零 | `Infinity`（两档一致，IEEE 754 规定）|

**为什么不一律报错**：Code 面向教学与竞赛。真实 C++ 里 UB 不报错，
一律报错会掩盖真实行为 —— 学生写的程序在这里"很安全"，一提交 OJ 就 WA。

## 不支持（会明确报出，不静默）

指针与地址运算、模板、STL 的自定义比较器、多文件、`#include` 真实头文件、
位域、`goto`、异常处理。
