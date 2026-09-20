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
