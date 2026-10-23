// ============================================================
// src/scheduler/mutations.js — 任务/需求/资源编辑（状态经 ctx 注入）
// 由 gantt-scheduler.js 迁移：
//   只读守卫 assertEditable（21 处入口统一，throw 语义用于"新增/导入"类）
//   任务编辑统一入口 saveTask / moveMilestone / setMilestoneDate / changeTaskType
//   renameTask / deleteTask / addTask / addModule / moveModule / moveBar / resizeTask
//   资源管理 renameResourceRefs / updateResource / addResource / deleteResource
// 依赖：core/dates.js、core/default-data.js（PNAME）、store/user-store.js（只读状态）
// ============================================================
import { F } from './planning.js';
import { fmt, addDays } from '../core/dates.js';
import { PNAME, MODULE_PHASES, MODULE_MILESTONE_PHASES, PRIORITY_DEFAULT, normalizePriority, normalizeLifecycle } from '../core/default-data.js';
import { milestoneName } from '../core/mod-tag.js';
import { newVersionId, versionOfMap, versionOfMod, isGoMs, findGoMs } from '../core/versions.js';
import { userStore } from '../store/user-store.js';
import { ctxOf, canPlan, canTouchTask, canEditTask, canManageModule, canEditModuleFields,
         canEditVersion, canDeleteVersion, canArchiveVersionMods, canEditResources } from '../utils/permission.js';

// 判定上下文：从 userStore.state 派生（access / rname / role）
function permCtx() { return ctxOf(userStore.state); }

// 按目标粒度的守卫（设计文档 §8.3）。
//   throw 语义用于"新增"类（UI 会因此弹错）；其余静默 return，与改造前一致。
//   不带 target 时取最严（等价 canPlan = 仅全权用户）。
//   target 形态：
//     { kind:'task',      task }                 普通任务（按 res 判定）
//     { kind:'milestone', ms, mo }               里程碑（按需求归属判定）
//     { kind:'taskNew',   mod, res }             新增任务（看它打算派给谁）
//     { kind:'moduleFields' }                    需求字段级
//     { kind:'module',    mo }                   需求归属级（改名/删除/归档/转交）
//     { kind:'moduleNew' }                       新增需求
//     { kind:'version' } / { kind:'versionDelete' } / { kind:'versionArchive' }
//     { kind:'resources' } / { kind:'plan' }
export function assertEditable(throwing, target) {
  const c = permCtx();
  let ok;
  switch (target && target.kind) {
    case 'task':          ok = canEditTask(target.task, c); break;
    case 'milestone':     ok = canTouchTask(target.ms, target.mo, c); break;
    case 'taskNew':       ok = canEditTask({ res: target.res }, c); break;
    case 'moduleFields':  ok = canEditModuleFields(c); break;
    case 'module':        ok = canManageModule(target.mo, c); break;
    case 'moduleNew':     ok = canEditModuleFields(c); break;
    case 'version':       ok = canEditVersion(c); break;
    case 'versionDelete': ok = canDeleteVersion(c); break;
    case 'versionArchive':ok = canArchiveVersionMods(c); break;
    case 'resources':     ok = canEditResources(c); break;
    case 'plan':
    default:              ok = canPlan(c);
  }
  if (ok) return true;
  if (throwing) throw new Error('只读模式，无法修改');
  return false;
}

// 给测试与调用方用的导出（保持既有只读语义的回归用例可读）
export { permCtx };

export function createMutations(ctx) {
  const { getState, setState, W } = ctx;

  // 任务显示名：自定义 name / 里程碑 label 优先，否则回退「需求 · 阶段」
  function nameOf(t) {
    if (!t) return '(未知任务)';
    // 里程碑名统一走 milestoneName：剥掉冗余的需求名前缀，无名时回退阶段名
    if (t.isMs) return milestoneName(t, t.mod);
    return t.name || `${t.mod} · ${PNAME[t.p]}`;
  }

  // 按 id 定位原始任务条（getTask 对里程碑返回的是副本，修改需落到原始对象）
  function findRawBar(id) {
    for (const mo of getState().modules) {
      for (const b of mo.bars) {
        if (b.id === id) return b;
      }
    }
    return null;
  }

  // 任务条所属需求名（用于里程碑 label 生成）
  function findModName(raw) {
    for (const mo of getState().modules) if (mo.bars.includes(raw)) return mo.name;
    return '';
  }

  // 任务条所属需求对象
  function findMod(raw) {
    for (const mo of getState().modules) if (mo.bars.includes(raw)) return mo;
    return null;
  }

  // 里程碑守卫：里程碑没有 res，若按 { kind:'task' } 判会被当成"未分配任务"而放行；
  // 它的权限跟的是**需求归属**（canEditMilestone = canManageModule(mo)），必须走 milestone 分支。
  // 定位不到任务条时退回最严（不带 target），与"漏传 target"同口径，绝不隐式放行。
  function msGuard(id) {
    const raw = findRawBar(id);
    if (!raw) return assertEditable(false);
    return assertEditable(false, { kind: 'milestone', ms: raw, mo: findMod(raw) });
  }

  // 通用数组内移动：把 src 元素移动到 to 元素之前/之后（splice 索引修正）
  function moveInArray(arr, fromIdx, toIdx, before) {
    const [item] = arr.splice(fromIdx, 1);
    let insertAt = before ? toIdx : toIdx + 1;
    if (fromIdx < toIdx) insertAt -= 1;
    arr.splice(Math.max(0, Math.min(arr.length, insertAt)), 0, item);
  }

  // 生成不与现存任务冲突的 id
  function genTaskId(moName, p) {
    let id;
    do { id = moName + '-' + p + '-' + Math.random().toString(36).slice(2, 7); } while (ctx.tasksById[id]);
    return id;
  }

  // ============ 任务编辑统一入口（高内聚：类型/字段/周期/级联一站式） ============
  // draft: { type:'task'|'ms', manual:boolean, res:string[], dep:[{id,lag}], start:'YYYY-MM-DD', dur:number,
  //          mod:string, p:string }
  // 语义：
  //   里程碑 = 0 天周期单点（b.m 上线日期），不参与资源排期但可作为依赖目标
  //   普通任务 = 周期 dur（结束 = 开始 + dur - 1）；manual 锁定日期，auto 由引擎重排并级联后置
  //   mod/p = 归属变更（抽屉编辑改需求/阶段）：跨需求移动时 id 不变，依赖引用不受影响
  function saveTask(taskId, draft) {
    const raw = findRawBar(taskId);   // 始终操作原始对象，保证持久化与里程碑一致性
    // 新增分支（raw 为空、committed 还没推入 bars）按"打算派给谁"判定；
    // 编辑分支按"这条任务现在归谁"判定 —— 注意用 old 的 res，不能用 draft.res，
    // 否则协作者把自己的任务 res 改成别人就能绕过（改完就成别人的了，本不该允许改）
    const isNew = !raw;
    // 编辑分支必须**按任务形态分流**：里程碑没有 res 键，若一律走 {kind:'task'}，
    // taskMine 对非数组 res 返回 false → 协作者连「自己需求里的里程碑」都改不了
    // （抽屉保存 label/上线日、右键标记完成、切换手动/自动都会静默无反应）。
    // 与 msGuard 同一口径：里程碑跟需求归属（canTouchTask → canEditMilestone → canManageModule）。
    // 新增分支统一 res：调用方不传 res 时归一为空数组 = 待认领，与 saveTask 新建语义一致，
    // 否则 {res: undefined} 会让 taskMine 判 false，协作者连未指派任务都建不了。
    const guard = isNew
      ? { kind: 'taskNew', res: (draft && draft.res) || [] }
      : (raw.m
          ? { kind: 'milestone', ms: raw, mo: findMod(raw) }
          : { kind: 'task', task: raw });
    if (!assertEditable(isNew, guard)) return;
    if (!raw) return;
    // 类型判定：draft 未显式带 type 时（如"新建后补写依赖"这类局部更新）必须沿用任务原始类型。
    // 否则里程碑会被当成"转成普通任务"处理 → delete raw.m 降级成任务，且 res 未初始化，
    // 后续 recomputeAffected 读 t.res.forEach 直接抛 TypeError。
    const toMs = draft.type ? draft.type === 'ms' : !!raw.m;

    // 1. 类型切换：里程碑仅增删 m，保留 s/e 便于转回时还原
    if (toMs && !raw.m) {
      raw.m = fmt(F(draft.start || raw.s || getState().start));
      if (!raw.label) {
        // 与 addTask 一致：默认名只取阶段名，不再拼需求名前缀
        // （「需求名 里程碑」在图上被剥掉前缀后只剩「里程碑」，看不出是什么卡点）
        raw.label = PNAME[raw.p] || '里程碑';
      }
    } else if (!toMs && raw.m) {
      delete raw.m;
      raw.manual = true;   // 转回普通任务默认手动锁定该单点，避免被自动计划冲掉
    }

    if (toMs) {
      // 2a. 里程碑：手动=指定日期，自动=由依赖重排上线日；保留依赖配置
      // 里程碑是时间点，无完成度概念。转里程碑时清除残留的 done（任务态遗留值，如 done:1），
      // 否则转回普通任务时会带着一个假进度，直接把需求进度拉低（94% 这类"差一点到 100%"问题的根源）。
      delete raw.done;
      if ('manual' in draft) raw.manual = !!draft.manual;
      if ('dep' in draft) raw.dep = (draft.dep || []).map(d => ({ id: d.id, lag: Number(d.lag) || 0 }));
      if ('name' in draft) { const n = (draft.name || '').trim(); if (n) raw.label = n; else delete raw.label; }
      if (draft.start && raw.manual) raw.m = fmt(F(draft.start));
    } else {
      // 2b. 普通任务：应用字段 + 周期/日期
      if ('res' in draft) raw.res = [...(draft.res || [])];
      // 兜底：历史数据或异常流程产生的任务可能没有 res，补空数组避免后续资源计算崩
      if (!Array.isArray(raw.res)) raw.res = [];
      if ('dep' in draft) raw.dep = (draft.dep || []).map(d => ({ id: d.id, lag: Number(d.lag) || 0 }));
      if ('name' in draft) { const n = (draft.name || '').trim(); if (n) raw.name = n; else delete raw.name; }
      if ('manual' in draft) raw.manual = !!draft.manual;
      if ('done' in draft) raw.done = Math.min(100, Math.max(0, Number(draft.done) || 0));
      // 持续时间 = 工作量（人天/工作日），结束日从开始日起完成 dur 个工作日（自动跳过周末/节假日）
      const oldDur = (raw.s && raw.e) ? W.workDays(raw.s, raw.e) : 1;
      const dur = (draft.dur && draft.dur > 0) ? Math.round(draft.dur) : oldDur;
      const start = draft.start ? F(draft.start) : (raw.s ? F(raw.s) : getState().start);
      raw.s = fmt(start);
      raw.e = fmt(W.addWorkdays(start, dur));   // 工作量 → 结束日（处理节假日）
      raw.w = dur;         // 工作量（人天）同步持久化，重开抽屉回显一致
    }

    // 3. 归属变更：阶段（影响条色与默认名）与需求（跨需求移动）
    if (draft.p && PNAME[draft.p] && draft.p !== raw.p) raw.p = draft.p;
    const oldMod = findModName(raw);
    if (draft.mod && draft.mod !== oldMod) {
      const from = findMod(raw);
      const to = (getState().modules || []).find(m => m.name === draft.mod);
      if (from && to) {
        const idx = from.bars.indexOf(raw);
        if (idx >= 0) from.bars.splice(idx, 1);
        to.bars.push(raw);   // 追加到目标需求末尾（与 addTask 一致），顺序可由行拖拽再调整
        // 里程碑默认名「需求名 里程碑」随需求同步；用户自定义过的 label 保持不动
        if (raw.m && raw.label === oldMod + ' 里程碑') raw.label = draft.mod + ' 里程碑';
      }
    }

    // 4. 重建索引并级联重排本任务及其后置子图
    //    collectAffected 是"唯一入口"：协作者模式内部自动断链并返回 pinned，这里只取 affected
    ctx.collect();
    ctx.recomputeAffected(ctx.collectAffected(taskId).affected);
    ctx.save();
  }

  // 里程碑：拖拽落位（仅调整上线日期 m）
  function moveMilestone(msId, newDate) {
    if (!msGuard(msId)) return;
    let target = null;
    getState().modules.forEach(mo => mo.bars.forEach(b => {
      if (b.m && b.id === msId) target = b;
    }));
    if (!target) return;
    target.m = fmt(F(newDate));   // 与 setMilestoneDate 同口径：入参可能是 'YYYY-MM-DD' 字符串
    target.manual = true;   // 拖拽落位视为手动锁定，避免自动计划覆盖
    ctx.save();
  }

  // 里程碑：通过抽屉编辑上线日期
  function setMilestoneDate(msId, dateStr) {
    if (!msGuard(msId)) return;
    let target = null;
    getState().modules.forEach(mo => mo.bars.forEach(b => {
      if (b.m && b.id === msId) target = b;
    }));
    if (!target) return;
    target.m = fmt(F(dateStr));
    target.manual = true;   // 手动指定日期即锁定，避免自动计划覆盖
    ctx.save();
  }

  // 需求排序：把 fromName 需求（连同其全部任务阶段）移动到 toName 需求之前/之后
  function moveModule(fromName, toName, before) {
    if (!assertEditable(false, { kind: 'moduleFields' })) return;
    const mods = getState().modules || [];
    const fromIdx = mods.findIndex(m => m.name === fromName);
    const toIdx = mods.findIndex(m => m.name === toName);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    moveInArray(mods, fromIdx, toIdx, before);
    ctx.save();
  }

  // 任务阶段排序：把 taskId 对应任务条移动到 toTaskId 之前/之后（仅限同一需求内）
  function moveBar(taskId, toTaskId, before) {
    if (!assertEditable(false, { kind: 'moduleFields' })) return;
    const raw = findRawBar(taskId);
    if (!raw) return;
    const mo = findMod(raw);
    if (!mo) return;
    const fromIdx = mo.bars.indexOf(raw);
    const toIdx = mo.bars.findIndex(b => b.id === toTaskId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    moveInArray(mo.bars, fromIdx, toIdx, before);
    ctx.save();
  }

  // 切换任务类型：普通任务 <-> 里程碑（委托 saveTask，保证语义一致）
  // 里程碑为 0 天周期的单点时间，仅含一个上线日期（b.m），代表某个时间点
  function changeTaskType(taskId, toMs, dateStr) {
    if (!msGuard(taskId)) return;
    const raw = findRawBar(taskId);
    if (!raw) return;
    saveTask(taskId, {
      type: toMs ? 'ms' : 'task',
      start: dateStr || raw.m || raw.s,
      dur: toMs ? undefined : (raw.s && raw.e ? W.workDays(raw.s, raw.e) : 1),
      manual: true,            // 类型切换后默认手动锁定当前日期，避免自动计划误移
      res: raw.res, dep: raw.dep
    });
  }

  // 重命名任务：普通任务改 name，里程碑改 label；传空字符串则清除自定义名回退默认
  function renameTask(taskId, name) {
    // findRawBar 是双重循环全量扫描 → 只取一次；定位不到时退回最严（不带 target）
    const raw = findRawBar(taskId);
    if (!raw) { assertEditable(false); return; }
    if (!assertEditable(false, { kind: 'task', task: raw })) return;
    const n = (name == null ? '' : String(name)).trim();
    if (raw.isMs) { if (n) raw.label = n; else delete raw.label; }
    else { if (n) raw.name = n; else delete raw.name; }
    ctx.save();
  }

  // 设置任务完成度（0–100 整数）。
  // 为什么单独一条：saveTask 的编辑分支不写 done（从既有值继承），
  // 而 { complete: true } 只能表达"100%"，没法表达"我现在 40%"。
  // 改进度不影响日期，因此刻意不做 recomputeAffected —— 进度与排期是正交的两件事。
  function setProgress(taskId, pct) {
    const raw = taskId ? findRawBar(taskId) : null;
    if (!raw) return null;
    if (raw.m) return null;                       // 里程碑是 0 天单点，没有完成度概念
    // ⚠️ 必须在 Number() **之前**挡掉空值：
    //   Math.round(Number('')) === 0 且 Number.isFinite(0) === true，
    //   Number(null) === 0 同理 —— 只靠 isFinite 会把 ''/null 静默写成 0%（而不是 NaN）。
    if (pct == null || String(pct).trim() === '') return null;
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n)) return null;         // 真正的非数值（'abc' → NaN）
    if (!assertEditable(false, { kind: 'task', task: raw })) return null;
    const v = Math.max(0, Math.min(100, n));
    raw.done = v;
    ctx.save();                                   // 落进撤销栈，可 Ctrl+Z 撤回
    return v;
  }

  // 删除任务：从所属需求的 bars 中移除，同时清理其他任务对该任务的依赖引用，重建索引并持久化
  function deleteTask(taskId) {
    const raw = findRawBar(taskId);   // 只扫一次（同上）
    if (!raw) { assertEditable(false); return; }
    if (!assertEditable(false, { kind: 'task', task: raw })) return;
    const mo = findMod(raw);
    if (!mo) return;
    const idx = mo.bars.indexOf(raw);
    if (idx >= 0) mo.bars.splice(idx, 1);
    // 清理其他任务对该任务的依赖
    getState().modules.forEach(m => m.bars.forEach(b => {
      if (b.dep) b.dep = b.dep.filter(d => d.id !== taskId);
    }));
    ctx.collect();
    ctx.save();
  }

  // 新增任务：opts = { mod, p, name?, type:'task'|'ms', start, dur?, res?, manual }
  //   普通任务 = 周期 dur（默认 1 天），里程碑 = 单点上线日 m；返回新任务 id
  function addTask(opts) {
    // 按"打算派给谁"判定：未分配（res 为空）的任务协作者也能建。
    // 必须归一为 []：`taskMine` 对非数组 res 返回 false，若某个调用点不传 res
    // 就会把"建未指派任务"判成"改别人的任务"而抛错（与 saveTask 的 (draft.res)||[] 同口径）。
    assertEditable(true, { kind: 'taskNew', res: opts.res || [] });
    const mo = (getState().modules || []).find(m => m.name === opts.mod);
    if (!mo) throw new Error('需求不存在：' + opts.mod);
    const p = opts.p || 'dev';
    const id = opts.id || genTaskId(mo.name, p);
    const manual = opts.manual !== false;   // 默认手动锁定，避免被一键自动计划冲掉
    const start = opts.start || fmt(getState().start);
    if (opts.type === 'ms') {
      mo.bars.push({
        id, m: fmt(F(start)), p,
        // 未填名字时用阶段名兜底：'需求名 里程碑' 在图上会被剥掉需求名前缀、只剩「里程碑」，
        // 完全看不出这个卡点是什么；阶段名（需求确认/提测/上线）至少有业务含义
        label: (opts.name || '').trim() || (PNAME[p] || '里程碑'),
        dep: [], manual, ignore: false
      });
    } else {
      // dur = 工作量（人天/工作日），结束日从开始日起完成 dur 个工作日（自动跳过周末/节假日）
      const dur = Math.max(1, Math.round(opts.dur || 1));
      const s0 = F(start);
      const bar = {
        id, p,
        s: fmt(s0), e: fmt(W.addWorkdays(s0, dur)),
        w: dur, res: (opts.res || []).slice(), dep: [], manual, ignore: false
      };
      const n = (opts.name || '').trim();
      if (n) bar.name = n;
      mo.bars.push(bar);
    }
    ctx.collect();
    ctx.save();
    return id;
  }

  // 新增需求：自动创建所选阶段任务和里程碑（opts.autoCreate = false 可跳过，仅创建空需求）
  // opts.phases: 可选，指定要初始化的阶段 key 数组（按传入顺序创建）。缺省时初始化全部阶段。
  function addModule(opts) {
    assertEditable(true, { kind: 'moduleNew' });  // 只读模式下新增需求抛错
    const name = (opts.name || '').trim();
    if (!name) throw new Error('需求名称不能为空');
    if ((getState().modules || []).some(m => m.name === name)) throw new Error('需求已存在：' + name);
    const mo = {
      name,
      tag: (opts.tag || '').trim() || '待启动',
      tagc: opts.tagc || '#3b82f6',
      // 提出信息与生命周期（设计文档 §3）：
      //   · 提出人 trim 后空串归一为 undefined（与 desc / docUrl 同口径）
      //   · 提出时间只接受 YYYY-MM-DD，挡掉手改 JSON / 外部导入的脏值
      //   · lifecycle 不做默认值 —— 默认「待确认」由新建弹窗给。
      //     与 pri 的取舍不同：pri 有明确中位档（P2），生命周期没有；
      //     且老数据必须能原样保留「未设置」，数据层不能替用户臆造
      proposedBy: (opts.proposedBy || '').trim() || undefined,
      proposedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(opts.proposedAt || '')) ? String(opts.proposedAt) : undefined,
      lifecycle: normalizeLifecycle(opts.lifecycle) || undefined,
      // 优先级：新建时给默认值（未传或非法值都落到 PRIORITY_DEFAULT），
      // 历史数据没有该字段则保持 undefined = 未设置，不替用户补值
      pri: normalizePriority(opts.pri) || PRIORITY_DEFAULT,
      // 描述与需求文档：给领导 / 业务看的重内容，空串归一为 undefined（= 未填写）
      desc: (opts.desc || '').trim() || undefined,
      docUrl: (opts.docUrl || '').trim() || undefined,
      bars: []
    };
    // 需求归属人（设计文档 §4.2）：默认 = 当前登录用户对应的人名。
    //   有归属 → 该人对这个需求有全部权限（改名/删除/归档/转交）
    //   没配人名 / 老数据缺失 → 不写该字段 = 无主，归属级操作仅项目所属人·管理员，不臆造归属
    // 注意：这里必须「空值就不写字段」，不能写成字面量里的 `owner: ... || undefined`——
    //   那样键仍然存在（只是值为 undefined），与 desc / docUrl 等同类字段「空则不写」的口径不一致，
    //   也会让下游 'owner' in mo 这类存在性判断误判为「有归属」
    const owner = (opts.owner != null ? String(opts.owner) : String(userStore.state.resourceName || '')).trim();
    if (owner) mo.owner = owner;
    // 支持新建时直接标记为待排期（尚未排期，只登记需求）
    if (opts.unscheduled) mo.unscheduled = true;
    // 自动创建所选阶段任务和里程碑（opts.autoCreate 默认 true）
    const newIds = [];   // 本次新建的任务/里程碑 id，用于创建后立即局部重排
    if (opts.autoCreate !== false) {
      // 默认从「今天」开始（而非项目起始日）：新建需求表达的是"从现在起开始推进"
      const startDate = opts.start ? F(opts.start) : fmt(new Date());
      // 自定义阶段：仅使用 opts.phases 中的有效阶段（去重、按给定顺序）；缺省则用默认模板阶段
      let phases;
      if (Array.isArray(opts.phases) && opts.phases.length) {
        const seen = new Set();
        phases = opts.phases.filter(p => PNAME[p] && !seen.has(p) && (seen.add(p), true));
      } else {
        phases = MODULE_PHASES.filter(p => PNAME[p]);
      }
      let prevId = null;
      let sitId = null;    // 测试(SIT) 任务 id：提测里程碑的前置
      phases.forEach((p, i) => {
        const id = genTaskId(name, p);
        const d = fmt(addDays(F(startDate), i));
        // 首个任务手动锁定（作为整条链的锚点，日期即用户指定的开始日）；
        // 其余阶段设为自动，由依赖+资源自动顺延，无需手工逐条挪动
        const manual = i === 0;
        const dep = prevId ? [{ id: prevId, lag: 0 }] : [];
        if (MODULE_MILESTONE_PHASES.includes(p)) {
          // 里程碑阶段（如「需求确认」）：0 天单点卡点，不占工期、无资源
          mo.bars.push({ id, m: d, p, label: PNAME[p], dep, manual, ignore: false });
        } else {
          mo.bars.push({ id, p, s: d, e: d, w: 1, res: [], dep, manual, ignore: false });
        }
        if (p === 'sit') sitId = id;
        newIds.push(id);
        prevId = id;
      });
      // 提测里程碑：前置任务 = 测试(SIT)，自动模式跟随 SIT 结束日顺延（未初始化 SIT 阶段时不创建）
      // label 只写业务名（"提测"）：需求名已由甘特行标题/汇报卡片前缀体现，重复拼接会显示成「需求 · 需求 提测」
      if (sitId) {
        const ticeId = genTaskId(name, 'tice');
        mo.bars.push({
          id: ticeId, m: fmt(F(startDate)), p: 'sit',
          label: '提测',
          dep: [{ id: sitId, lag: 0 }],
          manual: false, ignore: false
        });
        newIds.push(ticeId);
      }
      // 上线里程碑：位于最后一个阶段之后（自动模式，跟随最后阶段自动调整上线日）
      const msId = genTaskId(name, 'ms');
      const msDate = fmt(addDays(F(startDate), phases.length));
      mo.bars.push({
        id: msId, m: msDate, p: 'go',
        label: '上线',
        dep: prevId ? [{ id: prevId, lag: 0 }] : [],
        manual: false, ignore: false
      });
      newIds.push(msId);
    }
    getState().modules.push(mo);
    ctx.collect();
    // 仅重排本需求新建的任务：让自动阶段落到依赖允许的最早工作日（跳过周末/节假日），
    // 否则会沿用"逐日 +1"的占位日期，把任务排在周末上并制造依赖冲突
    if (newIds.length) ctx.recomputeAffected(new Set(newIds));
    ctx.save();
    return mo;
  }

  // 修改需求信息：支持改名称/标签/颜色/优先级/描述/需求文档
  // 改名时会同步更新该需求下全部任务条的 mod 引用（collect 写回），保证依赖索引一致
  function updateModule(opts) {
    const mo = (getState().modules || []).find(m => m.name === (opts.oldName || opts.name));
    if (!mo) return;

    // 归属级字段（改名 / 转交归属）单独把关，错误信息要指对方向 ——
    // 混在字段级里会报成笼统的"只读模式"，用户不知道是哪一步被拦了
    const c = permCtx();
    const renaming = opts.name != null && (opts.name || '').trim() !== mo.name;
    if ((renaming || 'owner' in opts) && !canManageModule(mo, c)) {
      throw new Error(renaming
        ? '无权重命名该需求：该需求不是你创建的'
        : '无权转交该需求：该需求不是你创建的');
    }
    if (!assertEditable(false, { kind: 'moduleFields' })) return;
    if (opts.name != null) {
      const newName = (opts.name || '').trim();
      if (!newName) throw new Error('需求名称不能为空');
      if (newName !== mo.name && (getState().modules || []).some(m => m.name === newName)) throw new Error('需求已存在：' + newName);
      // 版本成员是用需求名引用的 → 改名必须同步版本名单，
      // 否则该需求会从版本里"凭空消失"（版本卡少一个成员，且无任何报错）
      if (newName !== mo.name) {
        const oldName = mo.name;
        (getState().versions || []).forEach(v => {
          if (v && Array.isArray(v.mods)) v.mods = v.mods.map(n => (n === oldName ? newName : n));
        });
      }
      mo.name = newName;
    }
    if (opts.tag != null) mo.tag = (opts.tag || '').trim() || '待启动';
    if (opts.tagc != null) mo.tagc = opts.tagc || '#3b82f6';
    // 提出信息与生命周期：传空串 / 非法值 = 清除（回到"未填写 / 未设置"），
    // 与 desc / docUrl 的归一化口径一致（字段直接 delete，不留空串）
    if (opts.proposedBy != null) {
      const by = (opts.proposedBy || '').trim();
      if (by) mo.proposedBy = by; else delete mo.proposedBy;
    }
    if (opts.proposedAt != null) {
      const at = String(opts.proposedAt || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(at)) mo.proposedAt = at; else delete mo.proposedAt;
    }
    if ('lifecycle' in opts) {
      const lc = normalizeLifecycle(opts.lifecycle);
      if (lc) mo.lifecycle = lc; else delete mo.lifecycle;
    }
    // 优先级：传 null/'' 表示清除（回到「未设置」），传非法值按清除处理
    if (opts.pri != null || 'pri' in opts) mo.pri = normalizePriority(opts.pri);
    // 需求归属转交（归属级操作，权限见 Task 7）：传空串 = 清除（回到无主），
    // 与 desc / docUrl 的"传空串 = 清除"口径一致（字段直接 delete，不留空串）
    if ('owner' in opts) {
      const ow = String(opts.owner || '').trim();
      if (ow) mo.owner = ow; else delete mo.owner;
    }
    // 排期状态（人工）：true = 待排期。待排期需求不在总览展示排期，也不计入并行/逾期统计
    if (opts.unscheduled != null) {
      const wasUnscheduled = !!mo.unscheduled;
      mo.unscheduled = !!opts.unscheduled;
      // 待排期 → 已排期：日期终于可信，此时才把版本上线日钉上（见 applyVersionMods 的跳过逻辑）
      if (wasUnscheduled && !mo.unscheduled) {
        const v = (getState().versions || []).find(x => x && (x.mods || []).includes(mo.name));
        if (v) {
          // 先钉再 collect：补建的上线里程碑要先进索引，collectAffected 才认得出它的后置
          const msId = pinModToDate(mo, v.date);
          ctx.collect();
          ctx.recomputeAffected(ctx.collectAffected(msId).affected);
        }
      }
    }
    // 描述与需求文档：传空串 = 清除（回到"未填写"），与 tag 的归一化口径一致
    if ('desc' in opts) {
      const d = (opts.desc || '').trim();
      if (d) mo.desc = d; else delete mo.desc;
    }
    if ('docUrl' in opts) {
      const u = (opts.docUrl || '').trim();
      if (u) mo.docUrl = u; else delete mo.docUrl;
    }
    ctx.collect();  // 重建索引（写回任务的 mod 引用）
    ctx.save();
    return mo;
  }

  // 归档 / 取消归档需求：归档需求数据保留在 state.modules 中（导出/同步/撤销不丢数据），
  // 仅由渲染层过滤，不再出现在排期视图中；归档后需求只读，需先取消归档才能继续编辑其任务。
  function archiveModule(name, archived) {
    const mo = (getState().modules || []).find(m => m.name === name);
    if (!mo) return null;
    if (!assertEditable(false, { kind: 'module', mo })) return null;
    mo.archived = !!archived;
    mo.archivedAt = archived ? new Date().toISOString() : null;
    ctx.collect();
    ctx.save();
    return mo;
  }

  // 删除需求及其全部任务；同时清理其他需求任务对该需求、以及该需求各任务互相/对外部的依赖引用
  function deleteModule(name) {
    const mods = getState().modules || [];
    const idx = mods.findIndex(m => m.name === name);
    if (idx < 0) return;
    const mo = mods[idx];
    if (!assertEditable(false, { kind: 'module', mo })) return;
    const goneIds = new Set(mo.bars.map(b => b.id));
    mods.splice(idx, 1);
    // 版本成员用需求名引用 → 需求被删时同步清理，避免版本卡里挂着一个不存在的成员
    (getState().versions || []).forEach(v => {
      if (v && Array.isArray(v.mods)) v.mods = v.mods.filter(n => n !== name);
    });
    // 清理所有剩余任务对被删成员/被删需求任务的依赖
    mods.forEach(m => m.bars.forEach(b => {
      if (b.dep) b.dep = b.dep.filter(d => !goneIds.has(d.id));
    }));
    ctx.collect();
    ctx.save();
  }

  // ============ 版本（迭代）管理 ============
  // 语义（与用户确认）：迭代 = 版本，给一组需求一个「权威上线日」。
  //   · 加入版本 → 把该需求的「上线」里程碑钉到版本日（**写数据**）：
  //     于是图上的红色菱形、任务抽屉、总览「里程碑一览」、导出/同步、撤销栈全部自动一致；
  //     若改成"渲染/排期时临时覆盖"，就要同步改 5 个读 m 的地方，迟早显示成两个日期。
  //   · 改版本日 → 批量回写；移出/删版本 → 解锁回「跟着任务链自动算」（不还原旧日期）。
  //   · 排期引擎保持正向（不做反向排期）。
  // versions 是 state 的顶层数组：新增/修改时别忘了同步各白名单出口（persistence / plan-sync / history）。

  const versions = () => {
    if (!Array.isArray(getState().versions)) setState({ versions: [] });
    return getState().versions;
  };
  const findVersionRaw = id => versions().find(v => v && v.id === id) || null;
  const modByName = name => (getState().modules || []).find(m => m.name === name) || null;

  // 把需求的上线日钉到 dateStr，返回被钉里程碑的 id（供级联重算用）。
  // 没有「上线」里程碑（自定义阶段时没建 / 被删过）→ 补建一个，依赖挂到该需求最后一个普通任务上，
  // 这样将来解锁后还能由引擎算出合理日期，而不是留一个没有依赖的孤儿里程碑。
  function pinModToDate(mo, dateStr) {
    let ms = findGoMs(mo);
    if (!ms) {
      const last = [...(mo.bars || [])].reverse().find(b => !b.m);
      ms = {
        id: genTaskId(mo.name, 'go'), p: 'go', label: '上线',
        m: fmt(F(dateStr)), dep: last ? [{ id: last.id, lag: 0 }] : [],
        manual: true, ignore: false
      };
      mo.bars.push(ms);
    }
    ms.m = fmt(F(dateStr));
    ms.manual = true;   // 钉住：一键自动计划不会再改动它（否则版本日会被自动重排冲掉）
    return ms.id;
  }

  // 解锁：回到「跟着任务链自动算」。刻意不还原加入版本前的旧日期（不存快照）——
  // 用户要的是"不再受版本约束"，回到自动语义即可，恢复一个历史日期只会更费解。
  function unpinMod(mo) {
    const ms = findGoMs(mo);
    if (!ms || !ms.manual) return null;
    ms.manual = false;
    // ⚠️ 默认数据/老数据的上线里程碑**没有依赖**，而引擎对"自动但无依赖"的里程碑是保持现状，
    // 于是解锁后日期会永远卡在版本日 —— 看起来像解锁失败。补一条到「最后一个普通任务」的依赖，
    // 才是真正意义上的"跟着任务自动算"。
    if (!(ms.dep || []).length) {
      const last = [...(mo.bars || [])].reverse().find(b => !b.m);
      if (last && last.id) ms.dep = [{ id: last.id, lag: 0 }];
    }
    return ms.id;
  }

  // 收敛版本成员名单（新增/移除/换期后统一走这里）：
  //   进入名单 → 钉上线日；离开名单 → 解锁；名单外的一概不动
  // 返回 { touched: [被钉的里程碑 id], rejected: [{name, reason}] }
  function applyVersionMods(v, names) {
    const owner = versionOfMap(versions());
    const next = [];
    const rejected = [];
    const seen = new Set();
    (names || []).forEach(name => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      const mo = modByName(name);
      if (!mo) { rejected.push({ name, reason: '需求不存在' }); return; }
      if (mo.archived) { rejected.push({ name, reason: '已归档需求不能加入版本' }); return; }
      const ow = owner[name];
      if (ow && ow.id !== v.id) { rejected.push({ name, reason: `已在版本「${ow.name}」中` }); return; }
      next.push(name);
    });

    // 移出名单的：解锁上线日
    const touched = [];
    (v.mods || []).forEach(name => {
      if (next.includes(name)) return;
      const mo = modByName(name);
      if (mo) touched.push(unpinMod(mo));
    });
    // 留在名单里的：钉到当前版本日（改期后也靠这一步回写）
    next.forEach(name => {
      const mo = modByName(name);
      if (!mo) return;
      // 待排期需求的日期本来就不可信 → 先只登记成员，不钉日；
      // 等它被改成「已排期」时再由 updateModule 补钉（见那里注释）
      if (mo.unscheduled) return;
      touched.push(pinModToDate(mo, v.date));
    });
    v.mods = next;
    return { touched: touched.filter(Boolean), rejected };
  }

  // 被钉过上线日的里程碑，其时间变化会波及依赖它的任务（回归验证这类收口任务）→ 统一级联一次
  function cascadeFrom(ids) {
    if (!ids || !ids.length) return { pinned: [] };
    ctx.collect();
    const affected = new Set();
    const pinned = [];
    ids.forEach(id => {
      const r = ctx.collectAffected(id);
      r.affected.forEach(x => affected.add(x));
      r.pinned.forEach(x => { if (!pinned.includes(x)) pinned.push(x); });
    });
    ctx.recomputeAffected(affected);
    return { pinned };
  }

  // 新建版本：名称唯一、上线日必填；opts.mods 可一次性带上成员（弹窗里勾选）
  function createVersion(opts) {
    assertEditable(true, { kind: 'version' });  // 只读模式下新增版本抛错
    const name = ((opts && opts.name) || '').trim();
    if (!name) throw new Error('版本名称不能为空');
    if (!opts.date) throw new Error('请选择上线日');
    if (versions().some(v => v.name === name)) throw new Error('版本已存在：' + name);
    const v = {
      id: newVersionId(), name, date: fmt(F(opts.date)),
      shipped: false, shippedAt: null, mods: []
    };
    versions().push(v);
    const r = applyVersionMods(v, opts.mods || []);
    cascadeFrom(r.touched);
    ctx.save();
    return { version: v, rejected: r.rejected };
  }

  // 修改版本：改名 / 改期 / 改成员名单（三者共用同一个弹窗）
  function updateVersion(id, patch) {
    if (!assertEditable(false, { kind: 'version' })) return null;
    const v = findVersionRaw(id);
    if (!v) return null;
    const p = patch || {};
    if (p.name != null) {
      const nm = String(p.name).trim();
      if (!nm) throw new Error('版本名称不能为空');
      if (versions().some(x => x.id !== v.id && x.name === nm)) throw new Error('版本已存在：' + nm);
      v.name = nm;
    }
    const dateChanged = p.date != null && fmt(F(p.date)) !== v.date;
    if (dateChanged) v.date = fmt(F(p.date));
    // 实际上线日：只对"已标记上线"的版本有意义（编辑弹窗里那一行也是按这个前提显示的）
    if (p.shippedAt != null && v.shipped && p.shippedAt) v.shippedAt = fmt(F(p.shippedAt));
    let rejected = [];
    let touched = [];
    if ('mods' in p) {
      const r = applyVersionMods(v, p.mods);
      touched = r.touched;
      rejected = r.rejected;
    } else if (dateChanged) {
      // 只改期：把新上线日回写给所有成员（待排期的成员跳过，与 applyVersionMods 同口径）
      (v.mods || []).forEach(name => {
        const mo = modByName(name);
        if (mo && !mo.unscheduled) touched.push(pinModToDate(mo, v.date));
      });
      touched = touched.filter(Boolean);
    }
    cascadeFrom(touched);
    ctx.save();
    return { version: v, rejected };
  }

  // 标记已上线 / 取消标记。实际发版日期可传（缺省今天）——「计划 vs 实际」是版本管理最有用的一个数
  function shipVersion(id, shipped, shippedAt) {
    if (!assertEditable(false, { kind: 'version' })) return null;
    const v = findVersionRaw(id);
    if (!v) return null;
    v.shipped = !!shipped;
    v.shippedAt = shipped ? fmt(F(shippedAt || new Date())) : null;
    ctx.save();
    return v;
  }

  // 删除版本：成员全部解锁（上线日回到自动跟随任务链），版本本身移除
  function deleteVersion(id) {
    if (!assertEditable(false, { kind: 'versionDelete' })) return;
    const list = versions();
    const idx = list.findIndex(v => v && v.id === id);
    if (idx < 0) return;
    const v = list[idx];
    const touched = [];
    (v.mods || []).forEach(name => {
      const mo = modByName(name);
      if (mo) touched.push(unpinMod(mo));
    });
    list.splice(idx, 1);
    cascadeFrom(touched.filter(Boolean));
    ctx.save();
  }

  // 把某条需求从版本移出（等价于"成员名单减一项"）
  function removeModFromVersion(id, name) {
    const v = findVersionRaw(id);
    if (!v) return null;
    return updateVersion(id, { mods: (v.mods || []).filter(n => n !== name) });
  }

  // 直接给某条需求改归属版本（需求台账「所属版本」行内下拉的落点）。
  //
  // 为什么需要它：改归属原先只能进版本弹窗里"先取消勾选、再去另一个版本勾选"——
  // 两步且中间态是"无版本"，容易只做一半。这里一次做完两边的名单变更。
  //
  // 语义 = 移出旧版本 + 加入新版本（versionId 传空 = 只移出）：
  //   · 移出 → 解锁上线日（回落到跟随任务链自动算）；
  //   · 加入 → 把上线里程碑钉到新版本日（与 applyVersionMods 同一套 pinModToDate）。
  // 不能复用 updateVersion(id, {mods})：它的 applyVersionMods 会拒绝"已在别的版本"的需求，
  // 于是必须先移出再移入 —— 那正是这里要替用户省掉的两步。
  // 返回 { from, to, changed }，供调用方出提示文案。
  function setModuleVersion(name, versionId) {
    if (!assertEditable(false, { kind: 'version' })) return null;
    const mo = modByName(name);
    if (!mo) return null;
    const cur = versionOfMod(getState(), name);
    const target = versionId ? findVersionRaw(versionId) : null;
    if (versionId && !target) throw new Error('版本不存在，可能已被删除');
    // 同类操作重放（下拉选到当前值）不写数据：省掉一次无意义的历史快照
    if ((target && cur && cur.id === target.id) || (!target && !cur)) {
      return { from: cur, to: target, changed: false };
    }
    // 口径与 applyVersionMods 一致：归档 = 已收口，与"待上线"语义冲突
    if (target && mo.archived) throw new Error('已归档需求不能加入版本，请先取消归档');

    const touched = [];
    if (cur) cur.mods = (cur.mods || []).filter(n => n !== name);
    if (target) {
      // 待排期需求日期本来就不可信 → 先只登记成员，等改为「已排期」再由 updateModule 补钉
      // （待排期需求从未被钉过，故这里不需要先解锁）
      if (!mo.unscheduled) touched.push(pinModToDate(mo, target.date));
      target.mods = [...(target.mods || []), name];
    } else if (cur) {
      const msId = unpinMod(mo);
      if (msId) touched.push(msId);
    }
    cascadeFrom(touched.filter(Boolean));
    ctx.save();
    return { from: cur, to: target, changed: true };
  }

  // 一键归档本版本的全部需求：刻意**不**在"标记上线"时自动执行 ——
  // 上线后用户往往还要看几天进度，自动收口会让人找不到需求。返回实际归档的数量。
  function archiveVersionMods(id) {
    if (!assertEditable(false, { kind: 'versionArchive' })) return 0;
    const v = findVersionRaw(id);
    if (!v) return 0;
    const at = new Date().toISOString();
    let n = 0;
    (v.mods || []).forEach(name => {
      const mo = modByName(name);
      if (mo && !mo.archived) { mo.archived = true; mo.archivedAt = at; n++; }
    });
    ctx.collect();
    ctx.save();
    return n;
  }

  // 拖拽调整工作量（持续时间）：edge='l' 拖左边缘改开始日期，edge='r' 拖右边缘改结束日期；锁定手动并级联重算后置
  function resizeTask(taskId, edge, date) {
    const t = ctx.getTask(taskId);
    if (!t || t.isMs) return { pinned: [] };
    if (!assertEditable(false, { kind: 'task', task: t })) return { pinned: [] };
    const nd = F(date);
    if (edge === 'l') {
      if (nd > F(t.e)) return { pinned: [] };          // 不允许翻转到结束日期之后
      t.s = fmt(nd);
    } else {
      if (nd < F(t.s)) return { pinned: [] };          // 不允许翻转到开始日期之前
      t.e = fmt(nd);
    }
    t.manual = true;
    if (typeof t.w === 'number') t.w = W.workDays(t.s, t.e);   // 工作量（人天）
    const { affected, pinned } = ctx.collectAffected(taskId);
    ctx.recomputeAffected(affected);
    ctx.save();
    return { pinned };
  }

  // ---------- 资源库（人员 / 职位）管理 ----------
  // 任务通过 res:[姓名] 引用资源；改名时同步更新所有引用，保证数据一致
  function renameResourceRefs(oldName, newName) {
    getState().modules.forEach(mo => mo.bars.forEach(b => {
      if (Array.isArray(b.res)) {
        for (let i = 0; i < b.res.length; i++) {
          if (b.res[i] === oldName) b.res[i] = newName;
        }
      }
    }));
  }

  function updateResource(id, patch) {
    if (!assertEditable(false, { kind: 'resources' })) return;
    const r = (getState().resources || []).find(x => x.id === id);
    if (!r) return;
    if (patch.name != null && patch.name !== r.name) {
      renameResourceRefs(r.name, patch.name);
      r.name = patch.name;
    }
    if (patch.role != null) r.role = patch.role;
    if (patch.color != null) r.color = patch.color;
    ctx.save();
  }

  function addResource(res) {
    if (!assertEditable(false, { kind: 'resources' })) return null;
    if (!getState().resources) setState({ resources: [] });
    const r = {
      id: res.id || ('res_' + Date.now().toString(36)),
      name: (res.name || '').trim() || '新成员',
      role: (res.role || '').trim() || '未分配',
      color: res.color || ('#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'))
    };
    getState().resources.push(r);
    ctx.save();
    return r;
  }

  function deleteResource(id) {
    if (!assertEditable(false, { kind: 'resources' })) return;
    if (!getState().resources) return;
    const r = getState().resources.find(x => x.id === id);
    if (!r) return;
    setState({ resources: getState().resources.filter(x => x.id !== id) });
    renameResourceRefs(r.name, '__deleted__'); // 先更名避免残留
    getState().modules.forEach(mo => mo.bars.forEach(b => {
      if (Array.isArray(b.res)) b.res = b.res.filter(n => n !== '__deleted__');
    }));
    ctx.save();
  }

  // 回填 ctx，供其他模块（index/problems）复用
  ctx.nameOf = nameOf;
  ctx.assertEditable = assertEditable;

  return {
    assertEditable, nameOf,
    saveTask, moveMilestone, setMilestoneDate, changeTaskType,
    renameTask, setProgress, deleteTask, addTask, addModule, updateModule, archiveModule, deleteModule, moveModule, moveBar, resizeTask,
    // 版本（迭代）
    createVersion, updateVersion, shipVersion, deleteVersion, removeModFromVersion, setModuleVersion, archiveVersionMods,
    updateResource, addResource, deleteResource
  };
}
