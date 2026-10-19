/* ============================================================
   OJ 代提交代理
   ------------------------------------------------------------
   **为什么必须有这一层（不是可选项）**：
   浏览器**做不到**带你的 OJ cookie 去访问别的网站 ——
   CORS 与 Cookie 同源策略会直接挡死。这不是"难做"，是**做不到**。
   VJ 能做，正是因为它有真正的后端服务器。
   所以这一层是必需的，就像我们 Supabase 上已有的云盘函数。

   ---------- 本设计最重要的一条：无状态转发 ----------
   凭据**只在本次请求里**，用完即弃：
     · 不写库、不写日志、不进任何持久化
     · 每次请求独立，函数执行完什么都不剩
   凭据本身由**浏览器**提供（存在用户自己的 localStorage 里）。
   也就是说：我们**不保管**任何人的 OJ 登录态 ——
   这跟 VJ 把用户 cookie 存进自己数据库是**完全不同的做法**。

   这样做的代价：每次提交都要带上凭据（多传几百字节）。
   换来的：即使我们的数据库被拖走，也拿不到任何人的 OJ 登录态。
   这笔交换我认为值得，所以这么定。

   ---------- 免责 ----------
   本功能由用户主动开启、自担风险。详见仓库 docs/做题平台.md。
   平台可能认为自动化提交违反其服务条款，后果（限流、封号）由用户承担。
   ============================================================ */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  /* ⚠ x-session 必须在这里列出。
     不列的话浏览器预检（OPTIONS）会被拒，
     而报错是 CORS 相关的一串字 —— 完全看不出真正原因是
     "自定义头没进白名单"。这类问题极难定位。 */
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* ---------- 统一的判题结果 ---------- */
/* 各家 OJ 的判定词不一样（Accepted / AC / 答案正确…），
   不归一的话前端要为每个 OJ 写一套显示逻辑，
   而且**归一错了会把 WA 显示成 AC** —— 那是最糟的一种错。 */
const VERDICT_MAP: Record<string, string> = {
  // Codeforces
  OK: "AC", ACCEPTED: "AC", "ACCEPTED": "AC",
  "WRONG_ANSWER": "WA", "TIME_LIMIT_EXCEEDED": "TLE",
  "MEMORY_LIMIT_EXCEEDED": "MLE", "RUNTIME_ERROR": "RE",
  "COMPILATION_ERROR": "CE",
  // 洛谷 / 中文 OJ
  "答案正确": "AC", "AC": "AC", "Accepted": "AC",
  "答案错误": "WA", "Wrong Answer": "WA",
  "时间超限": "TLE", "Time Limit Exceeded": "TLE",
  "内存超限": "MLE", "运行错误": "RE", "编译错误": "CE",
  "Runtime Error": "RE", "Compile Error": "CE",
};

function normalizeVerdict(raw: string): string {
  if (!raw) return "UNKNOWN";
  const s = raw.trim();
  if (VERDICT_MAP[s]) return VERDICT_MAP[s];
  const up = s.toUpperCase();
  if (VERDICT_MAP[up]) return VERDICT_MAP[up];
  /* 兜底：包含匹配。放最后，避免 "Wrong Answer on test 3" 这类
     带测试点编号的文本匹配不上。 */
  if (/accept|正确|\bok\b/i.test(s)) return "AC";
  if (/wrong|错误/i.test(s)) return "WA";
  if (/time|超时|超限.*时/i.test(s)) return "TLE";
  if (/memory|内存/i.test(s)) return "MLE";
  if (/runtime|运行错误/i.test(s)) return "RE";
  if (/compil|编译/i.test(s)) return "CE";
  return "UNKNOWN";
}

/* ---------- 各家 OJ 的提交实现 ---------- */
/* 只实现了 Codeforces。其他 OJ 留了清晰的接入点 ——
   不做"假装支持"：没实现的就直接说没实现，
   否则用户提交了却永远等不到结果，比不支持更糟。 */

interface SubmitArgs {
  oj: string;
  pid: string;
  code: string;
  lang: string;
  cred: string; // cookie 串，由浏览器提供
}

interface SubmitResult {
  ok: boolean;
  remoteId?: string;
  verdict?: string;
  timeMs?: number;
  memKb?: number;
  error?: string;
}

/* ---- Codeforces ----
   提交要点（这些是它反自动化的部分，缺一个都会失败）：
     · 需要 csrf_token
     · 需要 ftaa / bfaa / _tta 三个反自动化参数
       （_tta 是 CF 前端算出来的，我们从用户给的 cookie 里取；
        取不到就退回不带，多数老账号仍可提交）
     · 表单字段名固定：submittedProblemCode / language / source
   因为 ftaa/bfaa 存在 cookie 里，用户只要把整条 cookie 粘来即可，
   我们不需要理解它们是怎么算出来的 —— 这也是"转发"而非"破解"的好处。 */
async function submitCodeforces(a: SubmitArgs): Promise<SubmitResult> {
  const cookie = a.cred;
  const problemUrl = `https://codeforces.com/problemset/problem/${a.pid}`;

  // 1) 取 csrf_token：从题目页里解析
  const page = await fetch(problemUrl, { headers: { cookie } });
  const html = await page.text();
  if (/Enter the password|login/i.test(html.slice(0, 2000)) && !/csrf/i.test(html)) {
    return { ok: false, error: "登录态失效了，请重新获取账号凭据" };
  }
  const csrf = extractCsrf(html);
  if (!csrf) return { ok: false, error: "取不到 csrf token（登录态可能已失效）" };

  const ftaa = pick(cookie, "ftaa");
  const bfaa = pick(cookie, "bfaa");
  const tta = pick(cookie, "_tta");

  const body = new URLSearchParams({
    csrf_token: csrf,
    action: "submitCodeFormSubmitted",
    submittedProblemCode: a.pid,
    language: a.lang || "54", // 54 = GNU G++17
    source: a.code,
    tabSize: "4",
    sourceFile: "",
  });
  if (ftaa) body.set("ftaa", ftaa);
  if (bfaa) body.set("bfaa", bfaa);
  if (tta) body.set("_tta", tta);

  const r = await fetch(`https://codeforces.com/problemset/submit`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0",
      referer: problemUrl,
    },
    body: body.toString(),
    redirect: "manual",
  });

  if (r.status === 403 || r.status === 302) {
    /* 提交成功会重定向到状态页；被拒则回 403。
       两者都可能带 body，所以都要读一下确认。 */
    const t = await r.text();
    if (/is not allowed|verify|captcha/i.test(t)) {
      return { ok: false, error: "平台要求人机验证，暂时无法自动提交" };
    }
  }
  // 2) 从"我的提交"里取最新一条的编号
  const handle = pick(cookie, "handle") || "";
  const statusUrl = handle
    ? `https://codeforces.com/api/user.status?handle=${handle}&from=1&count=1`
    : null;
  if (!statusUrl) return { ok: false, error: "提交已发出，但取不到用户名，无法查询结果" };

  const st = await fetch(statusUrl);
  const j = await st.json();
  if (j.status !== "OK" || !j.result?.length) {
    return { ok: false, error: "提交可能成功，但查不到结果" };
  }
  const s = j.result[0];
  return {
    ok: true,
    remoteId: String(s.id),
    verdict: normalizeVerdict(s.verdict || ""),
    timeMs: s.timeConsumedMillis,
    memKb: s.memoryConsumedBytes ? Math.round(s.memoryConsumedBytes / 1024) : undefined,
  };
}

function extractCsrf(html: string): string {
  const m = html.match(/name=['"]csrf_token['"]\s+value=['"]([^'"]+)['"]/);
  if (m) return m[1];
  const m2 = html.match(/csrf-token["']\s+content=["']([^"']+)["']/);
  return m2 ? m2[1] : "";
}

/* ---------- 题号白名单 ----------
   红队 V-02：pid 未经校验就拼进 URL。
   如实说清边界：host 是硬编码的 codeforces.com，
   所以 pid 只能影响 path 与 query，**偷不走 cookie、不构成 SSRF**。
   但会造成 path 注入（取到非预期页面）和超长 URL。
   题号格式就是「数字 + 可选一个字母」，如 4A / 1234 / 2000B。
   按白名单收紧，不给自己留意外。 */
const PID_RE = /^\d{1,4}[A-Za-z]?$/;
function validPid(p: string): boolean {
  return typeof p === "string" && PID_RE.test(p);
}

function pick(cookie: string, name: string): string {
  const m = cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? m[1] : "";
}

const PROVIDERS: Record<string, (a: SubmitArgs) => Promise<SubmitResult>> = {
  codeforces: submitCodeforces,
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "只接受 POST" }, 405);

  let a: SubmitArgs;
  try {
    a = await req.json();
  } catch {
    return json({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  if (!a.oj || !PROVIDERS[a.oj]) {
    /* 明确列出支持的，避免用户以为都支持 */
    return json({
      ok: false,
      error: `暂不支持 ${a.oj || "（未指定）"}。目前支持：${Object.keys(PROVIDERS).join("、")}`,
    }, 400);
  }
  if (!a.cred || !a.code || !a.pid) {
    return json({ ok: false, error: "缺少凭据 / 代码 / 题号" }, 400);
  }

  /* ============================================================
     鉴权（红队 V-01，P0）
     ------------------------------------------------------------
     上一版**完全没有鉴权** —— 只校验 method 和四个字段，
     CORS 还是 *。后果是任何人、任何网站的 JS 都能把这里
     当成匿名代提交中继：
       · 匿名、不可溯源
       · 刷量触发 CF 风控 → **封的是出口 IP，所有人的代交一起失效**
     所以这一层不是"加个校验"，是这功能能不能对外开放的前提。

     ⚠ 用调用者 token 解析身份，不能只看有没有 Bearer ——
        anon key 也是 Bearer 开头，只检查前缀等于没鉴权。
     ============================================================ */
  /* ⚠⚠ 两套身份体系并存，必须都试（红队 R3-01 / R4-03）
     ------------------------------------------------------------
     本系统真实身份是**自建 sessions**：前端 js/cloud.js 里
     `CHAT_TOKEN_KEY = 'wxlg_sb_token'`，通过 `x-session` 头传给
     PostgREST，由数据库侧的 cur_user() 从 GUC 里读出来。

     而上一版这里用 sb.auth.getUser() 解析 **GoTrue** 令牌 ——
     等于把自建令牌当成 GoTrue 令牌去验，必然失败。
     后果不是"报错"，是**合法用户带自己的有效令牌被判伪造**，
     而且我上一轮加鉴权时前端没同步改（仍在传 anon key），
     于是代提交变成 100% 401 —— 那是我引入的回归。

     修法：两条路都走，先自建会话、再 GoTrue。
     不写死某一种，是因为只有**真实环境**能确定用的是哪套，
     写死任何一边都会让另一边的用户全部失败。 */

  const xSession = (req.headers.get("x-session") || "").trim();
  const auth = req.headers.get("authorization") || "";

  /* ⚠ 用 anon 客户端调 code_oj_who —— 不是 service role。
     该函数是 security definer，自己以属主权限读 sessions，
     开放它不等于开放 sessions 表。
     用 service role 的话，任何人打到这个接口就都能
     以超级权限读全库 —— 那才是真正的越权。 */
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  let uid: string | null = null;
  let via = "";

  if (xSession) {
    const { data: w, error: we } = await sb.rpc("code_oj_who", { p_token: xSession });
    if (!we && w) { uid = String(w); via = "自建会话"; }
  }

  /* 回退：GoTrue。只有第一条路没走通才试。 */
  if (!uid && auth.startsWith("Bearer ")) {
    const sbU = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { authorization: auth } } },
    );
    const { data: ud, error: ue } = await sbU.auth.getUser();
    if (!ue && ud && ud.user) { uid = ud.user.id; via = "GoTrue"; }
  }

  if (!uid) {
    /* 报错必须区分两条路各自的结果 ——
       只说"登录态无效"的话，部署者无从判断
       是令牌类型不对、还是 SQL 没跑、还是函数不存在。 */
    const detail = xSession
      ? "已尝试自建会话与 GoTrue 两种令牌，都没能通过。" +
        "若系统用的是自建会话，请确认已执行 code/supabase/oj_who.sql"
      : "请求里没有带身份（既无 x-session 也无 authorization）";
    return json({ ok: false, error: "登录态无效，请重新登录。" + detail }, 401);
  }

  /* ---------- 限流 ----------
     不限制的话，一个账号就能把配额和出口 IP 一起打没。
     判据交给数据库（函数内按 uid 统计），Edge Function 无状态，
     多实例各自计数会各算各的 —— 那是假限流。 */
  /* ⚠ 显式传 uid，不再让函数内部自己取身份。
     Edge Function 不经过 PostgREST，GUC 是空的，
     函数内部调 auth_require() 必然抛异常 → 500"限流检查失败"，
     而真实原因是身份体系错配，报错完全指不到那儿。 */
  /* ⚠ 必须把令牌一起传过去（红队 R7-01）。
     限流函数对 anon 开放是因为**oj-proxy 自己就是 anon 客户端** ——
     收回授权会让这里直接 500，代提交整体挂掉。
     所以边界挪进函数内部：由它校验"令牌换出的 uid == 要计数的 uid"。
     这里什么都不传的话，函数拿不到身份 → 返回 false →
     所有人的提交都被限死，而且报错是"提交太频繁"，
     完全指不到"少了 p_token"。 */
  const { data: allowed, error: re } = await sb.rpc("code_oj_rate_allow", {
    p_token: xSession || null,
    p_uid: uid,
    p_budget: 30,        // 每窗口最多 30 次
    p_window: "1 hour",
  });
  if (re) return json({ ok: false, error: "限流检查失败：" + String(re.message).slice(0, 120) }, 500);
  if (allowed !== true) {
    return json({
      ok: false,
      error: "提交太频繁了，请稍后再试。限制是为了不牵连其他人的代提交。",
    }, 429);
  }

  /* ---------- pid 白名单（V-02） ---------- */
  if (!validPid(a.pid)) {
    return json({
      ok: false,
      error: "题号格式不对（应为数字加可选字母，如 4A、2000B）",
    }, 400);
  }

  try {
    /* ⚠ 全程不落库、不打日志。
       一旦这里写了 console.log(a.cred)，凭据就会进 Supabase 日志 ——
       那就等于我们持有它了。所以下面这行注释本身就是一条规则。 */
    const r = await PROVIDERS[a.oj](a);
    return json(r);
  } catch (e) {
    /* 错误里绝不能回显凭据 */
    const msg = String(e?.message || e);
    return json({ ok: false, error: msg.slice(0, 300) }, 502);
  }
});
