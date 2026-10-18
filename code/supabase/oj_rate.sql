-- ============================================================
-- 代提交限流（红队 V-01 的配套）
-- ------------------------------------------------------------
-- 为什么必须服务端限流：
--   刷量触发 CF 风控 → 封的是**出口 IP** →
--   **所有人的代提交一起失效**，不是只影响刷的那个人。
--   所以这不是"防止滥用"这种软目标，是保护共享资源。
--
-- ---------- 为什么计数必须在数据库里 ----------
--   Edge Function 是**无状态、多实例**的。
--   在内存里计数的话，每个实例各算各的，
--   实际放行量 = 实例数 × 限额 —— 那是**假限流**。
--   判据放在数据库里才是全局一致的。
-- ============================================================

create table if not exists public.oj_submit_log (
  id         bigserial primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists oj_submit_log_uid_time
  on public.oj_submit_log(user_id, created_at desc);

revoke all on public.oj_submit_log from anon, authenticated;
alter table public.oj_submit_log enable row level security;

/* 判据与记账分开，两个都要：
   合在一个函数里的话，被限流时**不记账**，
   于是持续刷的请求每次都"第一次"，限流形同虚设。 */
create or replace function public.code_oj_rate_allow(p_budget int, p_window interval)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid uuid;
  n   int;
begin
  uid := public.auth_require();
  perform public.code_gate_require();

  if p_budget is null or p_budget < 1 then p_budget := 30; end if;
  if p_window is null then p_window := interval '1 hour'; end if;

  select count(*) into n
    from public.oj_submit_log
   where user_id = uid
     and created_at > now() - p_window;

  if n >= p_budget then
    /* 超限也记一笔 —— 见上面注释 */
    insert into public.oj_submit_log(user_id) values (uid);
    return false;
  end if;

  insert into public.oj_submit_log(user_id) values (uid);
  return true;
end;
$$;

revoke all on function public.code_oj_rate_allow(int, interval) from public;
grant execute on function public.code_oj_rate_allow(int, interval) to authenticated;

/* ---------- 清理：日志不需要长期留 ----------
   留太久没意义，还占空间。定期删 7 天前的。 */
-- delete from public.oj_submit_log where created_at < now() - interval '7 days';
