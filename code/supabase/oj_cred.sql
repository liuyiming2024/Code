-- ============================================================
-- OJ 代提交凭据：服务端存储档
-- ------------------------------------------------------------
-- 三档开关里的「存服务端」这一档。另外两档不需要这里：
--   · 存本地 —— 加密后在浏览器 IndexedDB/localStorage，不经过我们
--   · 不存   —— 每次手填，什么都不留
--
-- ---------- 为什么这一档必须加密后再落盘 ----------
-- 明文凭证躺在库里，一次拖库就全没了。
-- 所以落盘的是**密文**，密钥放在 Edge Function 的环境变量里
-- （Supabase Secrets），**不在数据库里**。
-- 于是：数据库被拖走 → 拿到的只是一堆密文。
--
-- ---------- 必须如实写清的上限 ----------
-- 这不等于"我们拿不到"：服务端本身能解密（密钥在它的环境里）。
-- 所以这一档的承诺只能是：
--   「拖库拿不到明文」—— 真
--   「我们拿不到明文」—— 假，不能这么说
-- 想要后者就选「存本地」，那档密钥是浏览器生成的、不可导出。
-- 这个区别在界面上必须写清楚，不能让用户误以为三档一样安全。
-- ============================================================

create table if not exists public.oj_cred (
  user_id   uuid not null,
  oj        text not null,
  cred_enc  text not null,          -- 密文（enc1:<iv>:<ct>），绝不明文
  updated_at timestamptz not null default now(),
  primary key (user_id, oj)
);

-- 第一层：跟云盘同一个思路，表级权限全部撤掉
revoke all on public.oj_cred from anon, authenticated;

-- 第二层：RLS。启用 + 不建 policy = 最严（谁都读不到），
-- 函数因为是 security definer 才绕得过去。
alter table public.oj_cred enable row level security;

-- ---------- 访问口子：只给函数 ----------
create or replace function public.code_oj_cred_get(p_oj text)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid uuid;
begin
  uid := public.auth_require();          -- 统一门禁，跟云盘一致
  perform public.code_gate_require();    -- 闸门
  if p_oj is null or p_oj = '' then return null; end if;
  return (select cred_enc from public.oj_cred
          where user_id = uid and oj = p_oj);
end;
$$;

create or replace function public.code_oj_cred_save(p_oj text, p_enc text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid uuid;
begin
  uid := public.auth_require();
  perform public.code_gate_require();
  if p_oj is null or p_oj = '' then
    raise exception '缺少平台名';
  end if;
  /* 空密文 = 用户要删掉这条凭据 */
  if p_enc is null or p_enc = '' then
    delete from public.oj_cred where user_id = uid and oj = p_oj;
    return;
  end if;
  /* 只认密文。传明文上来一律拒绝 ——
     否则"客户端没加密"这个 bug 会静默变成"库里存明文"，
     而界面上还写着"已加密存储"。 */
  if p_enc not like 'enc1:%' then
    raise exception '只接受加密后的凭据';
  end if;
  insert into public.oj_cred(user_id, oj, cred_enc, updated_at)
  values (uid, p_oj, p_enc, now())
  on conflict (user_id, oj)
  do update set cred_enc = excluded.cred_enc, updated_at = now();
end;
$$;

revoke all on function public.code_oj_cred_get(text) from public;
revoke all on function public.code_oj_cred_save(text, text) from public;
grant execute on function public.code_oj_cred_get(text) to authenticated;
grant execute on function public.code_oj_cred_save(text, text) to authenticated;

-- ---------------- 验证 ----------------
-- select relname, relrowsecurity from pg_class c
--   join pg_namespace n on n.oid=c.relnamespace
--   where n.nspname='public' and relname='oj_cred';   -- 应为 true
-- select privilege_type from information_schema.role_table_grants
--   where grantee='anon' and table_name='oj_cred';    -- 应为空
