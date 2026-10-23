// ============================================================
// plan-sync.js — 排期数据与服务器的同步（loadFromServer / pushToServer）
// 统一走 backend.loadPlan / savePlan，不感知具体后端实现
// ============================================================
import { loadPlan, savePlan, errMsg, isDenied } from './projects.js';
import { fmt } from '../core/dates.js';

const CALC_VER = 5;

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
    versions: st.versions
  };
}

export function createPlanSync({ planStore, userStore, sched, onSyncStatus }) {
  let statusFn = onSyncStatus || null;
  function setSyncStatus(fn) { statusFn = fn; }
  function notifySync(state, info) {
    if (typeof statusFn === 'function') {
      try { statusFn(state, info); } catch (e) { /* 忽略回调异常 */ }
    }
  }
  let schedRef = sched || null;
  function setSched(s) { schedRef = s; }

  function applyLoadedPlan(plan, savedBy, savedAt) {
    if (!Array.isArray(plan.modules)) {
      planStore.set({ modules: [], resources: [], versions: [] });
    } else {
      planStore.set({
        modules: plan.modules,
        resources: Array.isArray(plan.resources) && plan.resources.length ? plan.resources : planStore.state.resources,
        versions: Array.isArray(plan.versions) ? plan.versions : []
      });
    }
    if (schedRef && typeof schedRef.collect === 'function') schedRef.collect();
    if (schedRef && typeof schedRef.applyCycle === 'function') schedRef.applyCycle();
    if (schedRef && typeof schedRef.resetHistory === 'function') schedRef.resetHistory();
    if (schedRef && typeof schedRef.recordInitial === 'function') schedRef.recordInitial();
    notifySync('ok', { savedBy: savedBy || '', savedAt: savedAt || Date.now() });
  }

  function loadFromServer() {
    const projectId = userStore.state.projectId;
    if (!projectId) return Promise.resolve(false);

    return loadPlan(projectId)
      .then(({ data, error }) => {
        if (error || !data) return false;
        // 飞书 backend 直接返回 plan 字段；Supabase 返回 {plan: {...}}
        const plan = data.plan || data;
        if (!Array.isArray(plan.modules)) {
          planStore.set({ modules: [], resources: [], versions: [] });
          if (schedRef && typeof schedRef.collect === 'function') schedRef.collect();
          if (schedRef && typeof schedRef.resetHistory === 'function') schedRef.resetHistory();
          if (schedRef && typeof schedRef.recordInitial === 'function') schedRef.recordInitial();
          notifySync('ok', { savedBy: plan.savedBy, savedAt: plan.savedAt });
          return true;
        }
        if (plan.calcVer && plan.calcVer !== CALC_VER) return false;
        planStore.set({
          modules: plan.modules,
          resources: Array.isArray(plan.resources) && plan.resources.length ? plan.resources : planStore.state.resources,
          versions: Array.isArray(plan.versions) ? plan.versions : []
        });
        if (schedRef && typeof schedRef.collect === 'function') schedRef.collect();
        if (schedRef && typeof schedRef.applyCycle === 'function') schedRef.applyCycle();
        if (schedRef && typeof schedRef.resetHistory === 'function') schedRef.resetHistory();
        if (schedRef && typeof schedRef.recordInitial === 'function') schedRef.recordInitial();
        notifySync('ok', { savedBy: plan.savedBy, savedAt: plan.savedAt });
        return true;
      })
      .catch((e) => {
        notifySync('fail', { msg: e.message || '加载失败' });
        return false;
      });
  }

  // 权限拒绝后的回滚：拉回服务器版本覆盖本地。
  // 刻意不复用 loadFromServer()：后者会 resetHistory/recordInitial，
  // 那会把"改坏了"的本地快照一起洗掉，用户就没法用撤销退回去了。
  // 走 planStore.set 而不是 ctx.save()，因此不会再触发一次 pushToServer（不会死循环）。
  function rollbackFromServer() {
    const projectId = userStore.state.projectId;
    if (!projectId) return;
    loadPlan(projectId)
      .then(({ data, error }) => {
        if (error || !data) return;
        const plan = data.plan || data;
        if (!Array.isArray(plan.modules)) return;
        planStore.set({
          modules: plan.modules,
          resources: Array.isArray(plan.resources) && plan.resources.length ? plan.resources : planStore.state.resources,
          versions: Array.isArray(plan.versions) ? plan.versions : []
        });
        if (schedRef && typeof schedRef.collect === 'function') schedRef.collect();
        if (schedRef && typeof schedRef.applyCycle === 'function') schedRef.applyCycle();
      })
      .catch(() => { /* 回滚都失败就只能等下次刷新，不额外报错打扰 */ });
  }

  function pushToServer() {
    const projectId = userStore.state.projectId;
    if (!projectId || userStore.state.readonly) return Promise.resolve(false);

    const payload = buildPayload({ planStore, userStore });
    return savePlan(projectId, payload)
      .then(({ error }) => {
        if (error) {
          // 服务端校验拒绝是"乐观更新"架构下的常态路径：本地已经改过了、服务端不接受。
          // 必须回滚，否则界面显示的状态与库里不一致，用户会以为改成功了。
          if (isDenied(error)) {
            notifySync('fail', { msg: errMsg(error) + '（已回滚到服务器版本，你的改动未保存）' });
            rollbackFromServer();
            return false;
          }
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
