-- ============================================================
-- 排期管理平台 - Supabase Schema Migration
-- 说明：建 profiles / projects 表 + 自动建档触发器 + is_admin 函数 + RLS 权限
-- 执行方式：supabase MCP / psql 直接执行本文件（幂等）
-- ============================================================

-- ---------- 1. profiles 表（用户扩展信息，一行对应用户） ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role        text not null default 'user' check (role in ('user','admin')),
  created_at  timestamptz not null default now()
);

-- 触发器：auth.users 新增用户时自动创建 profile（display_name 取注册时传入的元数据，缺省用邮箱前缀）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'displayName', split_part(new.email, '@', 1), ''),
    'user'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 2. is_admin() 函数 ----------
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------- 3. projects 表（项目元数据 + plan 排期 jsonb） ----------
create table if not exists public.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  plan       jsonb not null default '{}'::jsonb
);

-- 更新时间自动维护
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch_updated on public.projects;
create trigger projects_touch_updated
  before update on public.projects
  for each row execute function public.touch_updated_at();

-- ---------- 4. 启用 RLS ----------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;

-- profiles policies
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update to authenticated using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete to authenticated using (public.is_admin());

-- projects policies
drop policy if exists "projects_select" on public.projects;
create policy "projects_select" on public.projects
  for select to authenticated using (true);

drop policy if exists "projects_insert" on public.projects;
create policy "projects_insert" on public.projects
  for insert to authenticated with check (auth.uid() = created_by and auth.uid() = owner_id);

drop policy if exists "projects_update" on public.projects;
create policy "projects_update" on public.projects
  for update to authenticated using (auth.uid() = owner_id or public.is_admin());

drop policy if exists "projects_delete" on public.projects;
create policy "projects_delete" on public.projects
  for delete to authenticated using (public.is_admin());

-- ============================================================
-- 5. 用户与权限（2026-09-24 设计文档 §4.1 / §3）
-- ============================================================

-- ---------- 5.1 profiles.resource_name ----------
-- 该账号在任务 res / 需求 owner 里对应的人名。
--
-- ⚠️ 安全口径：默认必须 NULL，绝不自动取 display_name。
-- 注册时的 displayName 是用户在注册表单里自己填的；若自动继承，
-- 注册时姓名填「张三」即当场获得张三名下全部任务的编辑权。
-- 因此：不回填、handle_new_user 不写、只有管理员能写。
alter table public.profiles add column if not exists resource_name text;

-- ---------- 5.2 敏感字段守卫（UPDATE 与 INSERT 两条路都要堵） ----------
--
-- 修 UPDATE 路径的既有漏洞：profiles_update 策略只写了 using、没写 with check，
-- using 只回答"哪些行你能改"、不限制能改哪一列。于是任何登录用户都能：
--   PATCH /rest/v1/profiles?id=eq.<自己>  { "role": "admin" }
--   PATCH /rest/v1/profiles?id=eq.<自己>  { "resource_name": "张三" }
--
-- 同时堵 INSERT 路径：profiles_insert 策略是 with check (auth.uid() = id)，
-- 只限定了"只能插自己那行"，没限定字段。所以当自己的 profile 行不存在时
-- （管理员删过 / 异常），可以直接 INSERT 一行把 role 写成 'admin'。
-- 同一个触发器一并挡住 —— 两条路径是同一类问题。
--
-- 必须用触发器而不是 RLS 的 with check：UPDATE 的 with check 无法引用 OLD，
-- 在策略里查同表还会有可见性 / 竞态问题。
create or replace function public.guard_profile_sensitive()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- 新行一律按最小权限落地：非管理员不能给自己写 role / resource_name
    if not public.is_admin() then
      new.role := 'user';
      new.resource_name := null;
    end if;
  else
    if (new.role is distinct from old.role
        or new.resource_name is distinct from old.resource_name)
       and not public.is_admin() then
      raise exception '仅管理员可修改角色与对应人员' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_sensitive on public.profiles;
create trigger profiles_guard_sensitive
  before insert or update on public.profiles
  for each row execute function public.guard_profile_sensitive();

-- ---------- 5.2b 回填：anon 只读项目策略 ----------
-- 漂移修正：线上有、仓库文件没有（独立迁移 20260910021121 anon_readonly_projects 从未回填）。
-- 内容与线上完全一致，因此对线上是幂等重写；补上后本文件才能从零重建出当前库。
drop policy if exists "projects_select_anon" on public.projects;
create policy "projects_select_anon" on public.projects
  for select to anon using (true);

-- ---------- 5.3 保存校验的辅助函数 ----------

-- 任务条的"业务内容"：剔除两个运行期字段
--   mod  —— collect() 写回，随需求改名而变；不剔除会让"改名"被误判成"批量修改任务"
--   isMs —— collect() 写回，由有无 m 键即可推出
create or replace function public.bar_norm(p_bar jsonb)
returns jsonb language sql immutable as $$
  select p_bar - 'mod' - 'isMs';
$$;

-- 需求 bars 的归一化数组（带序，保证比较稳定）
create or replace function public.bars_norm(p_mod jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(public.bar_norm(b) order by i), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_mod->'bars','[]'::jsonb)) with ordinality t(b, i);
$$;

-- 把 plan 展开成 (需求名, 需求归属, 任务键, 任务内容) 的行集。
-- 任务键：优先 bar.id；老数据的里程碑可能还没落 id，用 需求名||'#ms'||序号 兜底
create or replace function public.plan_tasks(p_plan jsonb)
returns table(mod text, mowner text, tkey text, bar jsonb)
language sql immutable as $$
  select m->>'name',
         m->>'owner',
         coalesce(b->>'id', (m->>'name') || '#ms' || i::text),
         public.bar_norm(b)
    from jsonb_array_elements(coalesce(p_plan->'modules','[]'::jsonb)) m,
         jsonb_array_elements(coalesce(m->'bars','[]'::jsonb)) with ordinality t(b, i);
$$;

-- 「上线」里程碑：口径与前端 core/versions.js:100 的 isGoMs 完全一致
create or replace function public.is_go_ms(p_bar jsonb)
returns boolean language sql immutable as $$
  select (p_bar ? 'm')
     and ((p_bar->>'p') = 'go' or coalesce(p_bar->>'label','') like '%上线%');
$$;

-- 任务归我：res 为空数组 = 未分配 = 待认领（谁都能改）；res 不存在 = 里程碑（不算归我）。
-- 没配人名的人不认任何任务（与前端 resolveAccess 把它降级为 readonly 一致）
create or replace function public.bar_owned(p_bar jsonb, p_rname text)
returns boolean language sql immutable as $$
  select case
    when p_rname is null or btrim(p_rname) = '' then false
    when not (p_bar ? 'res') then false
    when jsonb_array_length(p_bar->'res') = 0 then true
    else exists (select 1 from jsonb_array_elements_text(p_bar->'res') e where e = p_rname)
  end;
$$;

-- 除 manual 外其他内容都没变（用于"级联钉住"特许）
create or replace function public.only_manual_changed(p_old jsonb, p_new jsonb)
returns boolean language sql immutable as $$
  select (p_old - 'manual') = (p_new - 'manual');
$$;

-- ---------- 5.4 协作者写盘的逐项校验 ----------
-- 规则与前端 src/utils/permission.js 逐条对应；改动必须两处同步。
-- 纯校验：只 raise、不写库，便于单独构造用例验证。
create or replace function public.assert_plan_editable(p_old jsonb, p_new jsonb, p_rname text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  r             record;
  v_ver_changed boolean;
  v_pin_ok      text[];
  v_moved       text[];
begin
  -- (1) 项目周期（start/end）刻意**不校验** —— 它是派生数据，不是用户动作。
  --   cycle.apply() 每次保存都按任务日期重算 start=min(s,m) / end=max(e,m) 并写回 state
  --   （src/scheduler/cycle.js:18-44；由 scheduler/index.js:88 的 ctx.save 调用，
  --    加载时 plan-sync.js:48 也会重算一次）。UI 里已无「周期」入口。
  --   若在这里要求 start/end 不可变，协作者改一次期就会被自己引发的派生写入拒掉 —— 功能直接不可用。
  --   残留风险（已接受）：协作者可伪造成假值，但下次加载即被任务日期覆盖，
  --   仅影响 hero 副标题的一行显示，无实质影响。

  -- (2) 资源库整体不可变
  if coalesce(p_old->'resources','[]'::jsonb) is distinct from coalesce(p_new->'resources','[]'::jsonb) then
    raise exception '无权修改资源库' using errcode = '42501';
  end if;

  -- (3) 需求不可删除、不可改名；两者都只要求归属权。
  --     改名识别依据（设计文档 §5.4）：new 里存在一个"新增"需求，其 bars（归一化后）
  --     与被删需求深度相等 —— 改名只动 name / bars[].mod / versions[].mods，不碰任务本身。
  --     识别不出来时按"删除"处理，错误信息也就能指对方向。
  for r in
    select o as mod
      from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) o
     where not exists (
             select 1 from jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) n
              where (n->>'name') = (o->>'name'))
  loop
    if (r.mod->>'owner') is distinct from p_rname then
      if exists (
        select 1 from jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) n
         where public.bars_norm(n) = public.bars_norm(r.mod)
           and not exists (
             select 1 from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) o2
              where (o2->>'name') = (n->>'name'))
      ) then
        raise exception '无权重命名需求「%」：该需求不是你创建的',
          coalesce(r.mod->>'name','?') using errcode = '42501';
      else
        raise exception '无权删除需求「%」：该需求不是你创建的',
          coalesce(r.mod->>'name','?') using errcode = '42501';
      end if;
    end if;
  end loop;

  -- (4) 需求的归属级字段（archived / owner）：只归需求创建人
  for r in
    select o as omod
      from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) o
      join jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) n
        on (n->>'name') = (o->>'name')
     where (o->>'archived') is distinct from (n->>'archived')
        or (o->>'owner')    is distinct from (n->>'owner')
  loop
    if (r.omod->>'owner') is distinct from p_rname then
      raise exception '无权归档或转交需求「%」：该需求不是你创建的',
        coalesce(r.omod->>'name','?') using errcode = '42501';
    end if;
  end loop;

  -- (5) 版本不可删除（按 id 匹配）
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_old->'versions','[]'::jsonb)) o
     where not exists (
             select 1 from jsonb_array_elements(coalesce(p_new->'versions','[]'::jsonb)) n
              where (n->>'id') = (o->>'id'))
  ) then
    raise exception '无权删除版本' using errcode = '42501';
  end if;

  -- (6) 特许集合：本次允许写「上线」里程碑的需求名（设计文档 §6.4 特许②③）
  v_ver_changed := coalesce(p_old->'versions','[]'::jsonb)
                   is distinct from coalesce(p_new->'versions','[]'::jsonb);

  select coalesce(array_agg(distinct nm), '{}'::text[]) into v_pin_ok
    from (
      -- 特许②：版本数据本次有变化 → 放行"新版本成员"的上线里程碑
      select m as nm
        from jsonb_array_elements(coalesce(p_new->'versions','[]'::jsonb)) v,
             jsonb_array_elements_text(coalesce(v->'mods','[]'::jsonb)) m
       where v_ver_changed
      union
      -- 特许③：本次由"待排期"转为"已排期" → 放行该需求的上线里程碑
      select n->>'name'
        from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) o
        join jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) n
          on (n->>'name') = (o->>'name')
       where coalesce((o->>'unscheduled')::boolean, false)
         and not coalesce((n->>'unscheduled')::boolean, false)
    ) t;

  -- (7) 我真正移动过的任务（有归属权 + s/e/m 有变化）→ 级联依据（设计文档 §6.3.1）
  select coalesce(array_agg(o.tkey), '{}'::text[]) into v_moved
    from public.plan_tasks(p_old) o
    join public.plan_tasks(p_new) n on n.tkey = o.tkey
   where o.bar <> n.bar
     and ((o.bar->>'s') is distinct from (n.bar->>'s')
       or (o.bar->>'e') is distinct from (n.bar->>'e')
       or (o.bar->>'m') is distinct from (n.bar->>'m'))
     and public.bar_owned(o.bar, p_rname);

  -- (8) 任务级 diff：新增 / 删除 / 修改三条规则
  for r in
    select o.tkey as okey, o.bar as obar, o.mod as omod, o.mowner as omowner,
           n.bar as nbar, n.mod as nmod
      from public.plan_tasks(p_old) o
      full outer join public.plan_tasks(p_new) n on n.tkey = o.tkey
     where o.tkey is null or n.tkey is null or o.bar <> n.bar
  loop
    -- 新增
    if r.okey is null then
      if not (
        -- 整个需求是本次新建的（新需求自带的阶段任务与里程碑一起放行）
        not exists (select 1 from jsonb_array_elements(coalesce(p_old->'modules','[]'::jsonb)) m
                     where (m->>'name') = r.nmod)
        or public.bar_owned(r.nbar, p_rname)
        or (public.is_go_ms(r.nbar) and r.nmod = any(v_pin_ok))
      ) then
        raise exception '无权在需求「%」下新增任务', coalesce(r.nmod,'?') using errcode = '42501';
      end if;
      continue;
    end if;

    -- 删除
    if r.nbar is null then
      if not public.bar_owned(r.obar, p_rname) then
        -- 例外（决策 §1.1-13「需求创建人有该需求所有权限」的必然结果）：
        --   整条需求是我创建的、且本次被删掉了 → 连带删除里面的他人任务**放行**。
        --   这不是漏拦：spec §13 明确写了兜底方式是"前端删除确认弹窗必须列出
        --   「将同时删除 N 条他人负责的任务」"，而不是服务端拦下来。
        --   判据用 old 的 mod 归属：plan_tasks 已经把 mowner 带出来了。
        --   滥用面已评估为零：他无法把别人的任务移进自己的需求（改 t.mod 属于改他人任务，被拦），
        --   所以只可能删掉"别人主动排进他需求里"的任务。
        if not (
          r.omowner = p_rname
          and not exists (
            select 1 from jsonb_array_elements(coalesce(p_new->'modules','[]'::jsonb)) m
             where (m->>'name') = r.omod)
        ) then
          raise exception '无权删除他人负责的任务（id=%）',
            coalesce(r.obar->>'id','?') using errcode = '42501';
        end if;
      end if;
      continue;
    end if;

    -- 修改：归我的直接放行
    if public.bar_owned(r.obar, p_rname) then continue; end if;

    -- 里程碑：跟需求归属走；「上线」里程碑可由版本机制 / 待排期联动特许（§6.4）
    if r.obar ? 'm' then
      if public.is_go_ms(r.obar) and r.omod = any(v_pin_ok) then continue; end if;
      if (r.omowner is not null and r.omowner = p_rname) then continue; end if;
      raise exception '无权修改他人需求的里程碑（% / %）',
        coalesce(r.omod,'?'), coalesce(r.obar->>'label','?') using errcode = '42501';
    end if;

    -- 普通任务：仅允许"级联钉住" —— manual 由 false 改 true，且内容只变了 manual，
    -- 且该任务的直接前置里有"被我本次移动过"的任务（§6.4 特许①）
    if coalesce((r.obar->>'manual')::boolean, false) is false
       and coalesce((r.nbar->>'manual')::boolean, false) is true
       and public.only_manual_changed(r.obar, r.nbar)
       and exists (
         select 1 from jsonb_array_elements(coalesce(r.obar->'dep','[]'::jsonb)) d
          where (d->>'id') = any(v_moved)
       ) then
      continue;
    end if;

    raise exception '无权修改他人负责的任务（id=%）',
      coalesce(r.obar->>'id','?') using errcode = '42501';
  end loop;
end;
$$;

-- ---------- 5.5 计划保存的唯一入口 ----------
-- 背景：RLS 的 projects_update 只放行 owner/admin（策略一字不改），
-- 协作者直接 PATCH projects 会被拒。协作者改自己任务的唯一通道就是本函数。
-- SECURITY DEFINER 绕过 RLS，但身份与规则由函数内部判定。
-- updated_at 由既有的 projects_touch_updated 触发器维护，这里不写。
create or replace function public.save_plan(p_project_id uuid, p_plan jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_old   jsonb;
  v_role  text;
  v_rname text;
begin
  if v_uid is null then
    raise exception '未登录，无法保存' using errcode = '42501';
  end if;

  select owner_id, plan into v_owner, v_old
    from public.projects where id = p_project_id;
  if not found then
    raise exception '项目不存在' using errcode = 'P0002';
  end if;

  select role, resource_name into v_role, v_rname
    from public.profiles where id = v_uid;

  -- 快路径：所属人 / 管理员整份替换（行为与改造前的直接 PATCH 完全一致）
  if coalesce(v_role, 'user') = 'admin' or v_owner = v_uid then
    update public.projects set plan = p_plan where id = p_project_id;
    return jsonb_build_object('ok', true);
  end if;

  -- 协作者：必须配了"对应人员"，否则一律拒绝（设计文档 §4.1 的安全口径）
  if v_rname is null or btrim(v_rname) = '' then
    raise exception '账号未指定对应人员，无法保存（请联系管理员）' using errcode = '42501';
  end if;

  perform public.assert_plan_editable(
    coalesce(v_old, '{}'::jsonb),
    coalesce(p_plan, '{}'::jsonb),
    btrim(v_rname)
  );

  update public.projects set plan = p_plan where id = p_project_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- 只给登录用户可执行（游客本来就只读，不需要）
revoke all on function public.save_plan(uuid, jsonb) from public;
grant execute on function public.save_plan(uuid, jsonb) to authenticated;
