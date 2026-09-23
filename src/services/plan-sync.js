// ============================================================
// plan-sync.js — 排期数据与服务器的同步（loadFromServer / pushToServer）
// 统一走 backend.loadPlan / savePlan，不感知具体后端实现
// ============================================================
import { loadPlan, savePlan, errMsg } from './projects.js';
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
