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
