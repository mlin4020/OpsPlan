// ============================================================
// src/scheduler/index.js — 调度引擎聚合工厂
// 组装 planning/mutations/problems/persistence，维护内部索引（tasks/tasksById/cycleTasks/problems）
// 由 gantt-scheduler.js 迁移：
//   collect()/getTask()（原 70-99 行）
//   通过共享 ctx 把索引与跨模块函数注入各子工厂，实现"纯计算、与 DOM/window 解耦"
// 导出 SCHED API：save/load/collect/getTask/topoSort/computeSchedule/cascade/...（签名与 window.SCHED 一致）
// loadFromServer/pushToServer 由外部注入的 sync 提供；未注入时 resolve false（本地兜底）
// ============================================================
import { createPlanning } from './planning.js';
import { createMutations } from './mutations.js';
import { detectProblems } from './problems.js';
import { createPersistence } from './persistence.js';
import { createCycle } from './cycle.js';
import { createHistory } from './history.js';
import { topoSort } from './topo.js';
import { F } from './planning.js';
import { fmt, addDays, diff } from '../core/dates.js';
import { defaultModules, defaultResources } from '../core/default-data.js';

export function createScheduler({ planStore, userStore, W, sync }) {
  const getState = () => planStore.state;
  const setState = patch => planStore.set(patch);

  // 持久化 KEY：多项目模式按 PROJECT_ID 隔离；无则用全局 KEY（兼容无参进入/测试）
  const KEY = () => (userStore.state.projectId ? 'sched-plan-' + userStore.state.projectId : 'sched-plan-v1');
  // calcVer：调度算法版本号。算法升级时 +1，旧的 localStorage 缓存自动作废（与源 CALC_VER 一致）
  const CALC_VER = 5;

  // ---------- 内部索引（任务条 + 查询 + 最近拓扑环/问题缓存） ----------
  const ctx = {
    getState, setState, W,
    tasks: [], tasksById: {}, cycleTasks: [], problems: [],
    KEY, CALC_VER,
    // 快照数据文件默认值，供 resetToDefault 使用（深拷贝隔离）
    DEFAULT_MODULES: defaultModules(),
    DEFAULT_RESOURCES: defaultResources()
  };

  // ---------- 数据访问 ----------
  function collect() {
    ctx.tasks = [];
    ctx.tasksById = {};
    getState().modules.forEach(mo => {
      mo.bars.forEach((b, idx) => {
        if (b.m) { // 里程碑：0 天单点，登记为可依赖目标并纳入排期（支持自动/手动）
          const id = b.id || (mo.name + '-ms' + idx);
          b.id = id;  // 把稳定 id 写回原始数据，便于拖拽/编辑回写
          b.mod = mo.name;
          b.isMs = true;
          if (b.manual === undefined) b.manual = true;  // 旧数据无 manual 字段 → 默认手动(固定日期)
          ctx.tasks.push(b);          // 直接引用原始对象：自动里程碑可被级联重排上线日 m
          ctx.tasksById[id] = b;
          return;
        }
        // 直接引用原始任务对象，保证调度重排、视图渲染、localStorage 持久化共享同一数据
        b.mod = mo.name;
        b.isMs = false;
        // 自愈：历史脏数据（如曾被里程碑降级流程改写的任务）可能没有 res，补空数组，
        // 否则 recomputeAffected 读 t.res.forEach 会抛 TypeError 并中断整个排期
        if (!Array.isArray(b.res)) b.res = [];
        ctx.tasks.push(b);
        if (b.id) ctx.tasksById[b.id] = b;
      });
    });
  }
  function getTask(id) { return ctx.tasksById[id] || null; }

  ctx.collect = collect;
  ctx.getTask = getTask;
  ctx.topoSort = topoSort;

  // ---------- 子工厂（按顺序创建，内部通过 ctx 回填共享依赖） ----------
  const planning = createPlanning(ctx);
  const mutations = createMutations(ctx);
  const persistence = createPersistence(ctx);
  const cycle = createCycle(ctx);
  const history = createHistory(ctx);

  // 在 persistence.save 前注入历史记录，ctx.recordBefore 供 persistence 调用
  ctx.recordBefore = history.recordBefore;
  ctx.resetHistory = history.reset;
  ctx.recordInitial = history.recordInitial;

  ctx.save = (skipHistory) => {
    if (!skipHistory) history.recordBefore();  // 记录当前（修改前）状态快照，然后持久化修改后的状态
    persistence.save();
    cycle.apply();   // 任务日期变更后自动重算项目周期
  };
  // 首次建立索引后立即记录初始快照 + 应用周期
  history.recordInitial();
  cycle.apply();

  // 撤销/重做
  function undo() {
    const ok = history.undo();
    if (ok) cycle.apply();
    return ok;
  }
  function redo() {
    const ok = history.redo();
    if (ok) cycle.apply();
    return ok;
  }

  // 检测
  const detect = () => detectProblems(ctx);

  // ---------- 服务端同步（sync 注入；未提供时本地兜底 resolve false） ----------
  const loadFromServer = (sync && typeof sync.loadFromServer === 'function')
    ? sync.loadFromServer
    : () => Promise.resolve(false);
  const pushToServer = (sync && typeof sync.pushToServer === 'function')
    ? sync.pushToServer
    : () => Promise.resolve(false);
  ctx.pushToServer = pushToServer;
  ctx.loadFromServer = loadFromServer;

  // 初始建索引（数据由调用方在 createScheduler 前通过 planStore.set 注入，或事后 load/import）
  collect();

  return {
    collect, getTask,
    nameOf: ctx.nameOf,
    topoSort,
    computeSchedule: planning.computeSchedule,
    cascade: planning.cascade,
    resolveAuto: planning.resolveAuto,
    resolveIgnore: planning.resolveIgnore,
    unignore: planning.unignore,
    saveTask: mutations.saveTask,
    previewCascade: planning.previewCascade,
    resizeTask: mutations.resizeTask,
    previewResize: planning.previewResize,
    moveMilestone: mutations.moveMilestone,
    setMilestoneDate: mutations.setMilestoneDate,
    changeTaskType: mutations.changeTaskType,
    renameTask: mutations.renameTask,
    deleteTask: mutations.deleteTask,
    addTask: mutations.addTask,
    addModule: mutations.addModule,
    updateModule: mutations.updateModule,
    archiveModule: mutations.archiveModule,
    deleteModule: mutations.deleteModule,
    moveModule: mutations.moveModule,
    moveBar: mutations.moveBar,
    // 版本（迭代）：创建/改期改名/标记上线/删除/移出成员/一键归档成员
    createVersion: mutations.createVersion,
    updateVersion: mutations.updateVersion,
    shipVersion: mutations.shipVersion,
    deleteVersion: mutations.deleteVersion,
    removeModFromVersion: mutations.removeModFromVersion,
    archiveVersionMods: mutations.archiveVersionMods,
    detectProblems: detect,
    save: (skipHistory) => persistence.save(skipHistory),
    load: persistence.load,
    loadFromServer,
    pushToServer,
    exportJSON: persistence.exportJSON,
    importJSON: persistence.importJSON,
    resetToDefault: persistence.resetToDefault,
    updateResource: mutations.updateResource,
    addResource: mutations.addResource,
    deleteResource: mutations.deleteResource,
    undo, redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    resetHistory: history.reset,
    recordBefore: history.recordBefore,
    tasks: () => ctx.tasks,
    problems: () => ctx.problems,
    cycleTasks: () => ctx.cycleTasks,
    tasksById: () => ctx.tasksById,
    applyCycle: cycle.apply,
    computeCycle: cycle.compute,
    // 渲染辅助
    fmt, addDays,
    // diff 保持与源 gantt-scheduler 契约一致（a - b，即"从 a 到 b 相差天数"的符号语义），
    // 与 core/dates.js 的 diff(b-a) 不同——app 层依赖 sched.diff(e,s) < 0 判断翻转。
    diff: (a, b) => Math.round((a - b) / 864e5),
    F
  };
}
