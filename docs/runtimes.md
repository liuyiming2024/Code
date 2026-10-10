# 浏览器里的语言运行时（资源清单）

## 先纠正一个说法：这些都有版权，但都能免费用

之前 README 里写「需要随仓库分发第三方产物」——这话容易读成
「因为是别人的东西所以不能用」。**这是错的。**

下面每一个都是**开源项目**，用的是宽松许可证：

| 许可证 | 含义 | 这里涉及的项目 |
| --- | --- | --- |
| MIT | 随便用，商用也行，只需保留版权声明 | QuickJS、sql.js、Fengari、Wasmley |
| MPL-2.0 | 文件级 copyleft，改了源文件要公开该文件 | Pyodide |
| Apache-2.0 | 宽松，附带专利授权 | php-wasm |
| BSD | 宽松 | TinyGo |

**所以「版权」从来不是障碍。** 唯一的约束是本项目自己定的：
「零依赖、拿到就能跑、离线可用」。

真正的取舍是下面这件事。

---

## 真正的取舍：离线优先 vs 按需加载

```
方案 A：把运行时塞进仓库
  ✅ 完全离线
  ❌ 仓库多出几十 MB 二进制，clone 变慢，且不再是"手写代码"

方案 B：每次从 CDN 加载
  ✅ 仓库干净
  ❌ 断网就废了，违背"离线亦可直接查看"

方案 C：按需加载 + 本地缓存  ← 推荐
  第一次点运行时时才下载，之后存进 Cache Storage / IndexedDB
  ✅ 仓库干净
  ✅ 第二次起离线也能用
  ⚠ 首次需要联网（这点要在界面上说明白，不能装作没有）
```

**方案 C 是正解。** 它把冲突化解了：仓库保持零依赖，
用户主动要用某语言时才付出那次下载，之后就一直能用。

---

## 各语言运行时清单

### Python —— Pyodide

- 是什么：**完整的 CPython 编译到 WebAssembly**，不是简化版
- 体积：核心 **6–12 MB**（压缩后），首次加载 2–5 秒
- 许可证：**MPL-2.0**
- 加载：
  ```js
  importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js');
  const py = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/' });
  ```
- 自带：NumPy、Pandas、Matplotlib、SciPy
- 装包：`micropip.install()` 装纯 Python 包；`loadPackage()` 装预编译包
- **坑**：带 C 扩展且不在发行版里的包装不上（浏览器里没东西可编译）
- **必须放 Web Worker**：主线程加载会卡死页面好几秒

### JavaScript —— QuickJS

- 是什么：Fabrice Bellard 写的小巧 ES2025 引擎，编译成 WASM
- 体积：**约 500 KB**（`quickjs.wasm`）
- 许可证：**MIT**
- 用途：项目自己已经能跑 JS 了，但 QuickJS 的价值是**隔离**——
  在独立堆里跑不可信代码，跑飞了也不影响页面
- 限制：没有 DOM、`fetch`、`setTimeout`、`require`；顶层 await 是语法错误

### C / C++ —— Emscripten 系

| 项目 | 体积 | 说明 |
| --- | --- | --- |
| **browsercc** | clang.wasm **43 MB** + lld.wasm 23 MB + sysroot 29 MB | 真正的 Clang，能在浏览器里编译，但很大 |
| **emception** | 更大 | Emscripten 完整环境 |
| Emscripten（本地用） | — | 命令行工具链，不能直接跑在浏览器里 |

- 许可证：MIT / Apache-2.0（LLVM）
- **现实建议**：C++ 走按需加载代价太高（上百 MB）。
  真要支持，优先做**语法着色 + 明确的"暂不支持运行"提示**，
  或者引导用户到本地编译。

### Lua

| 项目 | 实现 | 体积 | 特点 |
| --- | --- | --- | --- |
| **Wasmley** | 官方 PUC-Rio Lua 5.4 编译到 WASM | **~200 KB** gzipped | 100% 兼容，近原生速度，自带 15+ 库 |
| Fengari | 用 JS 重写 Lua | ~200 KB gzipped | 约 95% 兼容，慢 3–10 倍 |

- 许可证：**MIT**
- **Wasmley 是更优选择**：体积小、真 Lua 5.4、还带 HTTP fetch
- 这是「低成本新增一门可运行语言」的最佳候选

### SQLite（SQL）—— sql.js

- 是什么：**完整的 SQLite**（15 万行 C  amalgamation）编译到 WASM
- 体积：**约 1.5 MB**
- 许可证：**MIT**
- 支持：join、子查询、CTE、窗口函数、触发器、视图、全文搜索——全套
- 用法：
  ```js
  const SQL = await initSqlJs({ locateFile: f => `https://sql.js.org/dist/${f}` });
  const db = new SQL.Database();
  db.run('CREATE TABLE t (a int); INSERT INTO t VALUES (1);');
  db.exec('SELECT * FROM t');
  ```
- **本项目已经支持 SQL 着色**，接上这个就能真跑——性价比极高

### PHP —— php-wasm

- 是什么：Zend 引擎编译到 WASM（WordPress Playground 在用）
- 体积：较大（PHP 8.x 运行时）
- 许可证：**Apache-2.0 / GPL-2.0 双许可**
- 覆盖 PHP 8.0–8.5
- 扩展：gd、intl、mbstring、openssl、sqlite、zip、zlib 等
- 限制：不能开 TCP 套接字，`exec`/`proc_open` 不可用

### Go

| 方案 | 体积 | 说明 |
| --- | --- | --- |
| 标准 `GOOS=js GOARCH=wasm` | **2–7 MB**（含运行时） | 官方支持 |
| **TinyGo** | **200–800 KB** | 体积小、启动快，但 Go 语言特性覆盖略少 |

- 许可证：BSD 风格
- TinyGo 更适合浏览器

### Ruby —— Artichoke

- 是什么：用 Rust 写的 Ruby 实现，目标兼容 MRI 2.6.3
- 有官方的 **WASM Playground**
- 状态：pre-release，还在演进

### Rust

- 有 `rustc.wasm`（Weblings 项目）能在浏览器里编译
- 体积大、构建复杂，优先级建议放最后

---

## 推荐接入顺序

按「性价比」排——**体积 ÷ 价值**：

| 顺序 | 语言 | 体积 | 理由 |
| --- | --- | --- | --- |
| 1 | **SQLite（sql.js）** | 1.5 MB | 项目已支持 SQL 着色，接上就能真跑，几乎是白捡 |
| 2 | **Lua（Wasmley）** | 200 KB | 极小、真 Lua 5.4、游戏脚本常用 |
| 3 | **Python（Pyodide）** | 6–12 MB | 需求最大，代价也最大，但值得 |
| 4 | **QuickJS** | 500 KB | 价值在隔离沙箱，不在"多一门语言" |
| 5 | PHP | 大 | 除非有明确需求 |
| 6 | C / C++ | 上百 MB | 不建议，优先做着色 + 明确提示 |
| 7 | Go / Rust / Ruby | 中~大 | 优先级最低 |

---

## 接入时必须做的三件事

1. **放 Web Worker**。主线程加载几十 MB 的 WASM 会白屏好几秒。
2. **显示下载进度**。用户主动点了运行，就得让他知道在下载什么、还剩多久。
   静默等 10 秒是最差体验。
3. **说清首次需要联网**。缓存好之后离线可用，但首次不是。
   别装作没有这一步——用户断网时点了没反应又没提示，只会以为是坏了。

---

## 别做的事

- **不要把 WASM 二进制提交进仓库**。几十 MB 二进制放进 git，
  clone 一次就再也快不起来了。
- **不要为了"看起来能跑"做假实现**。跑不了就明确说跑不了，
  伪造输出比不支持更糟。
- **不要忽略许可证要求**。宽松许可也要保留版权声明——
  用 Pyodide 就在合适位置放上 MPL-2.0 声明。
