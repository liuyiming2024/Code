/* ============================================================
   OJ 凭据：服务端档的存取
   ------------------------------------------------------------
   浏览器**不参与**这里的加解密 —— 密钥在环境变量（Supabase Secrets）里，
   随页面下发的话就等于没加密。所以流程是：

     保存：前端发明文 → 这里加密 → 密文进库
     读取：这里取密文 → 解密 → 明文回前端（填回输入框）

   ---------- 这一档到底承诺什么 ----------
     ✅ 拖库拿不到明文 —— 库里只有密文，密钥不在库里
     ❌ 我们拿不到明文 —— 服务端当然能解密，不能这么承诺

   想要后者的用户请选「存本机」，那档密钥是浏览器生成的、**不可导出**。
   这个区别在界面上直说，不包装。

   ---------- 密钥从哪来 ----------
   环境变量 OJ_CRED_KEY（base64，32 字节）。
   **没配就不能用**，明确报错，绝不退回明文存储 ——
   静默存明文 = 用户以为加密了其实没有，那比不做加密更糟。
   ============================================================ */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* ---------- 密钥 ---------- */
async function key(): Promise<CryptoKey> {
  const raw = Deno.env.get("OJ_CRED_KEY");
  if (!raw) throw new Error("KEY_NOT_CONFIGURED");
  const bin = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bin.length !== 32) throw new Error("KEY_BAD_LENGTH");
  return crypto.subtle.importKey("raw", bin, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const enc = new TextEncoder(), dec = new TextDecoder();
const b64e = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // IV 每次随机，绝不复用
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), enc.encode(plain));
  return `enc1:${b64e(iv)}:${b64e(new Uint8Array(ct))}`;
}

async function decrypt(blob: string): Promise<string> {
  if (blob.indexOf("enc1:") !== 0) throw new Error("NOT_CIPHERTEXT");
  const p = blob.split(":");
  if (p.length !== 3) throw new Error("BAD_FORMAT");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(p[1]) }, await key(), b64d(p[2]));
  return dec.decode(pt);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "只接受 POST" }, 405);

  let b: { action?: string; oj?: string; cred?: string };
  try { b = await req.json(); } catch { return json({ ok: false, error: "请求体不是合法 JSON" }, 400); }

  if (!b.oj) return json({ ok: false, error: "缺少平台名" }, 400);

  /* ⚠ 用**调用者的 token**建客户端，不是 service role。
     用 service role 的话任何人调这个函数都能读写所有人的凭据 ——
     那 RLS 就白设了。这里必须让 RLS 按调用者身份生效。 */
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ ok: false, error: "未登录" }, 401);
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { authorization: auth } } },
  );

  try {
    if (b.action === "get") {
      const { data, error } = await sb.rpc("code_oj_cred_get", { p_oj: b.oj });
      if (error) throw error;
      if (!data) return json({ ok: true, cred: "" }); // 没存过 ≠ 出错
      return json({ ok: true, cred: await decrypt(String(data)) });
    }

    if (b.action === "save") {
      if (!b.cred) {
        /* 空 = 删除。用户切到"不存"时要真删掉，不能留着 */
        const { error } = await sb.rpc("code_oj_cred_save", { p_oj: b.oj, p_enc: "" });
        if (error) throw error;
        return json({ ok: true });
      }
      const { error } = await sb.rpc("code_oj_cred_save", { p_oj: b.oj, p_enc: await encrypt(b.cred) });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ ok: false, error: "action 只能是 get 或 save" }, 400);
  } catch (e) {
    const m = String(e?.message || e);
    /* 错误回显里绝不能带凭据 */
    if (m === "KEY_NOT_CONFIGURED") {
      return json({
        ok: false,
        error: "服务端没配加密密钥，「存服务端」暂不可用。请改用「存本机」。",
      }, 503);
    }
    if (m === "KEY_BAD_LENGTH") return json({ ok: false, error: "密钥长度不对（要 32 字节）" }, 500);
    return json({ ok: false, error: m.slice(0, 200) }, 502);
  }
});
