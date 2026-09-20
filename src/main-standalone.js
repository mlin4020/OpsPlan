// ============================================================
// src/main-standalone.js — 导出单文件入口（只读查看器，无 Supabase、无编辑）
// 由构建产物 export-template.html 承载：vite-plugin-singlefile 把所有 JS/CSS 内联，
// 数据经 __PLAN_DATA__ 占位符注入（utils/export.js 在运行时替换）。
//
// 打开行为（离线可用，验收硬指标）：
//   1) 读取 #plan-data 中注入的排期数据（__PLAN_DATA__ 占位符被替换后的 JSON）
//   2) 注入数据为空/未替换 → 显示"此文件缺少排期数据"空态，绝不回退默认数据
//   3) 只读渲染三种视图：总览 / 甘特图 / 工作组规划器（冻结表头+左侧列，左右滑动）
//   4) 工具栏仅保留：缩放粒度（日/周/月 + 滑块）与视图切换
//   5) 不初始化任何编辑组件（无拖拽/抽屉/弹窗/资源库），不写 localStorage
// ============================================================
import './styles/gantt.css';
import { planStore } from './store/plan-store.js';
import { userStore } from './store/user-store.js';
import { createWorkday } from './core/workday.js';
import { defaultHolidays } from './core/default-data.js';
import { createScheduler } from './scheduler/index.js';
import { buildViewerShellHTML } from './components/shell.js';
import { renderAll } from './views/index.js';
import { restoreTheme } from './utils/theme.js';

const ZOOM_DAYW = { day: 13, week: 15, month: 32 };

// 读取注入数据（#plan-data script[type=application/json]）；无有效数据返回 null
function readInjectedPlan() {
  try {
    const el = document.getElementById('plan-data');
    if (!el) return null;
    const raw = (el.textContent || '').trim();
    if (!raw || raw === '__PLAN_DATA__') return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.modules)) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function parseDate(s) {
  const p = String(s).split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

function boot() {
  // 注意：必须先读取注入数据（#plan-data script），
  // 再重建 body——innerHTML 替换会销毁原有 script 元素。
  const params = new URLSearchParams(location.search);
  const viewFromQuery = ['res', 'report', 'mod'].includes(params.get('view')) ? params.get('view') : 'mod';
  const injected = readInjectedPlan();

  // 只读查看器同样跟随已选配色（file:// 下 localStorage 不可用时静默降级为默认色）
  restoreTheme(document);

  document.body.innerHTML = buildViewerShellHTML();

  // 注入数据 → planStore（无注入数据时保持空数组，不回退默认数据）
  if (injected) {
    planStore.set({
      modules: injected.modules,
      resources: Array.isArray(injected.resources) && injected.resources.length ? injected.resources : [],
      start: injected.start ? parseDate(injected.start) : planStore.state.start,
      end: injected.end ? parseDate(injected.end) : planStore.state.end
    });
  } else {
    planStore.set({ modules: [], resources: [] });
    const empty = document.getElementById('viewerEmpty');
    if (empty) empty.style.display = 'flex';
  }
  // 只读查看器：无用户、只读（防御任何修改入口）
  userStore.set({ user: null, readonly: true });

  // 调度引擎（不注入 sync，仅用于渲染统计/问题检测）
  const workday = createWorkday({ holidays: defaultHolidays() });
  const sched = createScheduler({ planStore, userStore, W: workday, sync: null });

  // hero 标题：注入数据的项目名（若有），否则默认
  const hTitle = document.getElementById('heroTitle');
  if (hTitle && injected && injected.name) hTitle.textContent = injected.name;

  // ---- 渲染 ctx（只读：无 ctxInjection 组件注入） ----
  const viewState = { view: viewFromQuery, zoom: 'day', collapsed: {}, dayW: ZOOM_DAYW.day };
  const baseCtx = {
    state: planStore.state,
    sched,
    gantt: document.getElementById('gantt'),
    gsc: document.querySelector('.gscroll'),
    getEl: id => document.getElementById(id),
    workday,
    today: new Date(),
    holidays: defaultHolidays()
  };
  function buildCtx(sc) {
    return {
      ...baseCtx,
      view: viewState.view,
      zoom: viewState.zoom,
      dayW: viewState.dayW,
      collapsed: viewState.collapsed,
      // 未显式指定时保持 undefined：renderAll 会沿用当前滚动位置（传 0 会被当作"滚到最左"）
      scrollLeft: typeof sc === 'number' ? sc : undefined
    };
  }
  function render(sc) {
    renderAll(buildCtx(sc));
  }

  // ---- 工具栏：视图切换 + 缩放（日/周/月 + 滑块） ----
  const syncViewBtns = () => document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === viewState.view));
  const syncZoomBtns = () => document.querySelectorAll('[data-z]').forEach(b => b.classList.toggle('on', b.dataset.z === viewState.zoom));
  // 总览（汇报）视图是纯汇报界面：隐藏缩放分组（shell.js 中带 data-report-hide），只留视图切换
  const syncToolbarForView = () => document.body.classList.toggle('report-view', viewState.view === 'report');
  const applyZoom = dw => {
    viewState.dayW = Math.max(2, Math.min(40, Math.round(dw)));
    const zs = document.getElementById('zs'); if (zs) zs.value = viewState.dayW;
    const zl = document.getElementById('zl'); if (zl) zl.textContent = viewState.dayW + ' px/天';
    const sc = document.querySelector('.gscroll');
    render(sc ? sc.scrollLeft : 0);
  };
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    viewState.view = b.dataset.view;
    syncViewBtns();
    syncToolbarForView();
    render(document.querySelector('.gscroll').scrollLeft);
  }));
  document.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => {
    viewState.zoom = b.dataset.z;
    syncZoomBtns();
    applyZoom(ZOOM_DAYW[b.dataset.z]);
  }));
  const zs = document.getElementById('zs');
  if (zs) zs.addEventListener('input', () => {
    viewState.zoom = 'custom';
    syncZoomBtns();
    applyZoom(+zs.value);
  });

  // 初始渲染（注入数据或空态）；工作日假期缓存预热成功后重绘
  syncToolbarForView();   // ?view=report 进入时需同步一次工具栏显隐
  render(0);
  workday.prefetch([2026, 2027]).then(() => {
    try { render(document.querySelector('.gscroll').scrollLeft); } catch (e) {}
  });
}

// 文档就绪后启动（standalone.html 在 body 末尾引入，DOM 已可用）
boot();
