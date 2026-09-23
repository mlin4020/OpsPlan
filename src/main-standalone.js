// ============================================================
// src/main-standalone.js — 导出单文件入口（只读查看器，无 Supabase、无编辑）
// 由构建产物 export-template.html 承载：vite-plugin-singlefile 把所有 JS/CSS 内联，
// 数据经 __PLAN_DATA__ 占位符注入（utils/export.js 在运行时替换）。
//
// 打开行为（离线可用，验收硬指标）：
//   1) 读取 #plan-data 中注入的排期数据（__PLAN_DATA__ 占位符被替换后的 JSON）
//   2) 注入数据为空/未替换 → 显示"此文件缺少排期数据"空态，绝不回退默认数据
//   3) 只读渲染三种视图：总览 / 甘特图 / 工作组规划器（冻结表头+左侧列，左右滑动）
//      另有资源工作视图（按人清单，带筛选），支持 ?view=work&me=某人 直接落到某个人的任务
//   4) 工具栏仅保留：缩放粒度（日/周/月 + 滑块）与视图切换
//   5) 不初始化任何编辑组件（无拖拽/抽屉/弹窗/资源库），不写 localStorage
// ============================================================
import './styles/gantt.css';
import { planStore } from './store/plan-store.js';
import { userStore } from './store/user-store.js';
import { createWorkday } from './core/workday.js';
import { defaultHolidays } from './core/default-data.js';
import { defaultWorkFilter } from './core/work-filter.js';
import { defaultReqFilter, defaultReqSort } from './core/mod-query.js';
import { createScheduler } from './scheduler/index.js';
import { buildViewerShellHTML } from './components/shell.js';
import { bindWorkFilter } from './components/work-filter.js';
import { bindVersionPage } from './components/version-page.js';
import { bindReqPage } from './components/req-page.js';
import { renderAll, toggleReqExpanded } from './views/index.js';
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
  // 白名单与主壳保持一致（含 req / work / version），未知值回退默认视图
  // 旧链接兼容：归档页已被需求台账取代，老书签 ?view=arch 重定向到 req
  const VIEW_ALIAS = { arch: 'req' };
  const rawView = params.get('view') || '';
  const viewFromQuery = ['res', 'report', 'mod', 'req', 'work', 'version'].includes(VIEW_ALIAS[rawView] || rawView)
    ? (VIEW_ALIAS[rawView] || rawView)
    : 'mod';
  const injected = readInjectedPlan();

  // 只读查看器同样跟随已选配色（file:// 下 localStorage 不可用时静默降级为默认色）
  restoreTheme(document);

  document.body.innerHTML = buildViewerShellHTML();

  // 注入数据 → planStore（无注入数据时保持空数组，不回退默认数据）
  if (injected) {
    planStore.set({
      modules: injected.modules,
      resources: Array.isArray(injected.resources) && injected.resources.length ? injected.resources : [],
      // 版本（迭代）：老导出件里没有该字段 → 空列表（版本页显示空态，不影响其它视图）
      versions: Array.isArray(injected.versions) ? injected.versions : [],
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
  // body 级只读标记：主壳由 utils/readonly.js 的 enterReadonly 打上，查看器没有组件层，
  // 这里显式补一个 —— 版本页的「新建/编辑/标记上线」等按钮靠 `body.readonly-mode .ver-act` 隐藏，
  // 不打标就会在导出件里露出一排点了没反应的按钮。
  document.body.classList.add('readonly-mode');

  // 调度引擎（不注入 sync，仅用于渲染统计/问题检测）
  const workday = createWorkday({ holidays: defaultHolidays() });
  const sched = createScheduler({ planStore, userStore, W: workday, sync: null });

  // hero 标题：注入数据的项目名（若有），否则默认
  const hTitle = document.getElementById('heroTitle');
  if (hTitle && injected && injected.name) hTitle.textContent = injected.name;

  // ---- 渲染 ctx（只读：无 ctxInjection 组件注入） ----
  // ?me=某人：资源工作视图的"看自己"深链，与排期页同一套口径（导出件发给个人时尤其好用）
  const viewState = {
    view: viewFromQuery, zoom: 'day', collapsed: {}, dayW: ZOOM_DAYW.day,
    workFilter: { ...defaultWorkFilter(), person: (params.get('me') || '').trim() },
    // 需求台账的筛选与排序（查看器里同样可筛可排，只是不能改数据）
    reqFilter: defaultReqFilter(),
    reqSort: defaultReqSort()
  };
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
      workFilter: viewState.workFilter,
      reqFilter: viewState.reqFilter,
      reqSort: viewState.reqSort,
      // 未显式指定时保持 undefined：renderAll 会沿用当前滚动位置（传 0 会被当作"滚到最左"）
      scrollLeft: typeof sc === 'number' ? sc : undefined
    };
  }
  function render(sc) {
    renderAll(buildCtx(sc));
  }
  // 筛选条事件（共用组件层实现）：查看器没有组件层，这里单独绑一次，否则筛选条点了没反应
  bindWorkFilter({ gantt: baseCtx.gantt, gsc: baseCtx.gsc, viewState, render });
  // 版本页同理：导出件里要能展开/收起版本成员（领导看的就是"这版有哪几个需求"）。
  // 其余入口（新建/编辑/标记上线/删除）在只读下自行失效，无需另写一套只读版。
  bindVersionPage({
    doc: document,
    getEl: id => document.getElementById(id),
    gantt: baseCtx.gantt,
    planStore, sched, userStore,
    toast: () => {},
    today: () => new Date(),
    render
  });
  // 需求台账：查看器里同样要能展开档案 / 排序 / 筛选（领导看的就是这个）。
  // isReadonly 固定 true：查看器全只读，写操作拦在最前面（按钮另有 CSS 隐藏，这是第二道防线）
  bindReqPage({ gantt: baseCtx.gantt, gsc: baseCtx.gsc, viewState, render, toggleReqExpanded, isReadonly: () => true });

  // ---- 工具栏：视图切换 + 缩放（日/周/月 + 滑块） ----
  const syncViewBtns = () => document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === viewState.view));
  const syncZoomBtns = () => document.querySelectorAll('[data-z]').forEach(b => b.classList.toggle('on', b.dataset.z === viewState.zoom));
  // 非时间轴视图（总览 / 归档 / 资源工作视图）：隐藏缩放等分组（shell.js 中带 data-report-hide），
  // 只留视图切换。与主壳 toolbar.js 的 syncToolbarForView 用同一套 body class，三处视图口径保持一致
  const syncToolbarForView = () => {
    const v = viewState.view;
    document.body.classList.toggle('report-view', v === 'report');
    document.body.classList.toggle('work-view', v === 'work');
    document.body.classList.toggle('req-view', v === 'req');
    document.body.classList.toggle('version-view', v === 'version');
  };
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
