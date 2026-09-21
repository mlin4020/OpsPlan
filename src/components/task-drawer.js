// ============================================================
// src/components/task-drawer.js — 任务详情抽屉（编辑 / 新建共用一套表单）
//
// 从 1112 行的 components/drawers.js 拆出。本模块装的是"一条任务的编辑闭环"：
//   表单填充（任务 / 里程碑两种形态）→ 资源分配 → 前置依赖配置 → 保存/删除 → 控件事件绑定
// 以及这一闭环所需的模块内草稿状态（draftIsMs / modalDeps / newTaskMode / draftPhase）。
//
// 依赖方向（刻意保持单向，无环）：
//   task-drawer → drawer-shell    （面板状态 / 关闭 / 关闭时的收尾注册）
//   task-drawer → problem-drawer  （抽屉内问题区要刷新问题徽标与列表）
// 反方向不得引用：drawer-shell 不 import 本文件，问题抽屉也不知道本文件的存在。
//
// 依赖注入（deps）：
//   sched/planStore/render/toast/isReadonly/getEl/today/workday/PNAME
//   deps.shared（{ activeTaskId, modalRes }，与 reslib 共享的当前编辑对象）
//   deps.modals（新建需求入口）/ deps.reslib（抽屉内「管理资源」入口）
//   deps.closeDrawer（装配器注入，见 drawers.js）
// ============================================================
import { milestoneName } from '../core/mod-tag.js';
import { isOverdueTask } from '../core/task-status.js';
import { closeDrawer, getPanel, onDrawerClose, setPanel } from './drawer-shell.js';
import { openProblemDrawer, renderProbList, updateProblemBadge } from './problem-drawer.js';

let draftIsMs = false;          // 当前抽屉选择的类型：true=里程碑
let modalDeps = [];             // 依赖草稿 [{id, lag}]
let newTaskMode = null;         // 新建任务模式：{ mod, start } 或 null（编辑模式；start=右击位置对应日期）
let draftPhase = 'dev';         // 新建模式下的阶段草稿
let depMod = null;              // 依赖级联：当前选中的需求名（null=未选，渲染时默认取第一个有可用任务的需求）

// 便捷存取共享状态（未注入 shared 时降级为模块内变量）
const curTaskId = deps => (deps.shared ? deps.shared.activeTaskId : null);
const setTaskId = (deps, id) => { if (deps.shared) deps.shared.activeTaskId = id; };
const curModalRes = deps => (deps.shared ? deps.shared.modalRes : modalResShared);
let modalResShared = [];
const setModalRes = (deps, v) => { if (deps.shared) deps.shared.modalRes = v; else modalResShared = v; };

// 只读守卫（组件层统一）：true=可编辑，false=只读
function editable(deps) {
  return !(deps.isReadonly && deps.isReadonly());
}

// ============ 表单填充 ============
function applyMilestoneView(on, deps) {
  const disp = on ? 'none' : '';
  ['rowRes', 'rowDur', 'rowProgress'].forEach(id => { const el = deps.getEl(id); if (el) el.style.display = disp; });
  ['dateSep', 'inpEnd', 'inpW', 'lblWork'].forEach(id => { const el = deps.getEl(id); if (el) el.style.display = disp; });
  // 里程碑名称提示：留空时只能回退到阶段名，图上会退化成一个没信息量的名字，
  // 故切换类型时同步改字段标题与占位示例，引导用户填写业务卡点名
  const nmLabel = deps.getEl('lblName');
  const inpName = deps.getEl('inpName');
  if (nmLabel) nmLabel.textContent = on ? '里程碑名称' : '任务名称';
  if (inpName) inpName.placeholder = on
    ? '如：需求评审 / 提测 / 上线（留空按阶段名显示）'
    : '留空按「需求 · 阶段」显示';
}

function renderSegType(ms, deps) {
  const box = deps.getEl('segType');
  if (!box) return;
  box.querySelectorAll('.btn').forEach(b => b.classList.toggle('on', (b.dataset.ms === 'true') === ms));
}

function renderSeg(manual, deps) {
  const box = deps.getEl('segManual');
  if (!box) return;
  box.querySelectorAll('.btn').forEach(b => b.classList.toggle('on', (b.dataset.manual === 'true') === manual));
}

// 普通任务表单：字段 + 问题提示统一填充（抽屉打开 / 类型切换共用）
function fillTaskForm(t, deps) {
  const _span = t.s && t.e ? deps.workday.spanDays(t.s, t.e) : 1;
  const _work = deps.workday.workDays(t.s || t.m, t.e || t.s || t.m);
  const g = deps.getEl;
  g('taskTitle').textContent = deps.sched.nameOf(t);
  g('taskSub').textContent = `${t.mod} · 进度 ${t.done || 0}% · 工作量 ${_work}人天 · 时间 ${t.s || t.m} ~ ${t.e || t.s || t.m}`;
  g('inpName').value = t.name || '';
  modalDeps = (t.dep || []).map(d => ({ ...d }));
  setModalRes(deps, [...(t.res || [])]);
  renderSeg(t.manual, deps);
  renderResPicker(deps);
  renderDepList(deps);
  renderDepSelect(deps);
  g('inpStart').value = t.s || t.m || '';
  g('inpEnd').value = t.e || t.s || t.m || '';
  g('inpW').value = t.w != null ? t.w : _work;   // 默认展示工作量（人天）
  g('lblWork').textContent = _work + ' 人天';
  g('inpStart').disabled = !t.manual;
  const un = g('btnUnignore'); if (un) un.hidden = !t.ignore;
  const pct = t.done || 0;
  g('inpProgress').value = pct;
  g('lblProgress').textContent = pct + '%';
  const probs = deps.sched.problems().filter(p => p.taskId === t.id);
  const isOverdue = isOverdueTask(t, deps.today());
  const fIssue = g('fIssue');
  const ro = deps.isReadonly();
  const taskId = t.id;

  if (probs.length || isOverdue) {
    fIssue.hidden = false;
    let html = '<div class="issue-note"><b>⚠ 存在排期问题：</b></div>';
    // 每个排期问题独立条目（含处理按钮）
    const allIssues = [
      ...probs.map(p => ({ desc: p.desc, taskId: p.taskId })),
      ...(isOverdue ? [{ desc: `⚠ 任务已逾期！结束日期 ${t.e} 已过，当前进度 ${pct}%`, taskId: t.id }] : [])
    ];
    allIssues.forEach(item => {
      html += `<div class="issue-item">
        <div class="issue-item-desc">${item.desc}</div>
        <div class="issue-item-actions">
          ${ro ? '' : `<button class="btn primary iss-auto" data-task-id="${item.taskId}">自动调整</button>
          <button class="btn ghost iss-ignore" data-task-id="${item.taskId}">忽略</button>`}
        </div>
      </div>`;
    });
    fIssue.innerHTML = html;
  } else {
    fIssue.hidden = true;
  }
  g('taskHint').textContent = t.manual
    ? '手动计划：日期被锁定，与依赖/资源冲突时将在排期问题中标记'
    : '自动计划任务由依赖与资源自动计算日期';
}

// 里程碑表单：0 天周期单点，支持 自动(依赖驱动上线日) / 手动(指定日期)
function fillMsForm(t, deps) {
  const g = deps.getEl;
  const fIssue = g('fIssue'); if (fIssue) fIssue.hidden = true;
  const un = g('btnUnignore'); if (un) un.hidden = true;
  const rd = g('rowDeps'); if (rd) rd.style.display = '';   // 确保前置依赖（含添加控件）可见
  g('taskTitle').textContent = milestoneName(t, t.mod);
  g('taskSub').textContent = `${t.mod} · 上线日期 ${t.m || t.s}`;
  g('inpName').value = t.label || '';
  const msManual = t.manual !== false;
  renderSeg(msManual, deps);
  modalDeps = (t.dep || []).map(d => ({ ...d }));
  renderDepList(deps);
  renderDepSelect(deps);
  g('inpStart').value = t.m || t.s || '';
  g('inpStart').disabled = !msManual;
  g('taskHint').textContent = msManual
    ? '里程碑（0 天周期，代表某个时间点）：手动模式可指定上线日期，或拖拽菱形标记调整'
    : '里程碑（0 天周期，代表某个时间点）：自动模式由前置依赖自动计算上线日期，可拖拽菱形标记锁定';
}

// 新建/编辑共用抽屉：需求+阶段下拉渲染（两种模式均可见，编辑模式可改归属）
// preset: { mod, phase } 编辑模式传入任务当前的需求/阶段；新建模式缺省回退 newTaskMode.mod + draftPhase
function renderModPhaseSelects(deps, preset) {
  const g = deps.getEl;
  const modSel = g('inpMod'), phSel = g('inpPhase');
  if (!modSel || !phSel) return;
  // 已归档需求不可作为任务归属（只读收口），仅列出在排需求
  modSel.innerHTML = deps.planStore.state.modules.filter(m => !m.archived)
    .map(m => `<option value="${m.name}">${m.name}</option>`).join('');
  phSel.innerHTML = Object.keys(deps.PNAME).map(k => `<option value="${k}">${deps.PNAME[k]}</option>`).join('');
  const pre = (preset && preset.mod) || (newTaskMode && newTaskMode.mod);
  if (pre && [...modSel.options].some(o => o.value === pre)) modSel.value = pre;
  const prePhase = (preset && preset.phase) || draftPhase;
  phSel.value = Object.keys(deps.PNAME).includes(prePhase) ? prePhase : (deps.PNAME.dev ? 'dev' : phSel.value);
  // 只读：下拉禁用（保存本身由 saveTask 守卫，此处仅避免误导可改）
  const ro = !editable(deps);
  modSel.disabled = ro;
  phSel.disabled = ro;
}

// 新建模式表单默认值（与编辑同一表单）
// 开始日期：newTaskMode.start 存在时取右击位置对应日期，否则取今天
function fillNewTaskForm(deps) {
  const g = deps.getEl;
  const start = (newTaskMode && newTaskMode.start)
    ? deps.sched.fmt(newTaskMode.start)
    : deps.sched.fmt(deps.today());
  g('taskTitle').textContent = '新增任务';
  g('taskSub').textContent = '与编辑任务共用同一表单';
  g('inpName').value = '';
  modalDeps = [];
  setModalRes(deps, []);
  renderSeg(true, deps);
  renderResPicker(deps);
  renderDepList(deps);
  renderDepSelect(deps);
  g('inpStart').value = start;
  g('inpStart').disabled = false;
  g('inpEnd').value = start;
  g('inpW').value = 1;
  g('lblWork').textContent = '1 人天';
  const un = g('btnUnignore'); if (un) un.hidden = true;
  g('inpProgress').value = 0;
  g('lblProgress').textContent = '0%';
  const fIssue = g('fIssue'); if (fIssue) fIssue.hidden = true;
  g('taskHint').textContent = (newTaskMode && newTaskMode.start)
    ? `新建任务：开始日期已按右击位置预填为 ${start}（可修改）；选择需求/阶段/类型/资源后保存`
    : '新建任务：选择需求/阶段/类型/日期/资源后保存';
}

// ============ 抽屉开关 ============
// 打开任务抽屉：编辑模式（newTaskMode=null；需求/阶段行可见，可改归属）
export function openTaskDrawer(taskId, deps) {
  const t = deps.sched.getTask(taskId);
  if (!t) return;
  newTaskMode = null;
  const row = deps.getEl('rowModPhase'); if (row) row.hidden = false;
  setTaskId(deps, taskId);
  draftIsMs = !!t.m;
  renderSegType(draftIsMs, deps);
  applyMilestoneView(draftIsMs, deps);
  renderModPhaseSelects(deps, { mod: t.mod, phase: t.p });
  if (draftIsMs) fillMsForm(t, deps); else fillTaskForm(t, deps);
  const del = deps.getEl('btnDeleteTask'); if (del) del.style.display = '';
  setPanel('task');
  const d = deps.getEl('taskDrawer'), m = deps.getEl('drawerMask');
  if (d) d.classList.add('open');
  if (m) m.classList.add('show');
}

// 打开任务抽屉：新建模式（opts={mod,start}：预选需求 + 右击位置对应的开始日期；
// 显示需求/阶段行，隐藏删除按钮）
export function openNewTaskDrawer(opts, deps) {
  newTaskMode = { mod: (opts && opts.mod) || '', start: (opts && opts.start) || null };
  draftPhase = deps.PNAME.dev ? 'dev' : draftPhase;
  const row = deps.getEl('rowModPhase'); if (row) row.hidden = false;
  setTaskId(deps, null);
  draftIsMs = false;
  renderSegType(false, deps);
  applyMilestoneView(false, deps);
  renderModPhaseSelects(deps);
  fillNewTaskForm(deps);
  const del = deps.getEl('btnDeleteTask'); if (del) del.style.display = 'none';
  setPanel('task');
  const d = deps.getEl('taskDrawer'), m = deps.getEl('drawerMask');
  if (d) d.classList.add('open');
  if (m) m.classList.add('show');
}

// ============ 资源分配 + 依赖配置 ============
export function renderResPicker(deps) {
  const box = deps.getEl('resPicker');
  if (!box) return;
  const mr = curModalRes(deps);
  box.innerHTML = (deps.planStore.state.resources || []).map(r => {
    const sel = mr.includes(r.name) ? ' sel' : '';
    return `<div class="res-pick${sel}" data-res="${r.name}">
      <span class="avatar" style="background:${r.color}">${r.name[0]}</span>${r.name}<span style="color:#94a3b8;font-size:10px">${r.role}</span></div>`;
  }).join('');
  box.querySelectorAll('.res-pick').forEach(el => el.addEventListener('click', () => {
    const name = el.dataset.res;
    const arr = curModalRes(deps);
    const i = arr.indexOf(name);
    if (i >= 0) arr.splice(i, 1); else arr.push(name);
    el.classList.toggle('sel', curModalRes(deps).includes(name));
  }));
}

function depName(d, deps) {
  const t = deps.sched.getTask(d.id);
  return t ? `[${t.mod}] ${deps.sched.nameOf(t)}` : ('#' + d.id);
}

function renderDepList(deps) {
  const list = deps.getEl('depList');
  if (!list) return;
  if (!modalDeps.length) {
    list.innerHTML = '<div class="empty-tip" style="padding:10px">暂无前置依赖</div>';
    return;
  }
  list.innerHTML = modalDeps.map((d, i) => `
    <div class="dep-item">
      <span class="steel" style="width:6px;height:6px;border-radius:2px;background:#94a3b8;flex:none"></span>
      <span class="dep-name">${depName(d, deps)}</span>
      <span class="dep-lag">
        <input type="number" class="dep-lag-input" data-i="${i}" value="${d.lag != null ? d.lag : 0}" title="偏移天数：正=前置完成后延后，负=前置完成前即可开始"> 天
      </span>
      <button class="del" data-i="${i}">×</button>
    </div>`).join('');
  list.querySelectorAll('.dep-lag-input').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i;
    modalDeps[i].lag = +inp.value || 0;
  }));
  list.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
    modalDeps.splice(+b.dataset.i, 1);
    renderDepList(deps);
    renderDepSelect(deps);
  }));
}

// 级联选择：先选需求（depModSelect），任务下拉（depSelect）仅列出该需求下可作前置的任务；
// 选中任务即自动添加为前置依赖（无需再点「添加」按钮），添加后下拉自动回退到占位项并刷新候选。
function renderDepTaskOptions(sel, list, deps) {
  const s = (list || []).sort((a, b) => (a.s || a.m || '').localeCompare(b.s || b.m || ''));
  sel.innerHTML = s.length
    ? '<option value="">选择任务（选中即添加）…</option>' + s.map(t =>
        `<option value="${t.id}">[${t.mod}] ${deps.sched.nameOf(t)}（${t.isMs ? t.m + ' 上线' : t.e + ' 结束'}）</option>`).join('')
    : '<option value="">该需求暂无可用任务</option>';
  sel.value = '';
  // 选中任务 → 立即添加为前置依赖并刷新候选（避免重复添加）；
  // renderDepSelect 内部会基于已更新的 modalDeps 重新过滤候选，且 depMod 保持当前需求不变
  sel.onchange = () => {
    const id = sel.value;
    if (!id) return;
    const wasMod = depMod;
    modalDeps.push({ id, lag: 0 });
    renderDepList(deps);
    renderDepSelect(deps);
    depMod = wasMod;   // 保持当前需求，仅刷新候选任务
    const ms = deps.getEl('depModSelect');
    if (ms) ms.value = wasMod;
  };
}

function renderDepSelect(deps) {
  const modSel = deps.getEl('depModSelect');
  const sel = deps.getEl('depSelect');
  if (!modSel || !sel) return;
  const taken = new Set(modalDeps.map(d => d.id));
  const tasks = deps.sched.tasks()
    .filter(t => t.id !== curTaskId(deps) && !taken.has(t.id));
  // 按需求分组
  const byMod = new Map();
  tasks.forEach(t => {
    const arr = byMod.get(t.mod) || [];
    arr.push(t);
    byMod.set(t.mod, arr);
  });
  const modNames = [...byMod.keys()].sort((a, b) => a.localeCompare(b));
  modSel.innerHTML = modNames.length
    ? '<option value="">选择需求…</option>' + modNames.map(n => `<option value="${n}">${n}</option>`).join('')
    : '<option value="">无可用需求</option>';
  // 校验当前选中需求：失效则回退到第一个
  const cur = depMod && modNames.includes(depMod) ? depMod : (modNames[0] || '');
  depMod = cur;
  modSel.value = cur;
  // 渲染任务下拉（该需求下可选任务）
  renderDepTaskOptions(sel, byMod.get(cur) || [], deps);
  // 需求切换 → 级联刷新任务下拉
  modSel.onchange = () => {
    depMod = modSel.value || '';
    renderDepTaskOptions(sel, byMod.get(depMod) || [], deps);
  };
}

// ============ 抽屉控件事件绑定（一次性，dom 常驻部分） ============
function bindTaskDrawerControls(deps) {
  const g = deps.getEl;
  const on = (id, fn) => { const el = g(id); if (el) el.addEventListener('click', fn); };
  const onInp = (id, ev, fn) => { const el = g(id); if (el) el.addEventListener(ev, fn); };

  // 类型切换（普通任务 <-> 里程碑）；新建/编辑共用
  const segType = g('segType');
  if (segType) segType.querySelectorAll('.btn').forEach(b => b.addEventListener('click', () => {
    draftIsMs = b.dataset.ms === 'true';
    renderSegType(draftIsMs, deps);
    applyMilestoneView(draftIsMs, deps);
    if (newTaskMode) {
      // 新建模式：仅切换字段显隐与提示，日期始终可编辑
      g('inpStart').disabled = false;
      g('taskHint').textContent = draftIsMs
        ? '里程碑（0 天周期，代表某个时间点）：指定上线日期'
        : '普通任务：指定开始日期与持续天数';
      return;
    }
    if (!curTaskId(deps)) return;
    const t = deps.sched.getTask(curTaskId(deps));
    if (!t) return;
    if (draftIsMs) {
      fillMsForm(t, deps);
    } else {
      fillTaskForm(t, deps);
      if (t.m) {
        renderSeg(true, deps);
        g('inpStart').disabled = false;
      }
    }
  }));

  // 计划模式切换（手动/自动）
  const segManual = g('segManual');
  if (segManual) segManual.querySelectorAll('.btn').forEach(b => b.addEventListener('click', () => {
    const manual = b.dataset.manual === 'true';
    renderSeg(manual, deps);
    g('inpStart').disabled = !manual;
    g('taskHint').textContent = draftIsMs
      ? (manual
          ? '里程碑（0 天周期，代表某个时间点）：手动模式可指定上线日期，或拖拽菱形标记调整'
          : '里程碑（0 天周期，代表某个时间点）：自动模式由前置依赖自动计算上线日期，可拖拽菱形标记锁定')
      : (manual
          ? '手动计划：日期被锁定，与依赖/资源冲突时将在排期问题中标记'
          : '自动计划任务由依赖与资源自动计算日期');
  }));

  on('btnCloseTaskDrawer', () => closeDrawer(deps));

  // 保存任务（新建/编辑共用同一表单）
  on('btnSaveTask', () => {
    const manualBtn = g('segManual').querySelector('.btn.on');
    const manual = !!manualBtn && manualBtn.dataset.manual === 'true';
    const start = g('inpStart').value;

    // 新建模式：sched.addTask
    if (newTaskMode) {
      const mod = g('inpMod') ? g('inpMod').value : '';
      if (!mod) { deps.toast('请选择需求'); return; }
      if (!start) { deps.toast('请选择' + (draftIsMs ? '上线' : '开始') + '日期'); return; }
      const p = g('inpPhase') ? g('inpPhase').value : 'dev';
      const name = g('inpName').value.trim();
      let newId;
      try {
        if (draftIsMs) {
          newId = deps.sched.addTask({ mod, p, name, type: 'ms', start, manual });
        } else {
          const dur = Math.max(1, +g('inpW').value || 1);
          newId = deps.sched.addTask({ mod, p, name, type: 'task', start, dur, manual, res: [...curModalRes(deps)] });
        }
      } catch (err) { deps.toast(err.message); return; }
      // addTask 不接收 dep：新建后补写前置依赖。
      // 必须显式带 type：否则 saveTask 会把新建的里程碑误判为"转成普通任务"（删除 m 且 res 未初始化）
      if (modalDeps.length) deps.sched.saveTask(newId, { type: draftIsMs ? 'ms' : 'task', dep: modalDeps.map(d => ({ ...d })) });
      newTaskMode = null;
      closeDrawer(deps);
      deps.render();
      deps.toast(draftIsMs ? '已新增里程碑' : '已新增任务');
      return;
    }

    // 编辑模式：sched.saveTask
    if (!curTaskId(deps)) return;
    const t = deps.sched.getTask(curTaskId(deps));
    if (!t) return;
    const mod = g('inpMod') ? g('inpMod').value : '';
    const p = g('inpPhase') ? g('inpPhase').value : '';
    const draft = {
      type: draftIsMs ? 'ms' : 'task',
      name: g('inpName').value.trim(),
      start: start || undefined,
      dur: +g('inpW').value || undefined,
      manual,
      done: draftIsMs ? undefined : Math.min(100, Math.max(0, +g('inpProgress').value || 0)),
      res: draftIsMs ? undefined : [...curModalRes(deps)],
      dep: modalDeps.map(d => ({ ...d })),
      mod,   // 归属变更：改需求（跨需求移动）/ 阶段
      p
    };
    deps.sched.saveTask(curTaskId(deps), draft);
    closeDrawer(deps);
    deps.render();
    const moved = mod && t.mod && mod !== t.mod;
    deps.toast(moved ? `已保存并移动到「${mod}」` : '已保存');
  });

  // 任务抽屉内「管理资源」快捷入口（源 gantt-app.js btnDrawerResLib）
  on('btnDrawerResLib', () => {
    if (deps.reslib && typeof deps.reslib.openResLib === 'function') {
      deps.reslib.openResLib();
    }
  });

  // 撤销忽略
  on('btnUnignore', () => {
    deps.sched.unignore(curTaskId(deps));
    const b = g('btnUnignore'); if (b) b.hidden = true;
    deps.render();
    deps.toast('已取消忽略');
  });

  // 删除任务
  on('btnDeleteTask', () => {
    if (!curTaskId(deps)) return;
    const t = deps.sched.getTask(curTaskId(deps));
    if (!t) return;
    const name = deps.sched.nameOf(t);
    if (!confirm(`确认删除任务「${name}」？此操作不可撤销。`)) return;
    deps.sched.deleteTask(curTaskId(deps));
    closeDrawer(deps);
    deps.render();
    deps.toast('已删除任务');
  });

  // 开始日期变更：联动结束日期与工作量（新建/编辑共用）
  onInp('inpStart', 'change', e => {
    if (draftIsMs) return;
    if (!e.target.value) return;
    if (newTaskMode) {
      const days = Math.max(1, +g('inpW').value || 1);
      const end = deps.workday.addWorkdays(new Date(e.target.value), days);   // 工作量→结束日（处理节假日）
      g('inpEnd').value = deps.sched.fmt(end);
      g('lblWork').textContent = days + ' 人天';
      return;
    }
    const t = deps.sched.getTask(curTaskId(deps));
    if (!t || t.isMs) return;
    const work = Math.max(1, deps.workday.workDays(t.s, t.e) || 1);   // 保留原工作量（人天）
    const end = deps.workday.addWorkdays(new Date(e.target.value), work);   // 工作量→结束日（处理节假日）
    g('inpEnd').value = deps.sched.fmt(end);
    g('lblWork').textContent = work + ' 人天';
    g('inpW').value = work;
  });
  // 工作量（人天）变更：按工作日推算结束日（自动跳过周末/节假日）
  onInp('inpW', 'input', e => {
    if (draftIsMs || !e.target.value) return;
    const days = Math.max(1, +e.target.value || 1);
    const startStr = g('inpStart').value;
    const start = startStr ? new Date(startStr) : (curTaskId(deps) && deps.sched.getTask(curTaskId(deps)) ? deps.sched.F(deps.sched.getTask(curTaskId(deps)).s) : null);
    if (!start) return;
    const end = deps.workday.addWorkdays(start, days);   // 工作量→结束日（处理节假日）
    g('inpEnd').value = deps.sched.fmt(end);
    g('lblWork').textContent = days + ' 人天';
  });
  // 进度滑块同步
  onInp('inpProgress', 'input', e => {
    const v = Math.min(100, Math.max(0, +e.target.value || 0));
    g('lblProgress').textContent = v + '%';
  });
  // 一键完成
  on('btnQuickComplete', () => {
    g('inpProgress').value = 100;
    g('lblProgress').textContent = '100%';
  });

  // 排期问题抽屉开关
  on('btnProblems', () => {
    if (getPanel() === 'prob') closeDrawer(deps); else openProblemDrawer(deps);
  });
  on('btnCloseDrawer', () => closeDrawer(deps));
  on('drawerMask', () => closeDrawer(deps));
  on('btnAutoFixAll', () => {
    const ids = [...new Set(deps.sched.problems().map(p => p.taskId))];
    ids.forEach(id => deps.sched.resolveAuto(id));
    deps.toast(`已自动调整 ${ids.length} 项问题`);
    renderProbList(deps);
    updateProblemBadge(deps);
    deps.render();
  });

  // 任务编辑抽屉内问题区域按钮的事件委托（一次性绑定，避免重复监听）
  const fIssue = g('fIssue');
  if (fIssue) {
    fIssue.addEventListener('click', ev => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      ev.stopPropagation();
      const id = btn.dataset.taskId;
      if (!id) return;
      if (btn.classList.contains('iss-auto')) {
        deps.sched.resolveAuto(id);
        deps.toast('已自动调整排期');
      } else if (btn.classList.contains('iss-ignore')) {
        deps.sched.resolveIgnore(id);
        deps.toast('已忽略该问题');
      }
      // 刷新: 重绘甘特 + 更新问题徽标 + 重新填充当前任务表单
      deps.render();
      updateProblemBadge(deps);
      const cur = curTaskId(deps);
      if (cur) {
        const updated = deps.sched.getTask(cur);
        if (updated) fillTaskForm(updated, deps);
      }
    });
  }
}

// 关闭抽屉时退出新建模式（外壳关闭时会回调；只注册一次，重复 bind 不叠加）
let closeHookBound = false;

// 装配入口：绑定控件事件，返回任务抽屉对外能力
export function bindTaskDrawer(deps) {
  if (!closeHookBound) {
    closeHookBound = true;
    onDrawerClose(() => { newTaskMode = null; });
  }
  bindTaskDrawerControls(deps);
  return {
    openTaskDrawer: id => openTaskDrawer(id, deps),
    openNewTaskDrawer: opts => openNewTaskDrawer(opts, deps),
    closeDrawer: () => closeDrawer(deps),
    renderResPicker: () => renderResPicker(deps)
  };
}
