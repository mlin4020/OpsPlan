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

  // 把一份 plan 写进 planStore 并重建索引 —— 加载 / 回滚共用同一段写入规则。
  // 只负责"写入 + 重建索引"，**不含**历史快照语义（resetHistory / recordInitial）：
  // 加载需要把历史洗净，回滚刻意保留历史（用户还能撤销回改动前），由调用方各自决定。
  // 抽出来的意义：resources 的"空数组即沿用旧值"这类回退规则只写一处，避免日后分叉。
  function applyPlanToStore(plan) {
    if (!Array.isArray(plan.modules)) {
      planStore.set({ modules: [], resources: [], versions: [] });
      return;
    }
    planStore.set({
      modules: plan.modules,
      resources: Array.isArray(plan.resources) && plan.resources.length ? plan.resources : planStore.state.resources,
      versions: Array.isArray(plan.versions) ? plan.versions : []
    });
    if (schedRef && typeof schedRef.collect === 'function') schedRef.collect();
    if (schedRef && typeof schedRef.applyCycle === 'function') schedRef.applyCycle();
  }

  function applyLoadedPlan(plan, savedBy, savedAt) {
    applyPlanToStore(plan);
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
          // 空排期：整份清空（历史也要重新起算）
          applyLoadedPlan(plan, plan.savedBy, plan.savedAt);
          return true;
        }
        if (plan.calcVer && plan.calcVer !== CALC_VER) return false;
        applyLoadedPlan(plan, plan.savedBy, plan.savedAt);
        return true;
      })
      .catch((e) => {
        notifySync('fail', { msg: e.message || '加载失败' });
        return false;
      });
  }

  // 并发保护：每次进入 pushToServer 自增，回滚响应回来时比对。
  // 场景：A 被拒 → 回滚请求在途 → 用户又改 B 并保存成功 → 回滚才返回" A 之前"的旧版本。
  // 若不过滤，这一次 set 会把刚存成功的 A+B 整体覆盖回旧数据，而库里是 A+B。
  // 因此过期的回滚响应直接丢弃（不写 store、不写 localStorage）。
  let epoch = 0;

  // 权限拒绝后的回滚：拉回服务器版本覆盖本地。
  // 刻意不复用 loadFromServer()：后者会 resetHistory/recordInitial，
  // 那会把"改坏了"的本地快照一起洗掉，用户就没法用撤销退回到改动前了。
  // 走 planStore.set / applyPlanToStore 而不是 ctx.save()，因此不会再触发一次 pushToServer（不会死循环）。
  // 返回 Promise<boolean>：true 表示已成功回滚（调用方据此给用户准确结论）。
  function rollbackFromServer(myEpoch) {
    const projectId = userStore.state.projectId;
    if (!projectId) return Promise.resolve(false);
    const stale = () => myEpoch !== undefined && myEpoch !== epoch;
    if (stale()) return Promise.resolve(false);

    return loadPlan(projectId)
      .then(({ data, error }) => {
        if (stale()) return false;        // 期间又发生了新的保存 → 旧快照已无意义
        if (error || !data) return false;
        const plan = data.plan || data;
        if (!Array.isArray(plan.modules)) return false;
        applyPlanToStore(plan);
        // 把服务器版本落回 localStorage 兜底：persistence.save() 在推送**之前**就把
        // 被拒的 plan 写进了 localStorage，只改内存会让离线打开/加载失败时看到被拒的改动。
        // 走 persistLocal() 而非 ctx.save()：只写本地、不推送（推送会死循环）。
        if (schedRef && typeof schedRef.persistLocal === 'function') {
          try { schedRef.persistLocal(); } catch (e) { /* 兜底写入失败不影响回滚结论 */ }
        }
        return true;
      })
      .catch(() => false);
  }

  function pushToServer() {
    const projectId = userStore.state.projectId;
    if (!projectId || userStore.state.readonly) return Promise.resolve(false);

    const myEpoch = ++epoch;
    const payload = buildPayload({ planStore, userStore });
    return savePlan(projectId, payload)
      .then(({ error }) => {
        if (error) {
          // 服务端校验拒绝是"乐观更新"架构下的常态路径：本地已经改过了、服务端不接受。
          // 必须回滚，否则界面显示的状态与库里不一致，用户会以为改成功了。
          if (isDenied(error)) {
            // 措辞只说"正在恢复"：此刻回滚请求还没回来，不能提前断言结果。
            notifySync('fail', { msg: errMsg(error) + '（正在恢复服务器版本，你的改动未保存）' });
            return rollbackFromServer(myEpoch).then((rolled) => {
              if (!rolled && myEpoch === epoch) {
                // 回滚失败（或没有可用的服务器版本）：界面上仍是那份被拒的改动，必须明说。
                // 过期则静默 —— 期间已有更新的保存，用户界面对齐的是新数据而非旧快照。
                notifySync('fail', { msg: '恢复服务器版本失败，请刷新页面' });
              }
              return false;
            });
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
