// ============================================================
// src/components/shell.js — 排期页静态 DOM 壳（hero / toolbar / 容器 / 抽屉 / 弹窗）
// 由 main-gantt.js 内联定义提取，供 main-gantt（服务端模式）与
// main-standalone（导出单文件本地模式）两个入口复用，避免两处维护。
// 纯字符串/纯 DOM 构造，无依赖注入。
// ============================================================

// 全屏 loading 元素（进页面立即显示，覆盖登录/项目/排期接口加载链）
export function showFullLoading(doc) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root) return null;
  const el = root.createElement('div');
  el.id = 'fullLoading';
  el.style.cssText = 'position:fixed;inset:0;z-index:999;background:#eef1f7;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;font-family:sans-serif';
  el.innerHTML = '<div style="width:30px;height:30px;border:3px solid #dbe4f0;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite"></div><div style="color:#64748b;font-size:13px">加载中…</div>';
  root.body.appendChild(el);
  return el;
}

// ============================================================
// 移动端专用图标（24x24 viewBox，统一 stroke 规格，避免 emoji 图标）
// ============================================================
const MI = {
  report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="3.2" width="7" height="8.6" rx="1.8"/><rect x="13.8" y="3.2" width="7" height="5" rx="1.8"/><rect x="13.8" y="11.4" width="7" height="9.4" rx="1.8"/><rect x="3.2" y="15" width="7" height="5.8" rx="1.8"/></svg>',
  mod: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="2.6" y="4.2" width="10.5" height="3.6" rx="1.8"/><rect x="8" y="10.2" width="13.4" height="3.6" rx="1.8"/><rect x="4.6" y="16.2" width="9" height="3.6" rx="1.8"/></svg>',
  res: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.2" cy="8" r="3.2"/><path d="M3.4 19.6c0-3.1 2.6-5 5.8-5s5.8 1.9 5.8 5"/><path d="M16.2 5.6a3.2 3.2 0 0 1 0 6.2"/><path d="M17.6 14.9c1.9.7 3.1 2.3 3.1 4.7"/></svg>',
  // 工作视图：清单图标（勾选 + 三行）—— 与 res 的人形图标刻意区分：
  // res 是"按时间轴看人"，work 是"按清单看活"
  work: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 6.2 4.4 7.8l2.6-2.9"/><path d="M2.8 12.4 4.4 14l2.6-2.9"/><path d="M2.8 18.6 4.4 20.2l2.6-2.9"/><path d="M11.2 6.6h10"/><path d="M11.2 13h10"/><path d="M11.2 19.4h10"/></svg>',
  // 需求台账：表格 / 清单图标（台账是清单，不再是档案箱）
  req: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.2" width="18" height="15.6" rx="2.2"/><path d="M3 9.4h18"/><path d="M9.4 9.4v10.4"/></svg>',
  // 版本（迭代）：吊牌图标 —— 与 arch 的"箱子"刻意区分（一个是收口留档，一个是待发车）
  version: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 12.6 12.6 3.4h5.4a2.6 2.6 0 0 1 2.6 2.6v5.4l-9.2 9.2a1.7 1.7 0 0 1-2.4 0l-5.6-5.6a1.7 1.7 0 0 1 0-2.4z"/><circle cx="15.4" cy="8.6" r="1.35"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.2" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.8" cy="12" r="1.7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.7 2.8 19.3h18.4z"/><path d="M12 9.7v4.1"/><path d="M12 16.5h.01"/></svg>'
};

// 底部标签导航（移动端）：视图切换 + 更多。桌面端由 CSS 隐藏。
// 视图项沿用 data-view，与工具栏共用同一套点击委托与激活态同步。
// withMore=false 用于只读查看器（导出单文件）——那里没有可编辑操作，不需要「更多」弹层。
function mobileNavHTML(withMore) {
  const more = withMore === false
    ? ''
    : `<button class="mnav-item" id="mMore" type="button" aria-haspopup="dialog">${MI.more}<span>更多</span></button>`;
  return `<nav class="mnav" id="mnav" aria-label="视图切换">
  <button class="mnav-item" data-view="report">${MI.report}<span>总览</span></button>
  <button class="mnav-item" data-view="req">${MI.req}<span>需求台账</span></button>
  <button class="mnav-item" data-view="mod">${MI.mod}<span>甘特图</span></button>
  <button class="mnav-item" data-view="res">${MI.res}<span>规划器</span></button>
  <button class="mnav-item" data-view="work">${MI.work}<span>工作视图</span></button>
  <button class="mnav-item" data-view="version">${MI.version}<span>版本</span></button>${more}
</nav>`;
}

// 移动端「更多」操作弹层：把所有次要操作收进来，避免工具栏在手机上堆成多行。
// 每项通过 data-proxy 代理到桌面工具栏的原始按钮（不改动原有点击逻辑），
// data-server-only 的项在未进入项目（serverGroup 隐藏）时不展示。
function mobileSheetHTML() {
  const item = (proxy, label, extra) =>
    `<button type="button" class="msheet-item" data-proxy="${proxy}"${extra || ''}>${label}</button>`;
  return `<div class="msheet-mask" id="mSheetMask"></div>
<div class="msheet" id="mSheet" role="dialog" aria-modal="true" aria-label="更多操作">
  <div class="msheet-grab" aria-hidden="true"></div>
  <div class="msheet-hd">更多操作</div>
  <div class="msheet-grid">
    <button type="button" class="msheet-item" data-act="theme">主题配色</button>
    ${item('btnAddModule', '新增需求')}
    ${item('btnAddTask', '新增任务')}
    ${item('btnAutoPlan', '自动计划')}
    ${item('btnProblems', '排期问题')}
    ${item('expAll', '全部展开')}
    ${item('colAll', '全部折叠')}
    ${item('btnUndo', '撤销')}
    ${item('btnRedo', '重做')}
    ${item('btnResLib', '资源库')}
    <button type="button" class="msheet-item" data-act="zoom-out" data-zoom-only>时间轴缩小</button>
    <button type="button" class="msheet-item" data-act="zoom-in" data-zoom-only>时间轴放大</button>
    <button type="button" class="msheet-item" data-act="go-today" data-zoom-only>定位到今天</button>
    ${item('btnExport', '导出 JSON')}
    ${item('btnExportHTML', '导出 HTML')}
    ${item('btnImport', '导入 JSON')}
    <button type="button" class="msheet-item" data-proxy="btnReloadServer" data-server-only>从服务器刷新</button>
    <button type="button" class="msheet-item" data-proxy="btnBackList" data-server-only>返回项目列表</button>
  </div>
  <button type="button" class="msheet-cancel" id="mSheetCancel">取消</button>
</div>`;
}

// 导出单文件（只读查看器）精简 DOM 壳：hero + 缩放/视图工具栏 + 甘特容器 + 空态提示
// 无编辑按钮/抽屉/弹窗/服务器组；数据注入失败时显示空态（不回退默认数据）
export function buildViewerShellHTML() {
  return `<div class="hero">
  <div>
    <h1 id="heroTitle">排期计划</h1>
    <div class="sub" id="heroSub">只读查看</div>
  </div>
</div>
<div class="toolbar" id="toolbar">
  <div class="view-nav" id="viewNav">
    <button class="btn" data-view="report">总览</button>
    <button class="btn" data-view="req" title="全部需求清单：可排序筛选，点行展开需求档案">需求台账</button>
    <button class="btn" data-view="mod">甘特图</button>
    <button class="btn" data-view="res">工作组规划器</button>
    <button class="btn" data-view="work" title="资源工作视图：按人查看每个人手里的任务、优先级与状态">资源工作视图</button>
    <button class="btn" data-view="version" title="版本（迭代）：给一组需求一个统一上线日，一起上线">版本</button>
  </div>
  <div class="tgroup tseg" data-report-hide><span class="gl">缩放</span>
    <button class="btn on" data-z="day">日</button>
    <button class="btn" data-z="week">周</button>
    <button class="btn" data-z="month">月</button>
  </div>
  <div class="tgroup" data-report-hide>
    <span class="zlabel" id="zl">13 px/天</span>
    <input class="slider" id="zs" type="range" min="2" max="40" value="13">
  </div>
  <span class="spacer"></span>
  <span class="sync-info" id="viewerInfo">只读查看</span>
</div>
<div class="gwrap"><div class="gscroll"><div class="gantt" id="gantt"></div></div></div>
<div class="viewer-empty" id="viewerEmpty" style="display:none;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:60vh;color:#94a3b8;font-size:13px">
  <div style="font-size:16px;font-weight:700;color:#64748b">此文件缺少排期数据</div>
  <div>导出时未注入数据，或文件被修改。请重新从排期平台导出。</div>
</div>
${mobileNavHTML(false)}`;
}

// 排期页静态 DOM 壳（hero / toolbar / 甘特容器 / 抽屉 / 弹窗 / tip）
// serverGroup 默认隐藏：由入口按需显示（服务端模式显示，本地模式隐藏）
export function buildShellHTML() {
  return `<div class="hero">
  <div>
    <h1 id="heroTitle">实施作战图</h1>
    <div class="sub" id="heroSub">加载中…</div>
  </div>
  <!-- 移动端：高频操作直接进标题栏右上角（不再单独占一行白色条）。桌面端由 CSS 隐藏 -->
  <div class="hero-acts" data-report-hide>
    <span class="mbar-ro">只读</span>
    <button class="hero-ic hero-ic-cta" id="mAddTask" data-proxy="btnAddTask" type="button" title="新增任务" aria-label="新增任务">${MI.plus}</button>
    <button class="hero-ic" id="mProblems" data-proxy="btnProblems" type="button" title="排期问题" aria-label="排期问题">${MI.warn}<span class="badge" id="probCountM" hidden>0</span></button>
  </div>
  <div class="stats" data-report-hide>
    <div class="stat"><span class="n now" id="statActive">0</span><span class="l">并行推进</span></div>
    <div class="stat"><span class="n todo" id="totalWork">0</span><span class="l">总人日</span></div>
    <div class="stat" id="statOverdueWrap" style="display:none"><span class="n" id="statOverdue" style="color:#ef4444">0</span><span class="l">逾期</span></div>
  </div>
</div>
<div class="toolbar toolbar-full" id="toolbar">
  <div class="view-nav" id="viewNav">
    <button class="btn" data-view="report">总览</button>
    <button class="btn" data-view="req" title="全部需求清单：可排序筛选，点行展开需求档案">需求台账</button>
    <button class="btn" data-view="mod">甘特图</button>
    <button class="btn" data-view="res">工作组规划器</button>
    <button class="btn" data-view="work" title="资源工作视图：按人查看每个人手里的任务、优先级与状态">资源工作视图</button>
    <button class="btn" data-view="version" title="版本（迭代）：给一组需求一个统一上线日，一起上线">版本</button>
  </div>
  <div class="tgroup tseg" data-report-hide><span class="gl">缩放</span>
    <button class="btn on" data-z="day">日</button>
    <button class="btn" data-z="week">周</button>
    <button class="btn" data-z="month">月</button>
  </div>
  <div class="tgroup" data-report-hide>
    <span class="zlabel" id="zl">13 px/天</span>
    <input class="slider" id="zs" type="range" min="2" max="40" value="13">
  </div>
  <div class="tgroup" data-report-hide>
    <button class="btn ghost" id="expAll">全部展开</button>
    <button class="btn ghost" id="colAll">全部折叠</button>
  </div>
  <div class="tgroup sep" data-report-hide>
    <button class="btn primary" id="btnAddTask" title="新增任务：选择需求、阶段、日期与资源">＋ 任务</button>
    <button class="btn primary" id="btnAddModule" title="新增需求：新建一个空白需求用于规划">＋ 需求</button>
  </div>
  <div class="spacer"></div>
  <div class="tgroup" data-report-hide>
    <button class="btn primary" id="btnAutoPlan" title="按依赖关系与资源可用性，自动重算所有自动计划任务">自动计划</button>
    <button class="btn" id="btnProblems">排期问题<span class="badge" id="probCount" hidden>0</span></button>
  </div>
  <div class="tgroup sep" data-report-hide>
    <button class="btn ghost" id="btnUndo" title="撤销（Ctrl+Z）" disabled>↩ 撤销</button>
    <button class="btn ghost" id="btnRedo" title="重做（Ctrl+Shift+Z 或 Ctrl+Y）" disabled>↪ 重做</button>
  </div>
  <div class="tgroup" data-report-hide>
    <span class="gl">数据</span>
    <button class="btn ghost" id="btnTheme" title="切换主题配色（顶栏 + 按钮等品牌色一起换）">配色</button>
    <button class="btn ghost" id="btnResLib" title="管理资源人员：名称 / 职位 / 颜色">资源库</button>
    <button class="btn ghost" id="btnExport">导出 JSON</button>
    <button class="btn ghost" id="btnExportHTML" title="导出为单个 HTML 文件（含样式，可直接发给他人浏览）">导出 HTML</button>
    <button class="btn ghost" id="btnImport">导入</button>
    <input type="file" id="fileImport" accept=".json,application/json" hidden>
  </div>
  <div class="tgroup sep" id="serverGroup" style="display:none">
    <span class="badge readonly" id="roBadge" style="display:none;background:var(--amber)">只读</span>
    <button class="btn ghost" id="btnReloadServer" title="从服务器拉取最新排期">从服务器刷新</button>
    <button class="btn ghost" id="btnBackList" title="返回项目列表">返回项目列表</button>
    <span class="sync-info" id="syncInfo"></span>
  </div>
</div>
<div class="gwrap"><div class="gscroll"><div class="gantt" id="gantt"></div></div></div>

<!-- 排期问题抽屉 -->
<div class="drawer" id="probDrawer">
  <div class="drawer-grab" aria-hidden="true"><span></span></div>
  <div class="drawer-head">
    <h3>排期问题<span class="badge" id="probDrawerCount">0</span></h3>
    <button class="close" id="btnCloseDrawer" type="button" aria-label="关闭"><span class="close-x">×</span><span class="close-txt">关闭</span></button>
  </div>
  <div class="drawer-body" id="probList"></div>
  <div class="drawer-foot">
    <button class="btn primary" id="btnAutoFixAll">全部自动调整</button>
  </div>
</div>
<div class="drawer-mask" id="drawerMask"></div>

<!-- 任务详情抽屉 -->
<div class="drawer task-drawer" id="taskDrawer">
  <div class="drawer-grab" aria-hidden="true"><span></span></div>
  <div class="drawer-head">
    <h3 id="taskTitle">任务</h3>
    <span class="sub" id="taskSub"></span>
    <button class="close" id="btnCloseTaskDrawer" type="button" aria-label="关闭任务详情"><span class="close-x">×</span><span class="close-txt">关闭</span></button>
  </div>
  <div class="drawer-body">
    <div class="f-row" id="rowModPhase" hidden>
      <label>需求 / 阶段</label>
      <div class="mod-phase-grid">
        <select id="inpMod" title="所属需求"></select>
        <select id="inpPhase" title="任务阶段"></select>
      </div>
    </div>
    <div class="f-row" id="rowType">
      <label>类型</label>
      <div class="seg" id="segType">
        <button class="btn" data-ms="false">普通任务</button>
        <button class="btn" data-ms="true">里程碑</button>
      </div>
    </div>
    <div class="f-row" id="rowName">
      <label id="lblName">任务名称</label>
      <input type="text" id="inpName" placeholder="留空按「需求 · 阶段」显示">
    </div>
    <div class="f-row" id="rowManual">
      <label>计划模式</label>
      <div class="seg" id="segManual">
        <button class="btn" data-manual="false">自动计划</button>
        <button class="btn" data-manual="true">手动计划</button>
      </div>
    </div>
    <div class="f-row" id="rowProgress">
      <label>完成进度</label>
      <div style="display:flex;align-items:center;gap:10px">
        <input type="range" id="inpProgress" min="0" max="100" value="0" style="flex:1;accent-color:#10b981">
        <span id="lblProgress" style="font-size:14px;font-weight:800;color:#10b981;min-width:40px;text-align:right">0%</span>
        <button class="btn" id="btnQuickComplete" style="font-size:11px;padding:4px 10px;color:#10b981;border-color:#10b981" title="一键设为完成（100%）">✓ 完成</button>
      </div>
    </div>
    <div class="f-row" id="rowRes">
      <label>资源（人员）
        <button class="btn ghost" id="btnDrawerResLib" style="margin-left:8px;padding:1px 8px;font-size:10px" title="在资源库中统一增删改人员">管理资源库</button>
      </label>
      <div class="res-picker" id="resPicker"></div>
    </div>
    <div class="f-row" id="rowDur">
      <label>工作量（人天）</label>
      <input type="number" id="inpW" min="1" step="1" style="width:120px">
      <span id="lblWork" style="font-size:12px;color:#0f766e;font-weight:700;margin-left:6px">— 人天</span>
    </div>
    <div class="f-row" id="rowDates">
      <label>日期</label>
      <div class="dates">
        <input type="date" id="inpStart">
        <span id="dateSep" style="color:#94a3b8">~</span>
        <input type="date" id="inpEnd" disabled>
      </div>
    </div>
    <div class="f-row" id="rowDeps">
      <label>前置依赖（完成-开始，选中后自动添加；可再对该依赖调整偏移天数，如 -2d 表示前置完成前 2 天即可开始）</label>
      <div class="dep-list" id="depList"></div>
      <div class="dep-add">
        <select id="depModSelect" title="先选需求，再选该需求下的前置任务"></select>
        <select id="depSelect" title="选择任务即自动添加为前置依赖"></select>
      </div>
    </div>
    <div class="f-row" id="fIssue" hidden></div>
  </div>
  <div class="drawer-foot">
    <button class="btn primary" id="btnSaveTask">保存</button>
    <button class="btn danger" id="btnDeleteTask" title="删除此任务">删除</button>
    <button class="btn ghost" id="btnUnignore" hidden>取消忽略</button>
    <span class="spacer"></span>
    <span style="font-size:10px;color:#94a3b8" id="taskHint"></span>
  </div>
</div>

<div class="tip" id="tip"></div>

${mobileSheetHTML()}

<!-- 资源库管理 -->
<div class="modal-mask" id="resMask"></div>
<div class="modal" id="resLibModal">
  <h3>资源库（人员 / 职位）</h3>
  <div id="resLibList"></div>
  <div class="modal-foot">
    <button class="btn primary" id="btnAddRes">+ 新增资源</button>
    <span class="spacer"></span>
    <button class="btn ghost" id="btnCloseResLib">关闭</button>
  </div>
</div>
<div class="modal" id="resEditModal">
  <h3 id="resEditTitle">编辑资源</h3>
  <div class="f-row"><label style="width:64px">名称</label><input type="text" id="inpResName" placeholder="如：张三"></div>
  <div class="f-row"><label style="width:64px">职位</label><input type="text" id="inpResRole" placeholder="如：需求 / UI / 开发 / 测试"></div>
  <div class="f-row"><label style="width:64px">颜色</label><input type="color" id="inpResColor"></div>
  <div class="modal-foot">
    <button class="btn primary" id="btnSaveRes">保存</button>
    <span class="spacer"></span>
    <button class="btn ghost" id="btnCancelRes">取消</button>
  </div>
</div>
<!-- 主题配色（换肤）：同时作用于顶栏与全站品牌色（按钮 / 选中态 / 链接 / 浅色标签） -->
<div class="modal-mask" id="themeMask"></div>
<div class="modal" id="themeModal">
  <h3>主题配色</h3>
  <p class="theme-tip">选中即时生效，并记住在这台浏览器上。顶栏、按钮、选中态与浅色标签会一起换色；<b>进度条/风险等数据颜色不跟随主题</b>，始终按业务语义显示。</p>
  <div class="theme-grid" id="themeGrid"></div>
  <div class="modal-foot">
    <button class="btn ghost" id="btnThemeReset">恢复默认</button>
    <span class="spacer"></span>
    <button class="btn primary" id="btnThemeDone">完成</button>
  </div>
</div>
<div class="drawer-mask" id="modNewMask"></div>
<!-- 新增/编辑需求：与「新增任务」统一为右侧抽屉（原先是居中小弹窗，表单被挤在 440px 里、
     与任务抽屉两套观感）。桌面端右侧滑出，手机端由断点转为底部抽屉，与任务详情同一套行为。 -->
<div class="drawer form-drawer" id="modNewDrawer">
  <div class="drawer-grab" aria-hidden="true"><span></span></div>
  <div class="drawer-head">
    <h3 id="modModalTitle">新增需求</h3>
    <button class="close" id="btnCloseModDrawer" type="button" aria-label="关闭"><span class="close-x">×</span><span class="close-txt">关闭</span></button>
  </div>
  <div class="drawer-body">
    <div class="f-row"><label>需求名称</label><input type="text" id="newModName" placeholder="如：数据服务"></div>
    <div class="f-row"><label>标签</label><input type="text" id="newModTag" placeholder="如：开发中 / 冲刺中 / 待启动"></div>
    <div class="f-row"><label>需求颜色<span class="phase-tip">同一需求的任务条 / 里程碑统一用它</span></label><input type="color" id="newModTagc" value="#3b82f6"><span class="phase-tip" id="newModTagcTip" style="margin-left:0"></span></div>
    <div class="f-row"><label>描述<span class="phase-tip">给领导 / 业务看的一段说明，会显示在需求台账页</span></label><textarea id="newModDesc" rows="3" placeholder="这个需求要解决什么问题、范围是什么"></textarea></div>
    <div class="f-row"><label>需求文档<span class="phase-tip">外部链接（语雀 / 飞书文档 / Confluence）</span></label><input type="text" id="newModDocUrl" placeholder="https://..."></div>
    <div class="f-row">
      <label>排期状态<span class="phase-tip" id="modSchedTip">待排期：只登记需求，不展示排期条、不计入并行/逾期</span></label>
      <div class="seg" id="segModSched">
        <button type="button" class="btn on" data-unsched="false">已排期</button>
        <button type="button" class="btn" data-unsched="true">待排期</button>
      </div>
    </div>
    <div class="f-row">
      <label>优先级<span class="phase-tip" id="modPriTip">P0 最高 · P3 最低。仅作标记，不改变排期日期与需求顺序</span></label>
      <div class="seg" id="segModPri">
        <button type="button" class="btn" data-pri="">无</button>
        <button type="button" class="btn" data-pri="P0">P0</button>
        <button type="button" class="btn" data-pri="P1">P1</button>
        <button type="button" class="btn" data-pri="P2">P2</button>
        <button type="button" class="btn" data-pri="P3">P3</button>
      </div>
    </div>
    <div class="f-row" id="rowNewModPhases">
      <label>初始化阶段<span class="phase-tip" id="newModPhaseTip">默认全选，可自定义要创建的任务阶段；「需求确认」为里程碑，并自动追加「提测」「上线」里程碑</span></label>
      <div class="phase-grid" id="newModPhases"></div>
      <div class="phase-acts">
        <button type="button" class="btn ghost" id="btnPhaseAll">全选</button>
        <button type="button" class="btn ghost" id="btnPhaseNone">全不选</button>
      </div>
    </div>
  </div>
  <div class="drawer-foot">
    <button class="btn primary" id="btnNewModSave">创建</button>
    <button class="btn danger" id="btnDelMod" style="display:none" title="删除此需求及其所有任务">删除</button>
    <span class="spacer"></span>
    <button class="btn ghost" id="btnNewModCancel">取消</button>
  </div>
</div>

<!-- 版本（迭代）：新建 / 编辑（改名 · 改上线日 · 勾选成员）三合一。
     刻意不拆成三个弹窗：「新建一个版本」和「往版本里加需求」本质是同一张表单，
     拆开会让"加需求"多走一步（先加空版本再勾人）。 -->
<div class="modal-mask" id="verMask"></div>
<div class="modal" id="verModal" role="dialog" aria-modal="true" aria-label="版本">
  <h3 id="verModalTitle">新建版本</h3>
  <div class="f-row"><label style="width:64px">版本名称</label><input type="text" id="inpVerName" placeholder="如：V2.3 / 2026-10 版本" maxlength="24"></div>
  <div class="f-row"><label style="width:64px">上线日</label><input type="date" id="inpVerDate"></div>
  <div class="f-row" id="verActualRow" hidden><label style="width:64px">实际上线</label><input type="date" id="inpVerActual"></div>
  <div class="f-row ver-pick-row"><label style="width:64px">包含需求</label>
    <div class="ver-picker" id="verPicker"></div>
  </div>
  <p class="ver-modal-tip">勾选的需求，图上那条「上线」日期会自动改为本版本上线日（手动锁定，自动计划不会改它）。已在别的版本里的需求不可选，需先从那个版本移出。</p>
  <div class="modal-foot">
    <button class="btn primary" id="btnSaveVer">保存</button>
    <span class="spacer"></span>
    <button class="btn ghost" id="btnCancelVer">取消</button>
  </div>
</div>

${mobileNavHTML(true)}
`;
}
