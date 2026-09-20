// ============================================================
// src/components/sync-status.js — 同步状态提示
// 由 gantt-app.js 的 setSync（1573-1583 行）迁移，改为依赖注入形态：
//   bindSetSync(deps) 创建并返回 setSync(state, info) 函数，
//   供 scheduler 的 onSyncStatus 钩子挂接（由 main-gantt 在 Task 5 接线）。
// 不读 window 全局；DOM 引用经 deps.syncInfo / deps.getEl 注入。
// ============================================================

// 创建 setSync 函数。deps: { syncInfo }（DOM 元素）或 { getEl }（按 id 取元素）
export function bindSetSync(deps) {
  const getInfo = () => (deps.syncInfo) || (deps.getEl ? deps.getEl('syncInfo') : null);

  function setSync(state, info) {
    const syncInfo = getInfo();
    if (!syncInfo) return;
    syncInfo.className = 'sync-info ' + (state === 'fail' ? 'fail' : state === 'ok' ? 'ok' : '');
    if (state === 'fail') {
      syncInfo.textContent = '未同步' + (info && info.msg ? ' · ' + info.msg : '');
    } else if (state === 'ok') {
      const who = info && info.savedBy ? ' · ' + info.savedBy + ' 保存' : '';
      const t = info && info.savedAt ? ' ' + new Date(info.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      syncInfo.textContent = '已同步' + t + who;
    }
  }

  return setSync;
}

export { bindSetSync as setSync };
