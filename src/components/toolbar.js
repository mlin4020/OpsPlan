// ============================================================
// src/components/toolbar.js — 工具栏事件绑定
// 由 gantt-app.js 迁移：
//   缩放（891-921）：applyZoom/setZoom/zs/zsl/滚轮缩放
//   折叠（923-927）：expAll/colAll
//   视图切换（929-942）：[data-view] 切换 + 汇报需求卡片下钻
//   数据（943-973）：自动计划/导出 JSON/导入 JSON
//   导出完整 HTML（975-1016）：buildFullHTML/exportHTML
//   排期平台（1544-1650）：服务器组/返回列表/刷新/同步状态/只读初始化
// 依赖注入（deps）：
//   sched/planStore/render/toast/getEl/gsc/doc
//   viewState：{ view, zoom, collapsed, dayW }（可变共享对象，render 读取）
//   setDayW(dw) / getZoom()：缩放读写
//   PNAME：阶段名映射（新增/视图用）
//   enterReadonly：只读初始化（来自 readonly.js）
//   onSyncStatus：同步状态钩子（来自 sync-status.js）
// ============================================================
import { $ } from '../utils/dom.js';
import { buildExportPayload, buildExportHTML, downloadFile } from '../utils/export.js';
import { expandAllMods, collapseAllMods } from '../core/mod-fold.js';
import { scrollDateToCenter } from './gantt-scroll.js';
import { userStore } from '../store/user-store.js';
import { ctxOf, isFull } from '../utils/permission.js';

// FULL_ONLY 组的**点击侧**守卫。
// 为什么 class 灰化不够：`.btn.disabled{pointer-events:none}` 只挡鼠标，而
//   · Ctrl+Z / Ctrl+Y 是键盘路径，根本不经过按钮；
//   · 任何"重新点亮 class"的代码（历史上 updateUndoRedoBtns 就干过类似的事）都会让灰化失效。
// 判据必须与 utils/readonly.js 的 refreshUI 同源（permission.isFull），不能在这里自己写 if/else，
// 否则口径分叉时会出现"灰着却能用"或"亮着却点不动"。
const fullOnlyAllowed = () => isFull(ctxOf(userStore.state));

// 在 FULL_ONLY 动作前统一调用：返回 false 表示当前身份无权，调用方直接 return
function guardFullOnly(deps) {
  if (fullOnlyAllowed()) return true;
  if (deps && deps.toast) deps.toast('该操作会改动整份排期，仅项目所属人或管理员可用');
  return false;
}

const ZOOM_DAYW = { day: 13, week: 15, month: 32 };
const MIN_DAYW = 2, MAX_DAYW = 40;

// 视图按钮激活态刷新
function syncViewBtns(deps) {
  deps.getEl('gantt').ownerDocument.querySelectorAll('[data-view]')
    .forEach(b => b.classList.toggle('on', b.dataset.view === deps.viewState.view));
}

// 非时间轴视图（总览 / 归档 / 资源工作视图）都是"整页文档"：不需要缩放/折叠/编辑/排期/数据等操作，
// 统一在 body 上打标记，由 gantt.css 把 shell.js 中带 data-report-hide 的区块整体隐藏 ——
// 只保留「视图切换」与 serverGroup（返回项目列表 / 从服务器刷新）。
//   · report-view：总览是纯汇报界面，hero 统计与自己的指标条重复，一并隐藏
//   · work-view  ：资源工作视图同理（自带指标条），hero 统计一并隐藏
//   · req-view   ：需求台账页同样收敛工具栏，但**保留 hero 统计**（它没有自己的指标条，藏了顶栏就空了）
function syncToolbarForView(deps) {
  const body = deps.doc && deps.doc.body;
  if (!body) return;
  const v = deps.viewState.view;
  body.classList.toggle('report-view', v === 'report');
  body.classList.toggle('work-view', v === 'work');
  body.classList.toggle('req-view', v === 'req');
  body.classList.toggle('version-view', v === 'version');
}

// 缩放是否对当前视图有意义：
// 甘特图 / 工作组规划器的时间轴由 dayW 驱动，缩放有效；
// 总览（百分比自适应版式）/ 归档页（卡片网格）/ 资源工作视图（按人清单）都没有时间轴 ——
// 既不受缩放按钮影响，也不应劫持 Ctrl+滚轮（此时用户多半是想缩放浏览器或滚动页面）。
function zoomEnabled(deps) {
  const v = deps.viewState.view;
  return v !== 'report' && v !== 'req' && v !== 'work' && v !== 'version';
}

// 缩放：设置 dayW 并重绘
function applyZoom(dw, sc, deps) {
  if (!zoomEnabled(deps)) return;
  const dayW = Math.max(MIN_DAYW, Math.min(MAX_DAYW, Math.round(dw)));
  deps.setDayW(dayW);
  const zs = deps.getEl('zs'); if (zs) zs.value = dayW;
  const zl = deps.getEl('zl'); if (zl) zl.textContent = dayW + ' px/天';
  deps.render(sc);
}

// 移动端「今天」：把时间轴滚到今日居中（左侧固定名称列宽由 gantt-scroll 读取 CSS 变量处理）
function scrollToToday(deps) {
  if (!zoomEnabled(deps)) return;
  const ctx = deps.getCtx ? deps.getCtx() : null;
  scrollDateToCenter(deps, ctx && ctx.today);
}

// ---- 移动端「更多」操作弹层 ----
// 弹层里的每一项都通过 data-proxy 代理到桌面工具栏的原按钮，
// 这样新增操作只需在 shell.js 加一个条目，不必再写一遍业务逻辑。
function openMobileSheet(deps) {
  const sheet = deps.getEl('mSheet'), mask = deps.getEl('mSheetMask');
  if (!sheet) return;
  sheet.classList.add('show');
  if (mask) mask.classList.add('show');
  deps.doc.body.classList.add('msheet-open');
}
function closeMobileSheet(deps) {
  const sheet = deps.getEl('mSheet'), mask = deps.getEl('mSheetMask');
  if (sheet) sheet.classList.remove('show');
  if (mask) mask.classList.remove('show');
  deps.doc.body.classList.remove('msheet-open');
}

// 设置缩放模式
function setZoom(z, deps) {
  deps.viewState.zoom = z;
  deps.doc.querySelectorAll('[data-z]').forEach(b => b.classList.toggle('on', b.dataset.z === z));
  applyZoom(ZOOM_DAYW[z], undefined, deps);
}

// 导出 JSON 数据文件（源 btnExport）
function exportJSON(deps) {
  const blob = new Blob([deps.sched.exportJSON()], { type: 'application/json' });
  const a = deps.doc.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '排期计划.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// 导出完整可编辑 HTML（新方案：fetch 构建时生成的单文件模板 + 注入当前数据）
// 模板由 vite-plugin-singlefile 构建（npm run build:export）生成 export-template.html，
// 不含 Supabase 逻辑；接收方离线打开即进入本地编辑模式。
async function exportHTML(deps) {
  try {
    // 剥离运行时附加字段（mod/isMs），与旧 exportJSON 输出一致
    const st = deps.planStore.state;
    const clean = st.modules.map(mo => ({
      ...mo,
      bars: mo.bars.map(b => {
        const { mod, isMs, ...rest } = b;
        return rest;
      })
    }));
    const payload = buildExportPayload({
      name: (deps.userStore && deps.userStore.state.project && deps.userStore.state.project.name) || '',
      modules: clean,
      resources: st.resources,
      // 版本（迭代）也要进导出件：「这版要上哪些需求」正是领导/业务最关心的一屏
      versions: st.versions || [],
      start: st.start,
      end: st.end,
      savedBy: (deps.userStore && deps.userStore.state.user && (deps.userStore.state.user.email || deps.userStore.state.user.display_name)) || ''
    });
    const html = await buildExportHTML(payload);
    downloadFile(
      `排期计划-${new Date().toISOString().slice(0, 10)}.html`,
      html,
      'text/html;charset=utf-8'
    );
    deps.toast('已导出完整 HTML（可直接发给他人使用）');
  } catch (err) {
    deps.toast('HTML 导出失败：' + err.message);
  }
}

// 一次性绑定工具栏事件
function bindToolbarControls(deps) {
  const g = deps.getEl;
  const doc = deps.doc;
  const on = (id, fn) => { const el = g(id); if (el) el.addEventListener('click', fn); };

  // 缩放按钮
  doc.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => setZoom(b.dataset.z, deps)));
  const zs = g('zs');
  if (zs) zs.addEventListener('input', () => {
    deps.viewState.zoom = 'custom';
    doc.querySelectorAll('[data-z]').forEach(b => b.classList.remove('on'));
    applyZoom(+zs.value, undefined, deps);
  });
  // 滚轮缩放（Ctrl + 滚轮）：作用域限定为支持缩放的视图；
  // 总览下直接放行，不 preventDefault，避免劫持用户的 Ctrl+滚轮
  if (deps.gsc) deps.gsc.addEventListener('wheel', e => {
    if (!e.ctrlKey || !zoomEnabled(deps)) return;
    e.preventDefault();
    const rect = deps.gsc.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const dayW = deps.viewState.dayW || 13;
    const dayOffset = (deps.gsc.scrollLeft + mouseX) / dayW;
    const factor = e.deltaY < 0 ? 1.3 : 1 / 1.3;
    const newDw = Math.max(MIN_DAYW, Math.min(MAX_DAYW, dayW * factor));
    const sc = Math.max(0, Math.round(dayOffset * newDw - mouseX));
    applyZoom(newDw, sc, deps);
  }, { passive: false });

  // ---- 移动端「更多」弹层：打开 / 关闭 / 代理执行 ----
  // 弹层里的项分两类：
  //   data-proxy → 代理点击桌面工具栏的原按钮（复用既有逻辑与只读守卫）
  //   data-act   → 本文件直接处理的动作（缩放 / 定位今天，桌面上由滑块承担，没有原按钮可代理）
  on('mMore', () => openMobileSheet(deps));
  on('mSheetCancel', () => closeMobileSheet(deps));
  on('mSheetMask', () => closeMobileSheet(deps));
  const sheet = g('mSheet');
  if (sheet) {
    sheet.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-proxy],[data-act]') : null;
      if (!btn) return;
      closeMobileSheet(deps);          // 先关弹层，避免抽屉/弹窗被盖住
      const act = btn.dataset.act;
      if (act === 'zoom-out') return applyZoom((deps.viewState.dayW || 13) - 2, undefined, deps);
      if (act === 'zoom-in') return applyZoom((deps.viewState.dayW || 13) + 2, undefined, deps);
      if (act === 'go-today') return scrollToToday(deps);
      if (act === 'theme') { if (deps.themePicker) deps.themePicker.open(); return; }
      const target = g(btn.dataset.proxy);
      if (!target || target.classList.contains('disabled') || target.disabled) return;
      target.click();
    });
  }

  // 标题栏右上角的代理按钮（＋任务 / 排期问题）
  doc.querySelectorAll('.hero-acts [data-proxy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = g(btn.dataset.proxy);
      if (!target || target.classList.contains('disabled') || target.disabled) return;
      target.click();
    });
  });

  // 视口跨过移动端断点时收起弹层，避免旋转屏幕后弹层悬空
  const mq = doc.defaultView && doc.defaultView.matchMedia ? doc.defaultView.matchMedia('(max-width: 767px)') : null;
  if (mq) {
    const onChange = () => { if (!mq.matches) closeMobileSheet(deps); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // 折叠。两个按钮都走 core/mod-fold.js 的口径：缺省 = 折叠，
  // 所以「全部展开」必须逐条写显式 false，不能靠清空表（清空等于全折叠）
  on('expAll', () => {
    expandAllMods(deps.viewState.collapsed, deps.planStore.state.modules);
    deps.render();
  });
  on('colAll', () => {
    collapseAllMods(deps.viewState.collapsed);
    deps.render();
  });

  // 视图切换
  doc.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    deps.viewState.view = b.dataset.view;
    syncViewBtns(deps);
    syncToolbarForView(deps);
    deps.render();
  }));
  syncViewBtns(deps);
  syncToolbarForView(deps);   // 首次进入可能是 ?view=report，需同步一次工具栏
  // 汇报视图：需求卡片点击下钻（事件委托到 document）
  // .rmod-card 为桌面卡片，.mtl-card 为移动端排期总览卡片（两套版式共用同一展开状态）
  doc.addEventListener('click', e => {
    const card = e.target && e.target.closest ? e.target.closest('.rmod-card,.mtl-card') : null;
    if (!card) return;
    const name = card.dataset.reportMod;
    if (!name) return;   // 待排期卡片等无下钻内容
    deps.toggleReportExpanded(name);
    deps.render();
  });

  // 自动计划（FULL_ONLY：全量重排所有自动任务，会动到别人负责的任务）
  on('btnAutoPlan', () => {
    if (!guardFullOnly(deps)) return;
    deps.sched.computeSchedule();
    deps.render();
    const n = deps.sched.problems().length;
    deps.toast(n ? `已按依赖+资源自动重排，仍有 ${n} 项问题待处理` : '已按依赖+资源自动重排，无排期问题');
  });
  // 导出 JSON（只读也能用：不改数据，只是把当前排期存下来）
  on('btnExport', () => exportJSON(deps));
  // 导出完整 HTML
  on('btnExportHTML', () => exportHTML(deps));
  // 导入 JSON（FULL_ONLY：整份替换 modules + resources + versions）
  on('btnImport', () => {
    if (!guardFullOnly(deps)) return;
    const f = g('fileImport'); if (f) f.click();
  });
  const fileImport = g('fileImport');
  if (fileImport) fileImport.addEventListener('change', e => {
    if (!guardFullOnly(deps)) return;      // 文件选择框若被程序直接触发，也不放行
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        deps.sched.importJSON(reader.result);
        deps.render();
        deps.toast('导入成功');
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  });

  // 服务器组：返回列表 / 从服务器刷新
  on('btnBackList', () => { if (deps.onBackList) deps.onBackList(); });
  on('btnReloadServer', () => {
    deps.sched.loadFromServer().then(ok => {
      if (ok) { try { deps.render(deps.gsc ? deps.gsc.scrollLeft : 0); } catch (e) {} deps.toast('已从服务器刷新'); }
      else deps.toast('服务器无数据或加载失败');
    });
  });

  // 撤销 / 重做（FULL_ONLY：回滚整份 plan 快照，会连带回滚别人的改动）
  on('btnUndo', () => { doUndo(deps); });
  on('btnRedo', () => { doRedo(deps); });

  // 全局键盘快捷键：Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做；Esc 关闭移动端「更多」弹层
  doc.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const sheet = g('mSheet');
      if (sheet && sheet.classList.contains('show')) closeMobileSheet(deps);
      return;
    }
    if (!e.ctrlKey && !e.metaKey) return;
    // 忽略输入框内的快捷键
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      doUndo(deps);            // 键盘走同一个入口：不能成为绕过按钮灰化的后门
    } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
      e.preventDefault();
      doRedo(deps);
    }
  });
}

// 撤销/重做的唯一执行口（按钮与快捷键共用）
function doUndo(deps) {
  if (!guardFullOnly(deps) || !deps.sched.canUndo()) return;
  deps.sched.undo();
  deps.render();
  updateUndoRedoBtns(deps);
  deps.toast('已撤销');
}
function doRedo(deps) {
  if (!guardFullOnly(deps) || !deps.sched.canRedo()) return;
  deps.sched.redo();
  deps.render();
  updateUndoRedoBtns(deps);
  deps.toast('已重做');
}

// 更新撤销/重做按钮的可用性。
// 口径统一为 class（`.btn.disabled` 同时负责视觉与 pointer-events），**不再写 disabled 属性**：
//   属性与 class 是两套状态，各写各的必然打架 —— 历史栈一有内容就把权限灰化翻成"可点"，
//   反之灰着却带 disabled=false 也会让后续读数的人误判。
// 判据是"权限 ∧ 历史栈"：协作者即使有可撤销的快照，按钮也必须保持灰。
function updateUndoRedoBtns(deps) {
  const allowed = fullOnlyAllowed();
  const undoBtn = deps.getEl('btnUndo');
  const redoBtn = deps.getEl('btnRedo');
  if (undoBtn) undoBtn.classList.toggle('disabled', !(allowed && deps.sched.canUndo()));
  if (redoBtn) redoBtn.classList.toggle('disabled', !(allowed && deps.sched.canRedo()));
}

// 聚合入口：绑定工具栏全部事件，返回外部可用的工具栏 API
export function bindToolbar(deps) {
  bindToolbarControls(deps);
  return {
    setZoom: (z) => setZoom(z, deps),
    applyZoom: (dw, sc) => applyZoom(dw, sc, deps),
    exportJSON: () => exportJSON(deps),
    exportHTML: () => exportHTML(deps),
    syncViewBtns: () => syncViewBtns(deps),
    updateUndoRedoBtns: () => updateUndoRedoBtns(deps)
  };
}
