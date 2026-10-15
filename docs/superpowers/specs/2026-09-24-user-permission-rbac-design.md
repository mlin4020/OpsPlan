# 用户管理与项目/任务级权限设计

- 日期：2026-09-24
- 状态：设计已确认，待实施
- 载体：项目列表页（`index.html`）用户管理面板 + 排期页（`gantt.html`）全部写入口 + Supabase 服务端（`migration.sql`）
- 关联：本文件只是「用户与权限」这一半；**「跨项目工作规划」按约定拆为独立 spec，不在本次范围**
- 后端前提：`feishu-config.js` 的 `enabled` 为 `false`，实际走 **Supabase** 后端；飞书后端（Python bridge）不做服务端校验，列为非目标

---

## 1. 背景与目标

现状只有两级角色（`admin` / `user`）和**一个全局布尔** `userStore.state.readonly`（`src/main-gantt.js:220`）：进入项目时算一次 `owner_id === 我 || role === 'admin'`，不满足就整份只读。于是协作只有两档——「全部能改」或「全都不能改」。

本次交付：

1. **用户管理**：支持编辑用户（改名 + 改角色升降级），补上"对应人员"的维护入口
2. **角色与建项目**：普通用户可创建项目（服务端本就允许，缺的是 UI 入口）
3. **项目/任务级权限**：项目默认只允许所属人编辑；其他登录用户只能编辑**属于自己的任务**；需求按创建人归属细化
4. **顺带修复两处既有提权漏洞**（§3）

### 1.1 已确认的决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 拆分 | 拆两个 spec，先做「用户与权限」，跨项目规划押后 |
| 2 | 用户管理范围 | 只做**改名 + 改角色**；删除账号 / 改密码 / 真封禁不做（需 `service_role`，前端做不到） |
| 3 | 账号 ↔ 人名映射 | `profiles.resource_name`（账号上挂一个人名） |
| 4 | 任务级权限档位 | 维护自己的任务：改进度/日期/工时/依赖、新增（负责人默认自己）、删除自己的、可转交；工具栏「自动计划/撤销/重做/导入」禁用 |
| 5 | 需求权限 | 可增、可改字段、可归档；**改名/删除/归档/转交仅需求创建人（`owner`）或项目所属人/管理员** |
| 6 | 版本权限 | 除「删除版本」「一键归档本版本需求」外放开 |
| 7 | 资源库 | 仅所属人 / 管理员 |
| 8 | 级联重排 | 遇到他人任务时**断链**：把它钉成 `manual=true` + 报依赖冲突 |
| 9 | 未分配任务 | 视为「待认领」，协作者可编辑（含把负责人设为自己） |
| 10 | 权限强制层级 | **服务端真强制**（Postgres RPC 校验），不是前端约定 |
| 11 | 项目层权限 | 所属人可改名 / 换负责人；**删除项目仅管理员**（项目周期是派生数据，不在权限范围内，见 §6.3） |
| 12 | 钉住校验 | 服务端校验级联依据（该任务依赖链上确实有被移动的任务） |
| 13 | 需求归属 | 新增 `module.owner`；**需求创建人对其需求有全部权限**（含改名/删除/归档及其内里程碑） |
| 14 | 他人需求的字段级 | 可改优先级/描述/文档/提出人/生命周期/所属版本/排序；不能改名/删/归档 |
| 15 | 里程碑 | 手动编辑：跟需求归属走；版本管理触发的写入：放行 |

---

## 2. 现状与关键约束（已核实）

| 事实 | 出处 |
|---|---|
| 用户管理只有「创建账号」「设为管理员」，无改名 / 降级 / 删除 | `src/main-index.js:83-106`、`index.html:139-146` |
| 项目「管理」按钮只对 admin 显示 → **普通用户改不了自己项目的名称/负责人** | `src/main-index.js:76` |
| `projects_insert` 已允许普通用户建自己的项目 | `deploy/supabase/migration.sql:104-106` |
| 任务负责人是**人名字符串数组** `res:["张三"]` | `src/core/default-data.js:56` |
| 资源库记录只有 `{id,name,role,color}`，**无任何账号信息** | `src/core/default-data.js:42-51` |
| 里程碑 `{m,label}` **没有 `res` 字段**；普通任务被自愈补成 `res: []` | `src/core/default-data.js:62`、`src/scheduler/index.js:61` |
| 全部写操作收敛到 `sched.*`，数据层 `assertEditable()` 兜底（21 处） | `src/scheduler/mutations.js:18-22` |
| `assertEditable` 是全局布尔，**签名拿不到"在改哪个任务"** | 同上 |
| `sched.undo/redo` **没有** `assertEditable` 守卫 | `src/scheduler/index.js:95-104` |
| 级联重排会把下游**所有人的**任务一起重排 | `src/scheduler/planning.js:92-171` |
| 版本操作会连带写成员需求的**上线里程碑**（新增/改写/解锁） | `src/scheduler/mutations.js:493-523, 528-568` |
| 「一键归档本版本需求」批量改写成员需求的 `archived` | `src/scheduler/mutations.js:704-717` |
| `isGoMs(b)` = `p === 'go' \|\| label 含「上线」`（上线里程碑的唯一口径） | `src/core/versions.js:100-104` |
| 依赖违反检测已存在（"开始日 < 前置允许的最早开始"） | `src/scheduler/problems.js:45-60`，显示于 `src/views/report-view.js:17` |
| `plan-sync` 保存失败只提示、**不回滚** | `src/services/plan-sync.js:96-107` |
| 登录页有**公开自助注册**入口 | `login.html:30`、`src/main-login.js:40` |

---

## 3. 必须修复的既有漏洞（三处提权路径）

`deploy/supabase/migration.sql:91-93`：

```sql
create policy "profiles_update" on public.profiles
  for update to authenticated using (auth.uid() = id or public.is_admin());
```

只写了 `using`，没写 `with check`。`using` 只回答"哪些行你能改"，**不限制能改哪一列**。配合公开注册入口，两条路径真实可走：

```bash
# ① 任何登录用户把自己提成管理员
PATCH /rest/v1/profiles?id=eq.<自己的uuid>   { "role": "admin" }

# ② 把 resource_name 改成别人的名字，拿到其名下全部任务的编辑权
PATCH /rest/v1/profiles?id=eq.<自己的uuid>   { "resource_name": "张三" }
```

不修则 §5 的角色模型与任务级权限都能被一行 curl 绕过。修法见 §7.2（`BEFORE INSERT OR UPDATE` 触发器；RLS 的 `with check` 无法引用 `OLD`）。

### 3.1 第三条：`profiles_insert` 的同类路径（设计评审时补充发现）

```sql
create policy "profiles_insert" on public.profiles
  for insert to authenticated with check (auth.uid() = id);   -- migration.sql:87-89
```

`with check (auth.uid() = id)` 只限定了"只能插自己那一行"，**没限定字段**。所以当自己的 profile 行不存在时（管理员删过、或异常），可以直接：

```bash
POST /rest/v1/profiles   { "id": "<自己>", "role": "admin", "resource_name": "张三" }
```

只堵 `UPDATE` 是漏的——同一个触发器必须同时覆盖 `INSERT`（§7.2）。

---

## 4. 数据模型变更

### 4.1 `profiles.resource_name`（新列，不回填）

| 字段 | 类型 | 语义 | 默认 |
|---|---|---|---|
| `resource_name` | `text` | 该账号在任务 `res` / 需求 `owner` 里对应的人名 | **`NULL`** |

**安全口径：默认必须 `NULL`，只有管理员能写，绝不自动取 `display_name`。**

注册时的 `displayName` 是用户在注册表单里自己填的（`src/services/backends/supabase.js:56`）。若自动继承，注册时姓名填「张三」即当场获得张三名下全部任务的编辑权。因此：

- 新列默认 `NULL`；`handle_new_user()` 触发器**不写**该字段
- 只有「用户管理」页（管理员）能设置
- 用户管理页**显式标出"未指定人员"的账号**（漏配发现机制）
- **迁移不回填**：现有账号先全部降为只读，由管理员逐个指定
- 编辑弹窗预填 `display_name` 只是输入框的便利，需管理员点保存才生效

### 4.2 `module.owner`（需求归属人，存 plan jsonb，无需 DDL）

| 字段 | 类型 | 语义 | 缺省 |
|---|---|---|---|
| `owner` | `string` | 需求创建人的人名（与任务 `res` 同一命名空间） | `undefined` = 无主 |

- `addModule()` 写入 `owner = 当前用户的人名`（`mutations.js` 已能读到 `userStore`）
- 老数据缺失 → **无主**，归属级操作仅项目所属人 / 管理员；**不臆造归属**（与既有"不补假值"原则一致）
- **不复用 `proposedBy`**：那是需求来源（业务方、自由文本，`src/main-gantt.js:22` 还回填了常量 `'郑致远'`），语义不同

### 4.3 无需改动

`projects.plan` 是 jsonb，`module.owner` 随现有展开写法自动同步到 Supabase / localStorage / 导出件 / 撤销快照（`persistence.js`、`plan-sync.js`、`export.js` 均为展开写法）。

---

## 5. 身份与判定模型

### 5.1 四种身份

| 身份 | 判定（服务端） | 说明 |
|---|---|---|
| **管理员** | `profiles.role = 'admin'` | 全系统最高 |
| **所属人** | `projects.owner_id = auth.uid()` | 单项目最高，唯一例外是「删除项目」 |
| **协作者** | 已登录 **且** `profiles.resource_name` 非空（非本项目 owner/admin） | 按任务 / 需求归属细化 |
| **只读** | 其余：游客（anon）、**登录了但没配 `resource_name`** | 全文只读 |

**刻意的收紧**：没配 `resource_name` 的登录用户是**纯只读**。因为存在公开注册入口，若"没配人名也能改需求/版本"，任何人注册一个账号即可动别人的需求。把 `resource_name` 当作管理员发的"上岗证"，最直观也最好审。

### 5.2 判定函数（前端 `permission.js` 与服务端 plpgsql 逐条对齐）

```
全权 = 管理员 || 所属人

taskMine(t) = t.res 是空数组 || 我的人名 ∈ t.res      -- 空数组 = 未分配 = 待认领
modMine(mo) = mo.owner === 我的人名                    -- 缺失 = 无主

canEditTask(t)          = 全权 || (协作者 && taskMine(t))
canEditModuleFields(mo) = 全权 || 协作者               -- 优先级/描述/文档/提出人/提出时间/生命周期/所属版本/排序
canManageModule(mo)     = 全权 || (协作者 && modMine(mo))   -- 改名 / 删除 / 归档 / 转交
canEditMilestone(ms)    = canManageModule(ms 所属需求)      -- 手动编辑口径（版本机制见 §6.4）
canEditResources()      = 全权
canPlan()               = 全权                          -- 自动计划 / 撤销 / 重做 / 导入 / 项目周期
canEditProjectMeta()    = 全权                          -- 项目名 / 换负责人
canDeleteProject()      = 管理员
canEditVersion()        = 全权 || 协作者
canDeleteVersion()      = 全权
canArchiveVersionMods() = 全权
canManageUsers()        = 管理员
```

### 5.3 任务形态与判定的对应（依赖数据形态，不新增字段）

| 数据形态 | 含义 | 协作者能否编辑 |
|---|---|---|
| `res: ["张三"]` | 张三负责 | 我是张三 → 能 |
| `res: []` | 未分配的普通任务 | **能**（待认领） |
| **没有 `res` 键、且有 `m`** | 里程碑 | 按 `canEditMilestone` |

### 5.4 逐操作权限表

| 操作 | 管理员 | 所属人 | 协作者 | 只读/游客 |
|---|---|---|---|---|
| 项目 改名 / 换负责人 | ✓ | ✓ | ✗ | ✗ |
| 删除项目 | ✓ | ✗ | ✗ | ✗ |
| 需求 新增 / 改字段 / 排序 | ✓ | ✓ | ✓ | ✗ |
| 需求 改名 / 删除 / 归档 / 转交 | ✓ | ✓ | 仅自己创建的 | ✗ |
| 任务 增 / 改 / 删（`taskMine`） | ✓ | ✓ | ✓ | ✗ |
| 任务 增 / 改 / 删（他人负责） | ✓ | ✓ | ✗ | ✗ |
| **级联钉住**他人任务 | ✓ | ✓ | ✓（过 §6.3.1 校验） | ✗ |
| 里程碑 手动增 / 改 / 删 | ✓ | ✓ | 仅自己需求内的 | ✗ |
| 里程碑 由版本机制写入 | ✓ | ✓ | ✓（过 §6.4 校验） | ✗ |
| 一键自动计划 / 撤销 / 重做 / 导入 | ✓ | ✓ | ✗ | ✗ |
| 版本 新建 / 改 / 标记上线 / 改成员 / 改需求所属版本 | ✓ | ✓ | ✓ | ✗ |
| 版本 删除 / 一键归档本版本需求 | ✓ | ✓ | ✗ | ✗ |
| 资源库 增删改 | ✓ | ✓ | ✗ | ✗ |
| 问题面板 一键修复 / 忽略 | ✓ | ✓ | 仅自己的任务（他人任务只显示） | ✗ |
| 用户管理（姓名 / 角色 / 对应人员） | ✓ | ✗ | ✗ | ✗ |

**需求改名的服务端识别**：`updateModule` 改名时 JSON 表现为"需求 X 消失 + 需求 Y 出现"，与"删旧增新"同形。判据：**新增需求的 `bars` 与被删需求深度相等 ⟹ 这是改名**（改名只动 `name`、同步 `bars[].mod` 与 `versions[].mods`，不碰任务本身）。边界很窄——只有"改名"与"改任务"落在同一 300ms 防抖窗口内才会失效，而改名在需求弹窗、改任务在任务抽屉，实际不会撞上。

---

## 6. 服务端设计

### 6.1 RLS 策略一字不改

```sql
-- 保持原样（migration.sql:108-110）
create policy "projects_update" on public.projects
  for update to authenticated using (auth.uid() = owner_id or public.is_admin());
```

协作者直接 `PATCH /rest/v1/projects?id=eq.<项目>` **会被 RLS 拒绝**，唯一写入通道是 RPC。这是"服务端真强制"方案的关键优势。

### 6.2 唯一写入口：`save_plan(uuid, jsonb)`

```
协作者改自己任务
  → planStore.set() → plan-sync 防抖 300ms
  → RPC save_plan(project_id, plan)         ← 唯一写入口
      → SECURITY DEFINER 绕过 RLS
      → 内部逐项校验（§6.3）
      → 拒绝：抛异常（中文原因） → 前端提示 + 回滚（§8.5）
      → 通过：update projects set plan = ...
```

判定顺序：

```
1. auth.uid() 为空                     → 拒：「未登录」
2. 项目不存在 / old plan 缺失           → 拒：「项目不存在」
3. 我 admin 或 owner_id = 我            → 直接整份替换（快路径）
4. 我 resource_name 为空                → 拒：「账号未指定对应人员，请联系管理员」
5. assert_plan_editable(old, new, 我的人名) → 逐项校验
6. update projects set plan = ...
```

### 6.3 `assert_plan_editable(old, new, rname)` 校验清单

| # | 规则 | 拒绝信息 |
|---|---|---|
| 1 | ~~`start` / `end` 不可变~~ **刻意不做** | —— 见下方「为什么不管项目周期」 |
| 2 | `resources` 不可变 | 无权修改资源库 |
| 3 | 按 `name` 匹配：旧有新无 → 见「改名识别」 | 无权删除或重命名需求 |
| 4 | 按 `id` 匹配：旧有新无 → 拒 | 无权删除版本 |
| 5 | 需求 `archived` 变化：要求 `canManageModule` | 无权归档他人创建的需求 |
| 6 | 需求 `owner` 变化（转交）：要求 `canManageModule(old)` | 无权转交归属 |
| 7 | 任务级 diff（下） | 见下 |

**为什么不管项目周期（`start` / `end`）**

它是**派生数据，不是用户动作**：

```
cycle.apply()   start = min(所有任务的 s / 里程碑 m)   end = max(所有任务的 e / m)
```

`ctx.save()` 每次保存都会调它并写回 state（`scheduler/index.js:88`），加载时也会重算（`plan-sync.js:48`）。UI 里**已无「周期」入口**（原「周期」按钮已随 `cycle.js` 的改造移除）。

所以在服务端要求 `start`/`end` 不可变，等于：**协作者改一次自己的任务日期 → `end` 变大 → 被自己引发的派生写入拒掉**，功能直接不可用。这是设计评审时发现的阻塞级问题。

**残留风险（已接受）**：协作者可以往 `save_plan` 里塞一个假的 `start`/`end`。影响范围仅限 hero 副标题那一行显示（`main-gantt.js:210-214` 读的是 `p.plan.start`），且下次加载就被任务日期覆盖——不对任何人的数据造成实质影响。

**任务级 diff**：把 old/new 各自展开成 `(mod, task_id) → task` 做 FULL OUTER JOIN：

```
old 有 / new 无的需求 X：
  a) new 里存在新增需求 Y 且 X.bars = Y.bars（jsonb 深度相等）→ 判定为改名
       要求 X.owner = 我
  b) 否则 → 判定为删除
       要求 X.owner = 我      （需求创建人有该需求所有权限，见 §11 风险）
new 有 / old 无的需求 Y → 放行（协作者可新建需求）
```

任务级 diff：把 old/new 各自展开成 `(mod, task_id) → task` 做 FULL OUTER JOIN：

```
新增（old 无 / new 有）
  ├ 该 mod 是本次新建的需求 → 放行（新需求自带整套阶段任务与里程碑）
  └ 否则要求  new.res 为空数组 或 含我

删除（old 有 / new 无）
  └ 要求 old.res 为空数组 或 含我

修改（两边都有且不同）
  ├ taskMine(old)                                    → 放行
  ├ 里程碑（无 res 键且有 m）：
  │   ├ isGoMs 且命中 §6.4 特许 → 放行
  │   └ 否则要求 canManageModule(所属需求)            → 否则拒「无权修改他人需求的里程碑」
  └ 否则只允许 manual: false → true 且命中 §6.3.1 → 否则拒
```

#### 6.3.1 级联依据校验

服务端不信任客户端解释，自己算：

```
v_moved := { 本次 s/e/m 有变化 且 taskMine(old) 的任务 id }   -- 我真正移动过的任务
允许钉住 B  ⟺  B.dep 里存在某个 id ∈ v_moved                 -- B 的直接前置被我移动了
```

**为什么只看直接前置、不递归整条链**：级联本身在 B 处就断链——B 的直接前置没动，B 就没有变动的理由。"直接前置被移动"既充分又是必要的最小依据。

### 6.4 三处「特许写入」

除这三处外，任何写他人内容的操作都被拒。三者都是**系统机制的必然连带**，不是用户自由编辑：

| # | 特许 | 放行条件（服务端自算） |
|---|---|---|
| 1 | **级联钉住** | 把他人任务的 `manual` 由 `false` 改 `true`，且该任务 `dep` 里存在「本次被移动过的、属于我的任务」（§6.3.1） |
| 2 | **版本机制** | `versions` 数组本次有变化时，放行**版本成员需求**的「上线」里程碑（`m`/`manual`/`dep`）的写入 |
| 3 | **待排期联动** | 某需求的 `unscheduled` 由 `true→false` 时，放行该需求「上线」里程碑的写入（`mutations.js:557` 的既有联动） |

「上线」里程碑复用现有口径 `isGoMs(b)`（`src/core/versions.js:100`），**不新造概念**。特许 2 的已知宽松点见 §13。

### 6.5 函数分工

- `save_plan`：身份判定 + 错误码 + 快路径 + 落库
- `assert_plan_editable`：纯校验（`returns void`，只 `raise`），便于单独构造用例验证

`save_plan` 用 `SECURITY DEFINER` + `set search_path = public`（与既有 `is_admin()` / `handle_new_user()` 同风格）。

---

## 7. 服务端迁移清单

`deploy/supabase/migration.sql` 追加（保持单文件幂等，沿用现有风格）：

### 7.1 加列

```sql
alter table public.profiles add column if not exists resource_name text;
```

不做回填（§4.1）。

### 7.2 敏感字段守卫触发器（修 §3 漏洞）

```sql
create or replace function public.guard_profile_sensitive()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.role is distinct from old.role
      or new.resource_name is distinct from old.resource_name)
     and not public.is_admin() then
    raise exception '仅管理员可修改角色与对应人员' using errcode = '42501';
  end if;
  return new;
end; $$;

drop trigger if exists profiles_guard_sensitive on public.profiles;
create trigger profiles_guard_sensitive
  before update on public.profiles
  for each row execute function public.guard_profile_sensitive();
```

必须用触发器：`with check` 无法引用 `OLD`，在策略里查同表还会有可见性/竞态问题。加完之后普通用户改自己的 `display_name` 照旧可用，改 `role` / `resource_name` 被拒。

### 7.3 新函数

| 函数 | 作用 |
|---|---|
| `save_plan(p_project_id uuid, p_plan jsonb) returns jsonb` | 唯一写入口（§6.2） |
| `assert_plan_editable(p_old jsonb, p_new jsonb, p_rname text) returns void` | 纯校验（§6.3） |
| `list_resource_names() returns table(name text)` | 聚合各项目 plan 里 `resources[].name` 与任务 `res` 的人名并去重，供"对应人员"的 `datalist` 候选 |

### 7.4 部署动作

**2026-10-15 更正**：本项目**能通过 Supabase MCP 自动化**（`supabase_apply_migration` / `supabase_execute_sql`），
不再是"手工在 SQL Editor 执行"。迁移由实现计划里各任务的 Step 应用，并**当场跑验证用例**（含用
`set_config('request.jwt.claims', …)` 模拟身份、`begin; … rollback;` 保证不在真实行上留痕）。

执行后**所有账号先降为只读**，需管理员逐个指定「对应人员」才能恢复协作权限——这是 §4.1 安全口径的必然代价，
用户管理页用红色「未指定」徽标驱动这次补录。**这一步 MCP 做不到**（"谁对应哪个人名"是业务决定），必须人工。

### 7.5 已发现的仓库/线上漂移（2026-10-15）

线上库有 `projects_select_anon`（`to anon using (true)`），但仓库的 `migration.sql` **从来没有它** ——
它以独立迁移 `20260910021121 anon_readonly_projects` 应用过（见 `supabase_migrations.schema_migrations`），
却从未回填进仓库文件。

**后果**：拿这份文件从零建库时，游客只读模式会**静默失效**（anon 读不到项目 → 项目列表页空白）。

**处理**：已作为 Task 3 Step 1b 回填进 `migration.sql`（内容与线上一致，对线上是幂等重写）。

`projects_update` / `projects_insert` / `projects_delete` / `projects_select` 策略**一字不改**。

---

## 8. 前端设计

### 8.1 `src/utils/permission.js`（新增）

**纯函数、不碰 DOM 与 window**，因此可完整单测，也是与服务端规则的唯一映射点。导出 §5.2 的全部判定函数。

### 8.2 `userStore` 扩展

```js
{ user, role, resourceName, isOwner, access: 'full'|'collab'|'readonly',
  project, projectId, readonly }
```

**`readonly` 的语义不变**（`readonly === (access === 'readonly')`），因此现有 19 个组件里的 `isReadonly()` 调用点**一行都不用改**，只新增按粒度细分的函数。

`access` 的计算放进 `src/main-gantt.js` 的 `initProject()`（替换现在 `main-gantt.js:220` 的单行 `editable` 判定）。`resourceName` 来自 `getProfile`——需把 `src/services/backends/supabase.js:44-48` 的 select 列表加上 `resource_name`。

### 8.3 `assertEditable` 改造（21 处调用点）

```js
// 现在：全局布尔
assertEditable(throwing)

// 改为：带目标
assertEditable(throwing, target)
// target: {kind:'task', task} | {kind:'module', mo} | {kind:'moduleDelete', mo}
//       | {kind:'milestone', ms, mo} | {kind:'version'} | {kind:'versionDelete'}
//       | {kind:'resources'} | {kind:'plan'}
```

不带 `target` 时**默认最严**（等价 `canPlan()`，仅全权用户）。逐处传入正确目标是本次最容易漏的一环，靠 §11 的单测兜住。

### 8.4 级联断链（`src/scheduler/planning.js`）

新增 `collectAffectedCapped(anchorId)`：BFS 遍历后置边时，遇到 `!canEditTask(t)` 的节点 → **`t.manual = true` 钉住 + 该分支不再下探**，返回 `{ affected, pinned }`。

- `cascade` / `previewCascade` / `resolveAuto` 三条路径都要换
- **`previewCascade` 必须同步改**：否则拖拽时的虚线预览与实际落位不一致，用户会看到"预览在这、松手跑到那"
- 全权用户走原 `collectAffected`，**行为与改造前逐字节相同**
- `cascade` 返回 `pinned` 数组，`src/components/drag.js` 据此提示「已钉住 N 条他人任务，产生依赖冲突」
- 被钉任务自带「手动」锁图标（`src/views/mod-view.js:83`、`src/views/mod-card.js:56`），**无需新增视觉元素**

### 8.5 保存失败的容错（必须做）

现在 `pushToServer` 失败只提示、不回滚（`src/services/plan-sync.js:96-107`）。服务端接管校验后，"本地已改、服务端拒了"会成为**常态路径**：

1. 识别权限拒绝（`errcode 42501` / 文案含"无权"）
2. **回滚**：调 `sched.loadFromServer()` 拉回服务器版本并重绘
3. 提示服务端返回的**具体中文原因**，而不是笼统的"保存失败"

### 8.6 `sched.undo/redo` 补守卫

现状：`undo`/`redo`（`src/scheduler/index.js:95-104`）**没有** `assertEditable`，只靠按钮 disabled 与 CSS 灰化。本次按 `canPlan()` 补上数据层守卫——它们回滚的是**整份 plan 快照**，协作者用会连带回滚别人的改动。

---

## 9. UI 收敛（逐处）

| 入口 | 改造 |
|---|---|
| 工具栏 `EDIT_BTN_IDS` | 拆两组：`READONLY_BTN_IDS`（沿用 `readonly` 语义）＋`FULL_ONLY_BTN_IDS`＝`btnAutoPlan` / `btnUndo` / `btnRedo` / `btnImport` / `btnResLib`（协作者也禁用） |
| 项目周期按钮 | 按 `canEditProjectMeta()` 显隐（协作者禁用） |
| 拖拽 `src/components/drag.js` | `isReadonly()` → `!canEditTask(t)`，逐任务判定（`:215,236,249`） |
| 任务抽屉 / 右键菜单 | 打开他人任务 → 表单只读、保存/删除隐藏；`src/components/menu-actions.js` 的 `flags.editable` 按任务算 |
| 需求弹窗 `src/components/modals.js` | 非 owner：需求名输入框置灰 + tooltip 说明；其余字段照常 |
| 需求弹窗 新增「归属」字段 | `datalist`（候选同 §10.1 的 `list_resource_names()`）。按 `canManageModule(mo)` 可改 —— 即需求创建人可把自己的需求**转交**出去，项目所属人/管理员可转交给任何人。新建需求时默认 = 我的人名（`addModule()` 写入） |
| 需求台账 `src/components/req-page.js` | 「归档」「删除」按 `canManageModule` 显隐；行内编辑（生命周期/提出人/所属版本）保持放开 |
| 版本页 `src/components/version-page.js` | 「删除版本」「一键归档本版本需求」按权限显隐；其余照旧 |
| 资源库 `src/components/reslib.js` | 入口对协作者隐藏 |
| 问题面板 `src/components/problem-drawer.js` | 他人任务的问题只显示，隐藏「一键修复 / 忽略」 |

CSS 侧沿用现有约定：`readonly-mode` 类（`src/styles/gantt.css:1034,1171-1172,1212`）继续只管"完全只读"。

### 9.1 资源工作视图：编辑自己的任务进度（2026-09-24 追加需求）

**范围**：只做**资源工作视图**（`work` 视图 / `src/views/work-view.js`）。
**不做**「工作组规划器」（`res` 视图 / `src/views/res-view.js`）——那才是"时间轴视角"（见 `work-view.js:5` 的文件头对比说明），本次不在范围。

#### 背景：为什么必须新写一条 mutation

- 进度字段是 `t.done`。`saveTask()` 的**编辑分支不写 `done`**（`t.done = committed.done`，从既有值继承）
- 现有唯一改 `done` 的路径是右键菜单的 `saveTask(id, { complete: true })`，它只会把 `done` 设成 **100**，**表达不了"我现在 40%"**

因此新增专用 mutation：

```
setProgress(taskId, pct)
  · pct 归一化：Math.max(0, Math.min(100, Math.round(Number(pct))))，非数值 → 直接 return
  · 守卫：assertEditable(false, { kind:'task', task })   ← 走任务级归属判定
  · 只写 t.done，不触发重排（改进度不影响日期，不需要 recomputeAffected）
  · ctx.save() → 落到撤销栈，可 Ctrl+Z 撤销
```

并把它加进 §8.3 的 `target` 映射表：`{ kind:'task', task: findRawBar(taskId) }`。

#### 本页的可编辑口径（比全局更窄，刻意如此）

```
本页可编辑进度 ⟺ access === 'full'
                || (access === 'collab' && t.res 含我的人名)
```

| 身份 | 本页可编辑的行 |
|---|---|
| 管理员 / 所属人（full） | 所有任务行（含未分配） |
| 协作者（collab） | **只有 `res` 含自己人名的行** |
| 只读 / 游客 | 无 |

**与全局口径的差异（必须记住）**：全局 §5.2 里「未分配任务 = 待认领，协作者可编辑」，但**本页对未分配任务只读**。理由：本页是"我的活儿清单"（按人分块），不是认领板；认领请去甘特图。

推论有两条，都是刻意的：
1. 本页的「未分配」区块退化为**纯展示**（能看到有活没人干，但要动手得去甘特图）
2. **服务端会放行、只是本页不给入口**——`assert_plan_editable` 的"修改"分支用 `bar_owned()`，它对 `res:[]` 返回 true。这是"前端比服务端更严"，方向安全，但**不要**因此误判服务端漏判

#### 交互形态：点击输入（不做拖拽）

选点击而非拖拽的直接原因：进度条填充宽 = `${pct}%`（`work-view.js:116`），**`pct = 0` 时填充宽 0，拖拽没有任何可命中的元素**；且轨道仅约 60px 宽，拖一下 2% 一跳、手机上拖不准。改成点整格后这两个问题一并消失。

```
点「进度」格（整格 .rwk-prog，含百分比文字）
  → 就地弹出小弹层：
      数字输入（0–100 整数）
      档位按钮：0% / 25% / 50% / 75% / 100%
      步进按钮：−5% / +5%
      保存 / 取消
  → Enter 保存、Esc 取消、点击外部关闭
  → 保存即 setProgress(taskId, pct)
```

- 不可编辑的行：**不渲染任何编辑入口**（不加 `data-wk-prog` 属性、`cursor` 也不变 pointer），从 DOM 层面保证点不动
- 弹层按钮最小 40px 触摸高度（手机可点）
- 状态徽标不用单独做：状态由 `done` + 日期推导（`core/task-status.js`），改 `done` 会同时带动进度条与状态徽标

#### 涉及文件

| 文件 | 改动 |
|---|---|
| `src/scheduler/mutations.js` | 新增 `setProgress`；加进导出清单 |
| `src/scheduler/index.js` | 挂到 `sched.setProgress` |
| `src/views/work-view.js` | `taskRow()` 给可编辑行加 `data-wk-prog` 标记与当前 `done` |
| `src/components/work-task.js` | **新增**：进度弹层的绑定与提交（照 `work-filter.js` 的委托模式） |
| `src/components/index.js` | 挂载 `bindWorkTask(deps)` |
| `src/styles/gantt.css` | 进度格可点击态 + 弹层样式 |
| `tests/` | `setProgress` 的归一化与守卫；本页可编辑口径；弹层提交 |

---

## 10. 用户管理与项目页

### 10.1 用户管理页（`index.html` + `src/main-index.js`）

- 列表每行新增「**对应人员**」列：未指定时显示醒目的红色「**未指定**」徽标（漏配发现机制）
- 把「设为管理员」换成「**编辑**」→ 弹窗：姓名 + 角色（管理员/普通用户分段控件）+ 对应人员（`datalist` 候选来自 `list_resource_names()`）
  - 用 `datalist` 而非纯文本，是为了避免拼错——**拼错的人将什么都改不了，且极难排查**
- 两条保护规则：
  - **不能改自己的角色**（避免误操作把自己降级后无人能修）
  - **不能降级最后一个管理员**（否则系统没有管理员）
- 新增账号弹窗加「对应人员」可选项（留空 = 未指定）
- `setAdmin(userId)` 扩展为 `updateProfile(userId, { display_name, role, resource_name })`，同步改两个后端实现（`backends/supabase.js`、`backends/feishu.js`）

### 10.2 项目页

- 「管理」按钮：**owner 也显示**（现在只对 admin，`src/main-index.js:76`）——这是"普通用户能建项目"真正的缺口
- 编辑弹窗：owner 可改名 / 换负责人；**删除项目仍仅 admin**（`migration.sql:112-114` 不改）。**不做「改周期」**——周期是派生数据，见 §6.3
- 换负责人加二次确认 + 明确警告「转交后你将失去对该项目的管理权」

---

## 11. 测试策略

| 文件 | 覆盖 |
|---|---|
| `tests/permission.test.js`（新增） | `taskMine` / `modMine` / 全部 `canXxx` 的**真值表**；`resourceName` 为空 → 一律 false；里程碑 `isGoMs` 分支 |
| `tests/scheduler.test.js` | `assertEditable` 带 target 的 21 处守卫；只读语义不回退（既有用例见 `:527,533,542,773`） |
| `tests/planning.test.js`（新增或并入 scheduler） | 级联断链：钉住 + 不再下探 + `pinned` 返回值；**`previewCascade` 与 `cascade` 结果必须一致**；全权用户行为与改造前逐字节相同 |
| `tests/components.test.js` | 他人任务抽屉只读、右键菜单 disabled、工具栏两组按钮显隐 |
| `tests/views.test.js` | 需求名置灰、归档/删除按钮显隐、版本页删除与一键归档显隐 |
| `tests/req-page.test.js` | 台账行内编辑对非 owner 需求的行为 |
| `tests/plan-sync.test.js`（新增） | 服务端拒绝 → 回滚 + 具体文案 |

服务端 plpgsql **无自动化测试环境**，靠手工用例：准备 owner / 协作者 A / 协作者 B 三个账号，逐条走 §6.3 的校验清单，并**特意用 curl 绕过前端**验证 RLS 与 RPC 都兜得住。

---

## 12. 非目标

- **飞书后端不做**（`FEISHU_CONFIG.enabled` 当前为 `false`，实际走 Supabase）。飞书那套是 Python bridge，服务端校验要在 bridge 里另做一遍，本次不涉及
- **跨项目工作规划**——按约定拆成第二个 spec
- 不引入 Edge Function：不做删除账号 / 改密码 / 真封禁（按决策 §1.1-2）
- 不给 module 加稳定 `id`（改名改用"`bars` 深度相等"识别，见 §5.4）
- 不改 plan 的单 jsonb 文档结构
- 不做操作审计日志
- 不做需求创建人离职后的批量改派 UI（当前由项目所属人/管理员在需求弹窗里逐个转交即可）

---

## 13. 风险与取舍

| 风险 | 处理 |
|---|---|
| **前端与服务端规则漂移** → "能填但存不进" | 两份规则以 §5.2 同一张表为准；`permission.js` 与 plpgsql 逐条对齐；服务端拒绝必须回滚 + 给具体原因（§8.5），不让用户猜 |
| **plpgsql 校验规则多且无自动化测试** | 本次最脆的一块。手工用例清单化（§11），并补 curl 绕过前端的验证 |
| 协作者删自己需求 → **连带删掉里面他人负责的任务** | 决策 §1.1-13「需求创建人有该需求所有权限」的必然结果。**兜底**：删除确认弹窗必须列出「将同时删除 N 条他人负责的任务」，把破坏性说清楚，而不是拦下来 |
| 需求里一旦有他人任务，owner 改名要满足 `bars` 不变 | 边界窄（改名在弹窗、改任务在抽屉，中间必然超过 300ms 防抖窗口）；仍写进注释并配单测 |
| **特许 2 的门比实际需要宽** | 门是"versions 变了"而不是"这一条里程碑确实该变"。协作者只要在同一次提交里动了版本页（哪怕只是标记上线），就能顺带写成员需求的上线里程碑。影响等价于"他本来就能通过版本页做到的事"，可接受，但需在代码注释中写明 |
| 执行迁移后**所有人先变只读** | 这是 §4.1 安全口径的必然代价。用户管理页的红色「未指定」徽标是恢复路径；上线前需一次性完成补录 |
| 服务端校验依赖"任务 `id`"做 diff | 里程碑 `id` 是惰性生成并写回原始数据的（`src/scheduler/index.js:47`），首屏 `collect()` 前可能缺失。缺失时归入"新增/删除"分支——因里程碑 `res` 不存在、`taskMine` 对空 `res` 为真，不会误拒合法操作，但需在实现时确认一遍 |
| **协作者可伪造 `start` / `end`** | 派生数据刻意不校验（§6.3 已详述）。影响仅限 hero 副标题一行显示，且下次加载即被任务日期覆盖。**这条是有意为之，不要去"修"** |
| **`bar_norm` 必须剔除 `mod` / `isMs`** | 这两个是 `collect()` 写回的运行期字段。不剔除的话，需求改名会让所有 `bars[].mod` 一起变 → 被误判成"批量修改任务" → 协作者的合法改名直接被拒 |

---

## 14. 已否决的替代方案（记录理由，避免重复讨论）

| 方案 | 否决理由 |
|---|---|
| **靠 `display_name` 隐式匹配人名** | 管理员给谁改个名，那人当场失去所有任务的编辑权；两人同名会互拿编辑权。改用 `profiles.resource_name` 显式指定 |
| **在项目资源库里逐人绑定账号** | 要逐项目配置，权限信息散落各项目的 jsonb 里，排查权限问题要翻每个项目 |
| **纯前端强制（放宽 RLS，规则只写在 `assertEditable`）** | 防误操作不防蓄意绕过。用户明确选择服务端真强制 |
| **plan 拆表 + 行级 RLS** | 最正统但等于重做数据层：plan-sync、撤销重做、单文件导出、飞书同步全部要重写 |
| **级联遇阻时直接中止并挂问题** | 会造成排期自相矛盾（下游日期早于前置）且冲突无法持久化——下次任何人点"自动计划"又会被拉回去。改用"钉住 + 报冲突" |
| **禁止拖动被依赖的任务** | 上线前几天谁都在互相等，会让人干不了活 |
| **`resource_name` 自动取 `display_name`** | 存在公开注册入口，注册时姓名填「张三」即拿到张三名下全部任务编辑权 |
| **用 `proposedBy` 当需求归属人** | 语义不同（需求来源 / 业务方），且是自由文本、默认被回填成常量 |
| **协作者改需求名一律放开** | 服务端无法区分"改名"与"删旧增新"，等于放开删除需求 |
| **给需求加稳定 `id` 以区别改名** | module 会多一套身份，与"需求名即主键"（`t.mod`、`versions[].mods` 全靠名字）并存，概念与漂移风险不划算 |
