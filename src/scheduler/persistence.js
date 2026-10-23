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
      resources: getState().resources,
      versions: getState().versions
    };
  }

  // 只写 localStorage 兜底、**不**推送服务端。
  //   save() 的防抖回调里：先 persistLocal() 再 pushToServer()；
  //   plan-sync 回滚成功后也调它，把服务器版本落回本地兜底 —— 否则 localStorage 里
  //   留着那份"被服务端拒绝的 plan"，离线打开或服务端加载失败时用户会看到被拒的改动。
  //   ⚠️ 回滚链路**绝不能**改调 ctx.save()：那会再推一次 → 被拒 → 再回滚，死循环。
  //   ⚠️ 载荷与 buildPayload() 有**已知的不对称**：这里不含 savedBy / start / end，
  //      而 load() 也只读 modules/resources/versions —— 本地兜底不承载"谁保存、什么周期"。
  //      这是改造前 save() 内联版本就有的形状，此处忠实保留；若要补齐必须同时改 load()。
  function persistLocal() {
    try {
      localStorage.setItem(ctx.KEY(), JSON.stringify({
        v: 1, calcVer: ctx.CALC_VER, savedAt: Date.now(),
        modules: getState().modules,
        resources: getState().resources,
        versions: getState().versions
      }));
      return true;
    } catch (e) { return false; }  // 忽略写入失败（隐私模式/配额满）
  }

  let saveTimer = null;
  function save() {
    // 立即通知订阅者重绘（store 驱动渲染层感知变更）
    setState({ modules: getState().modules, resources: getState().resources, versions: getState().versions });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // 1) 本地兜底：始终写入 localStorage（离线/未配置 Supabase 也不中断）
      persistLocal();
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
        // 老缓存没有 versions 字段（功能上线前的数据）→ 视为空版本列表，不做迁移
        setState({ versions: Array.isArray(data.versions) ? data.versions : [] });
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
    const versions = JSON.parse(JSON.stringify(getState().versions || []));
    return JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), modules: clean, resources, versions }, null, 2);
  }

  function importJSON(json) {
    ctx.assertEditable(true, { kind: 'plan' });  // 只读模式下导入抛错
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || !Array.isArray(data.modules) || !data.modules.length) throw new Error('无效的排期数据文件');
    setState({ modules: data.modules });
    if (Array.isArray(data.resources) && data.resources.length) setState({ resources: data.resources });
    // 版本随数据文件一起导入；文件里没有就清空（导入是"整份替换"语义，不能残留旧版本）
    setState({ versions: Array.isArray(data.versions) ? data.versions : [] });
    ctx.collect();
    ctx.save();
    // 导入后重置历史，以当前导入状态为初始快照
    if (ctx.recordInitial) ctx.recordInitial();
  }

  // 重置为数据文件默认值
  function resetToDefault() {
    if (!ctx.assertEditable(false, { kind: 'plan' })) return;
    localStorage.removeItem(ctx.KEY());
    setState({ modules: ctx.DEFAULT_MODULES, resources: ctx.DEFAULT_RESOURCES, versions: [] });
    ctx.collect();
    // 重置后重置历史，以默认数据为初始快照
    if (ctx.recordInitial) ctx.recordInitial();
  }

  return { save, persistLocal, load, buildPayload, exportJSON, importJSON, resetToDefault };
}
