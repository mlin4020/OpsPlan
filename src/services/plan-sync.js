// ============================================================
// src/services/plan-sync.js — 排期数据与服务器的同步（loadFromServer / pushToServer）
// 由 gantt-scheduler.js 的 loadFromServer/pushToServer/buildPayload 迁移，
// 改造为：
//   - 经 projects.loadPlan/savePlan（getClient().from('projects')）访问服务端
//   - 读写 planStore（替代 window.MODULES/RESOURCES/START/END）
//   - 项目上下文来自 userStore.state（projectId / readonly / user）
//   - 通过注入的 onSyncStatus 回调上报同步状态（替代 window.SCHED.onSyncStatus）
//
// 用法：
//   const planSync = createPlanSync({ planStore, userStore, sched, onSyncStatus });
//   createScheduler({ planStore, userStore, W, sync: planSync });
//   planSync.loadFromServer()  /  planSync.pushToServer()  返回 Promise<boolean>
// ============================================================
import { loadPlan, savePlan, errMsg } from './projects.js';
import { fmt } from '../core/dates.js';

const CALC_VER = 5;   // 与 scheduler/index.js 的 CALC_VER 对齐

// 组装本地 + 服务端共享载荷（含项目时间窗口）
function buildPayload({ planStore, userStore }) {
  const st = planStore.state;
  const us = userStore.state;
  return {
    v: 1,
    calcVer: CALC_VER,
    savedAt: Date.now(),
    savedBy: (us.user && (us.user.email || us.user.display_name)) || '',
    start: st.start ? fmt(st.start) : undefined,
    end: st.end ? fmt(st.end) : undefined,
    modules: st.modules,
    resources: st.resources,
    // 版本（迭代）：顶层数组，必须显式带上 —— 载荷是白名单式的，
    // 漏了会出现"我这有版本、同事打开没有"却毫无报错的静默丢数据
    versions: st.versions
  };
}

export function createPlanSync({ planStore, userStore, sched, onSyncStatus }) {
  // 同步状态回调（可在创建后经 setSyncStatus 动态注入，解决 bindAll 依赖顺序问题）
  let statusFn = onSyncStatus || null;
  function setSyncStatus(fn) { statusFn = fn; }
  function notifySync(state, info) {
    if (typeof statusFn === 'function') {
      try { statusFn(state, info); } catch (e) { /* 忽略回调异常 */ }
    }
  }
  // 调度引擎引用（sched 在 createScheduler 之后回填，用于重建索引）
  let schedRef = sched || null;
  function setSched(s) { schedRef = s; }

  // 从服务器加载排期（成功写回 planStore 并重建索引；失败返回 false）
  function loadFromServer() {
    const projectId = userStore.state.projectId;
    if (!projectId) return Promise.resolve(false);
    return loadPlan(projectId)
      .then(({ data, error }) => {
        if (error || !data || !data.plan) return false;
        const plan = data.plan;
        // 空项目：plan 存在但 modules 为空数组（或缺失）→ 视为有效空项目（不回退默认数据）
        if (!Array.isArray(plan.modules)) {
          planStore.set({ modules: [], resources: [], versions: [] });
          if (schedRef && typeof schedRef.collect === 'function') schedRef.collect();
          if (schedRef && typeof schedRef.resetHistory === 'function') schedRef.resetHistory();
          if (schedRef && typeof schedRef.recordInitial === 'function') schedRef.recordInitial();
          notifySync('ok', { savedBy: plan.savedBy, savedAt: plan.savedAt });
          return true;
        }
        if (plan.calcVer !== CALC_VER) return false;   // 算法版本不符，服务端数据作废
        planStore.set({
          modules: plan.modules,
          resources: Array.isArray(plan.resources) && plan.resources.length ? plan.resources : planStore.state.resources,
          // 服务端老数据没有 versions（功能上线前保存的）→ 空列表；有则整体替换
          versions: Array.isArray(plan.versions) ? plan.versions : []
        });
        if (schedRef && typeof schedRef.collect === 'function') schedRef.collect();
        // 项目周期自动推导：以后端任务日期为准，忽略服务器保存的历史 start/end
        if (schedRef && typeof schedRef.applyCycle === 'function') schedRef.applyCycle();
        // 重置历史，以服务器数据为初始快照
        if (schedRef && typeof schedRef.resetHistory === 'function') schedRef.resetHistory();
        if (schedRef && typeof schedRef.recordInitial === 'function') schedRef.recordInitial();
        notifySync('ok', { savedBy: plan.savedBy, savedAt: plan.savedAt });
        return true;
      })
      .catch(() => false);
  }

  // 推送当前数据到服务端（只读项目不推送）
  function pushToServer() {
    const projectId = userStore.state.projectId;
    if (!projectId || userStore.state.readonly) return Promise.resolve(false);
    const payload = buildPayload({ planStore, userStore });
    return savePlan(projectId, payload)
      .then(({ error }) => {
        if (error) {
          notifySync('fail', { msg: errMsg(error) });
          return false;
        }
        notifySync('ok', { savedBy: payload.savedBy, savedAt: payload.savedAt });
        return true;
      })
      .catch(() => {
        notifySync('fail', { msg: '无法连接服务器' });
        return false;
      });
  }

  return { loadFromServer, pushToServer, setSyncStatus, setSched };
}

export default createPlanSync;
