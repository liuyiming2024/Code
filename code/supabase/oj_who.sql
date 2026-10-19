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
-- 限流：显式接收 uid  —— 经红队 R7-01 复核后改为**函数内自校验**
-- ------------------------------------------------------------
-- 【第一版为什么是洞】
--   第一版签名为 (p_uid, p_budget, p_window)，
--   为了让 Edge Function 能调（它是 anon 客户端），grant 给了 anon。
--   于是三个属性叠加：
--     1. anon 可调用，不需要任何身份
--     2. p_uid 由调用方传入 → **可以是任何人的 uid**
--     3. 两条分支都 insert → **每次调用必写一行，无上限**
--   后果一：定点配额耗尽 —— 匿名调 31 次别人的 uid，
--           受害者一小时预算清零，代提交全返 429。
--   后果二：写放大 —— 匿名无限调用，表只增不减
--           （清理语句当时只有一行注释，没有任何调度引用它）。
--
-- 【为什么不能按建议直接"收回 anon 授权"】
--   红队建议把 `to anon` 拿掉。但 **oj-proxy 本身就是 anon 客户端**
--   （它用 ANON_KEY 建 client，因为要靠 code_oj_who 换身份）。
--   收回授权 → oj-proxy 调它 → 权限不足 → 返回 500"限流检查失败"
--   → **代提交整体挂掉**。修一个洞把功能弄没，不是修。
--
--   而且当时那句自评"配额不是安全边界"也只对了一半：
--   配额确实不是安全边界，但**存储是**。
--   判断错在把两件事当成了同一件。
--
-- 【实际修法：授权留在 anon，边界移到函数内部】
--   "能不能调" 和 "调了能干什么" 是两件事：
--     前者必须给 anon，否则功能不存在；
--     后者必须自己校验 —— 调用方要**证明** p_uid 是自己的。
--   证明方式两条，与 oj-proxy 的双路身份一一对应：
--     · p_token 非空 → GUC + cur_user()（自建会话）
--     · p_token 为空 → auth_require()（PostgREST / GoTrue）
--   两条都拿不到、或拿到的 ≠ p_uid → 直接 return false，**且不写库**。
--
--   ⚠ "不写库"是关键：校验失败就不能落账。
--     只做身份校验而仍然记账的话，配额耗尽被堵住了，
--     写放大还在 —— 两件事必须一起解决。
-- ============================================================

create or replace function public.code_oj_rate_allow(
  p_token  text,
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
  v_uid  uuid := null;
  n      int;
  v_rows bigint;
begin
  /* 第一道：uid 不能为空。
     "调用方没能确定身份"必须拒绝，不能退化成不限流。 */
  if p_uid is null then
    return false;
  end if;

  /* ---------- 第二道：证明 p_uid 是自己的 ---------- */

  /* 路一：自建会话令牌（Edge Function 走这条） */
  if p_token is not null and length(p_token) >= 8 then
    perform set_config(
      'request.headers',
      json_build_object('x-session', p_token)::text,
      true
    );
    begin
      execute 'select public.cur_user()' into v_uid;
    exception when others then
      v_uid := null;      /* 令牌无效是正常情况，不能冒泡成 500 */
    end;
  end if;

  /* 路二：GoTrue / PostgREST（JWT 由 PostgREST 解析后注入） */
  if v_uid is null then
    begin
      v_uid := public.auth_require();
    exception when others then
      v_uid := null;
    end;
  end if;

  /* ⚠ 拿不到身份、或与 p_uid 不符 → 拒绝，且不写库。
     这一步同时堵掉定点耗尽与匿名写放大。 */
  if v_uid is null or v_uid <> p_uid then
    return false;
  end if;

  if p_budget is null or p_budget < 1 then p_budget := 30; end if;
  if p_window is null then p_window := interval '1 hour'; end if;

  /* ---------- 全局守卫：表不能无限膨胀 ----------
     即便每个攻击者只用自己的 uid，注册大量账号仍能撑大表。
     这里用 pg_class.reltuples 做**近似**计数（不扫全表）——
     用 count(*) 的话表一大，这个函数自己就变慢了。
     超上限就拒绝记账：宁可让限流"卡住"，也不能把库写爆。 */
  select c.reltuples::bigint into v_rows
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'oj_submit_log';
  if coalesce(v_rows, 0) > 200000 then
    return false;
  end if;

  select count(*) into n
    from public.oj_submit_log
   where user_id = p_uid
     and created_at > now() - p_window;

  if n >= p_budget then
    /* ⚠ 超限必须**更新已有行**，绝不能再 insert。
       旧实现"超限也记一笔"的本意是防止"每次都算第一次"，
       但它同时也是写放大的推手 —— 匿名刷 100 万次就多 100 万行。
       改成把**最老那行**的 created_at 推到当前时刻：
         · 那行仍在窗口内 → 后续仍判超限（防"每次都第一次"的效果不变）
         · 行数不增长（写放大被堵住） */
    update public.oj_submit_log
       set created_at = now()
     where id = (
       select id from public.oj_submit_log
        where user_id = p_uid
        order by created_at asc
        limit 1
     );
    return false;
  end if;

  insert into public.oj_submit_log(user_id) values(p_uid);
  return true;
end;
$$;

revoke all on function public.code_oj_rate_allow(text, uuid, int, interval) from public;
grant execute on function public.code_oj_rate_allow(text, uuid, int, interval) to anon, authenticated;

-- ------------------------------------------------------------
-- 兼容旧签名 (uuid, int, interval)
-- ------------------------------------------------------------
-- 保留是为了不打断已在调它的东西，但**语义变了**：
-- 它传 p_token := null，只能走 auth_require()，
-- 而那条路在 Edge Function 里必然拿不到身份 → 返回 false。
-- 也就是说这个签名现在**只有 PostgREST 路径能正确使用**，
-- 匿名直调既拿不到 true，也写不进任何一行 ——
-- 这正是 R7-01 要的结果：保留兼容性的同时把洞堵上。
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
begin
  return public.code_oj_rate_allow(null, p_uid, p_budget, p_window);
end;
$$;

revoke all on function public.code_oj_rate_allow(uuid, int, interval) from public;
grant execute on function public.code_oj_rate_allow(uuid, int, interval) to anon, authenticated;

-- ============================================================
-- 清理：必须真的跑起来，不能只留注释
-- ------------------------------------------------------------
-- 红队说得对：清理原本只有一行注释，全库没有任何调度引用它。
-- 下面两条**任选其一执行**（Supabase 默认未启用 pg_cron）。
--
-- 方式一（推荐）：每小时清一次 7 天前的数据
--
--   create extension if not exists pg_cron;
--   select cron.schedule(
--     'oj_submit_log_cleanup',
--     '17 * * * *',
--     $$delete from public.oj_submit_log where created_at < now() - interval '7 days'$$
--   );
--
-- 方式二：没开 pg_cron 的话手动清
--
--   delete from public.oj_submit_log where created_at < now() - interval '7 days';
--
-- ⚠ 上面的全局守卫（20 万行）是**兜底**，不是清理的替代品。
--   两者都要：守卫挡突发写爆，清理让水位长期回落。
-- ============================================================
