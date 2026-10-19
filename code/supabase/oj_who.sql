-- ============================================================
-- 代提交：用自建会话令牌换 uid
-- ------------------------------------------------------------
-- 为什么必须有这个函数：
--   本系统的真实身份是**自建 sessions**（前端 js/cloud.js 里
--   `CHAT_TOKEN_KEY='wxlg_sb_token'`，通过 `x-session` 请求头传递），
--   而不是 Supabase GoTrue。数据库侧 cur_user() 从
--   `current_setting('request.headers')` 里读 x-session ——
--   那是 **PostgREST 自动注入**的 GUC。
--
--   而 Edge Function 是 Deno 进程，**不经过 PostgREST**，
--   所以 GUC 是空的：直接调 auth_require()/cur_user() 必然拿不到身份。
--   上一版 oj-proxy 用 sb.auth.getUser() 解析 GoTrue 令牌，
--   等于在两套体系之间做了一次必然失败的翻译 ——
--   表现为合法用户带自己的有效令牌却被判"登录态无效"。
--
-- 这个函数做的事：把令牌**显式**传进来，在函数内部
-- 手动把 GUC 设成 PostgREST 会设的样子，再复用现有的 cur_user()。
-- 这样不需改动 Chat 的任何公共函数。
--
-- ---------- 为什么必须对 anon 开放 ----------
--   它就是"登录校验"接口，天生要接受未认证请求 ——
--   跟 /auth/v1/token 一个性质。
--   但开放的是**这一个函数**，不是 sessions 表：
--   表级权限依旧撤干净，函数以 definer 身份读。
--
-- ---------- 返回值 ----------
--   成功 → uuid；失败 → null（绝不抛异常、绝不回显令牌）
--   返回 null 而不是报错，是为了让调用方能继续尝试第二条路，
--   也避免把"令牌对不对"这种信息通过错误文本泄露出去。
-- ============================================================

create or replace function public.code_oj_who(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := null;
  v_has boolean := false;
begin
  if p_token is null or length(p_token) < 8 then
    return null;
  end if;

  /* 先确认 Chat 的 cur_user() 在不在 ——
     不在就别硬调，否则抛的是 "function does not exist"，
     部署者会以为是 SQL 没跑，而实际是体系不同。 */
  select exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cur_user'
  ) into v_has;

  if not v_has then
    return null;
  end if;

  /* 把 GUC 设成 PostgREST 的形状。
     ⚠ 第三个参数 true = 事务局部：函数返回后自动还原，
        不会污染同一个连接上的后续请求（连接池是复用的）。 */
  perform set_config(
    'request.headers',
    json_build_object('x-session', p_token)::text,
    true
  );

  begin
    execute 'select public.cur_user()' into v_uid;
  exception when others then
    /* cur_user() 在令牌无效时会抛（而不是返回 null）——
       那是**正常的**"令牌不对"，吞掉并返回 null，
       不能让它冒泡成 500：500 会让前端以为服务挂了。 */
    v_uid := null;
  end;

  return v_uid;
end;
$$;

revoke all on function public.code_oj_who(text) from public;
grant execute on function public.code_oj_who(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 限流：改为显式接收 uid
-- ------------------------------------------------------------
-- 原版在**函数内部**调 auth_require() 取身份。
-- Edge Function 调用时没有 PostgREST 的 GUC，
-- 于是 auth_require() 抛异常 → 整个提交以 500 失败，
-- 而报错是"限流检查失败"，完全看不出是身份体系错配。
--
-- 改成把 uid 作为参数传进来：函数不再关心"身份从哪来"，
-- 只负责按 uid 计数。调用方（oj-proxy）负责确定 uid。
-- 这样两种身份体系下它都一样工作。
--
-- ⚠ 对 anon 开放不等于可滥用：
--   它只按传入的 uid 计数，不读也不返回任何数据。
--   最坏情况是有人消耗别人的配额 —— 而配额本来就只是节流，
--   不是安全边界。真正的边界是前面的令牌校验。
-- ============================================================

create or replace function public.code_oj_rate_allow(
  p_uid    uuid,
  p_budget int      default 30,
  p_window interval default interval '1 hour'
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  n int;
begin
  /* uid 为空说明调用方没能确定身份 ——
     这是**必须拒绝**的状态，不能退化成"不限流"。 */
  if p_uid is null then
    return false;
  end if;

  if p_budget is null or p_budget < 1 then p_budget := 30; end if;
  if p_window is null then p_window := interval '1 hour'; end if;

  select count(*) into n
    from public.oj_submit_log
   where user_id = p_uid
     and created_at > now() - p_window;

  if n >= p_budget then
    /* 超限也记一笔 —— 否则持续刷的请求每次都算"第一次"，
       限流形同虚设（这条上一轮专门修过，别改回去）。 */
    insert into public.oj_submit_log(user_id) values (p_uid);
    return false;
  end if;

  insert into public.oj_submit_log(user_id) values (p_uid);
  return true;
end;
$$;

revoke all on function public.code_oj_rate_allow(uuid, int, interval) from public;
grant execute on function public.code_oj_rate_allow(uuid, int, interval) to anon, authenticated;

/* 兼容旧签名：内部取身份的那版。
   保留是为了不打断任何已经在调它的东西 ——
   但它依赖 GUC，只有 PostgREST 路径下才工作。 */
create or replace function public.code_oj_rate_allow(p_budget int, p_window interval)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return public.code_oj_rate_allow(public.auth_require(), p_budget, p_window);
end;
$$;

revoke all on function public.code_oj_rate_allow(int, interval) from public;
grant execute on function public.code_oj_rate_allow(int, interval) to authenticated;
