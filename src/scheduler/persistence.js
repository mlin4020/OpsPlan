// ============================================================
// src/scheduler/persistence.js — 持久化（localStorage 兜底 + 数据序列化）
// 由 gantt-scheduler.js 661-778 行迁移
//   save(): 防抖写入 localStorage（离线可用）+ 触发 ctx.pushToServer 服务端同步
//   load(): 读取并校验 calcVer
//   buildPayload(): 组装本地+服务端共享载荷
//   exportJSON/importJSON/resetToDefault: 数据序列化/导入/重置
// ctx 提供 getState/setState/KEY/CALC_VER/collect/assertEditable/pushToServer 等
// ============================================================
import { fmt } from '../core/dates.js';
import { userStore } from '../store/user-store.js';

export function createPersistence(ctx) {
  const { getState, setState } = ctx;

  // 组装本地+服务端共享的载荷（含项目时间窗口）
  function buildPayload() {
    const u = userStore.state.user;
    return {
      v: 1, calcVer: ctx.CALC_VER, savedAt: Date.now(),
      savedBy: (u && (u.email || u.displayName)) || '',
      start: getState().start ? fmt(getState().start) : undefined,
      end: getState().end ? fmt(getState().end) : undefined,
      modules: getState().modules,
      resources: getState().resources
    };
  }

  let saveTimer = null;
  function save() {
    // 立即通知订阅者重绘（store 驱动渲染层感知变更）
    setState({ modules: getState().modules, resources: getState().resources });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // 1) 本地兜底：始终写入 localStorage（离线/未配置 Supabase 也不中断）
      try {
        localStorage.setItem(ctx.KEY(), JSON.stringify({
          v: 1, calcVer: ctx.CALC_VER, savedAt: Date.now(),
          modules: getState().modules,
          resources: getState().resources
        }));
      } catch (e) { /* 忽略写入失败 */ }
      // 2) 服务端同步：仅项目模式 + Supabase 可用 + 非只读时推送（由注入的 pushToServer 决定）
      ctx.pushToServer();
    }, 300);
  }

  // 返回 true 表示成功从 localStorage 恢复
  function load() {
    try {
      const raw = localStorage.getItem(ctx.KEY());
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.modules) && data.modules.length && data.calcVer === ctx.CALC_VER) {
        setState({ modules: data.modules });
        if (Array.isArray(data.resources) && data.resources.length) setState({ resources: data.resources });
        // 加载后重置历史，以当前状态为初始快照
        if (ctx.recordInitial) ctx.recordInitial();
        return true;
      }
    } catch (e) { /* 数据损坏则回退默认 */ }
    return false;
  }

  function exportJSON() {
    // 导出时剥离运行时附加的 mod/isMs 字段，保持数据文件整洁
    const clean = getState().modules.map(mo => ({
      ...mo,
      bars: mo.bars.map(b => {
        const { mod, isMs, ...rest } = b;
        return rest;
      })
    }));
    const resources = (getState().resources || []).map(r => ({ ...r }));
    return JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), modules: clean, resources }, null, 2);
  }

  function importJSON(json) {
    ctx.assertEditable(true);  // 只读模式下导入抛错
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || !Array.isArray(data.modules) || !data.modules.length) throw new Error('无效的排期数据文件');
    setState({ modules: data.modules });
    if (Array.isArray(data.resources) && data.resources.length) setState({ resources: data.resources });
    ctx.collect();
    ctx.save();
    // 导入后重置历史，以当前导入状态为初始快照
    if (ctx.recordInitial) ctx.recordInitial();
  }

  // 重置为数据文件默认值
  function resetToDefault() {
    if (!ctx.assertEditable()) return;
    localStorage.removeItem(ctx.KEY());
    setState({ modules: ctx.DEFAULT_MODULES, resources: ctx.DEFAULT_RESOURCES });
    ctx.collect();
    // 重置后重置历史，以默认数据为初始快照
    if (ctx.recordInitial) ctx.recordInitial();
  }

  return { save, load, buildPayload, exportJSON, importJSON, resetToDefault };
}
