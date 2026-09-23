// ============================================================
// src/components/modals.js — 新增/编辑需求抽屉
// 新增任务已统一走任务详情抽屉（与编辑任务同一表单，见 drawers.js openNewTaskDrawer），
// 需求表单同为一套抽屉（#modNewDrawer），本文件保留：
//   openNewModModal/openEditModModal/closeNewModModal
//   + btnAddTask（打开新建任务抽屉）/ btnAddModule 及保存/取消/删除事件
// 依赖注入（deps）：sched/planStore/render/toast/getEl/（新增需求需 deps.viewState.collapsed 写折叠态）
// 只读：可编辑守卫在 SCHED 内（addModule 抛错），此处 UI 由工具栏 disabled 禁用
// ============================================================
import { moduleTag } from '../core/mod-tag.js';
import { nextModuleColor, resolveModuleColors, resolveChosenColor } from '../core/mod-color.js';
import { MODULE_PHASES, MODULE_MILESTONE_PHASES, PRIORITY_DEFAULT, normalizePriority } from '../core/default-data.js';

let modEditName = null;   // 编辑模式：当前正在编辑的需求名（null=新增模式）

// 渲染「初始化阶段」勾选框（按 MODULE_PHASES 默认模板顺序；defaultAll=true 时全部默认勾选）
// 回归测试不在默认模板内（属项目级「回归验证」），故不在此列出
function renderPhaseChecks(deps, defaultAll) {
  const g = deps.getEl;
  const box = g('newModPhases');
  if (!box) return;
  const keys = MODULE_PHASES.filter(k => deps.PNAME[k]);
  box.innerHTML = keys.map(k => `
    <label class="phase-chip">
      <input type="checkbox" value="${k}" ${defaultAll ? 'checked' : ''}>
      <span>${deps.PNAME[k]}</span>${MODULE_MILESTONE_PHASES.includes(k) ? '<i class="phase-ms">里程碑</i>' : ''}
    </label>`).join('');
}

// 读取当前勾选的阶段 key 数组（保持默认模板顺序）
function selectedPhases(deps) {
  const g = deps.getEl;
  const box = g('newModPhases');
  if (!box) return null;
  const selected = new Set(
    Array.from(box.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value)
  );
  const result = MODULE_PHASES.filter(k => deps.PNAME[k] && selected.has(k));
  return result.length ? result : null;
}

// 颜色提示：选中的色若与其它需求撞色，会被 resolveModuleColors 去重改写，
// 提前告知，避免出现「保存后颜色自己变了 / 弹窗与图上不一致」的困惑
function refreshModColorTip(deps) {
  const el = deps.getEl('newModTagcTip');
  const inp = deps.getEl('newModTagc');
  if (!el || !inp) return;
  const chosen = inp.value;
  const actual = resolveChosenColor(chosen, deps.planStore.state.modules, modEditName);
  if (actual && actual !== chosen) {
    el.textContent = `该颜色已被其他需求使用，实际将显示为 ${actual}`;
    el.style.color = '#d97706';
  } else {
    el.textContent = '';
    el.style.color = '';
  }
}

function openNewModModal(deps) {
  modEditName = null;
  const g = deps.getEl;
  g('modModalTitle').textContent = '新增需求';
  g('newModName').value = '';
  g('newModTag').value = '';
  // 默认色按色板顺延取一个未被占用的：沿用固定 #3b82f6 会让新需求彼此同色，
  // 任务条也就失去区分作用
  g('newModTagc').value = nextModuleColor(deps.planStore.state.modules);
  refreshModColorTip(deps);
  g('newModDesc').value = '';
  g('newModDocUrl').value = '';
  renderModSchedSeg(false, deps);   // 默认「已排期」
  renderModPriSeg(PRIORITY_DEFAULT, deps);   // 新建默认 P2（未设置留给历史数据）
  g('btnNewModSave').textContent = '创建';
  const delBtn = g('btnDelMod'); if (delBtn) delBtn.style.display = 'none';
  const phaseRow = g('rowNewModPhases'); if (phaseRow) phaseRow.style.display = '';
  renderPhaseChecks(deps, true);
  g('modNewMask').classList.add('show');
  g('modNewDrawer').classList.add('open');
}

function openEditModModal(modName, deps) {
  const mo = deps.planStore.state.modules.find(m => m.name === modName);
  if (!mo) return;
  modEditName = modName;
  const g = deps.getEl;
  const { tag: autoTag, tagc: autoTagc } = moduleTag(mo, typeof deps.today === 'function' ? deps.today() : (deps.today || new Date()));
  // 兜底色取该需求当前实际生效的识别色（与任务条色条一致），而非状态标签色
  const modColors = resolveModuleColors(deps.planStore.state.modules);
  g('modModalTitle').textContent = '编辑需求';
  g('newModName').value = mo.name;
  g('newModTag').value = mo.tag || autoTag;
  // 回显「实际生效色」而非 mo.tagc：撞色需求会被 resolveModuleColors 补色，
  // 回显原始 tagc 会让弹窗与图上的条色 / 色点对不上（历史数据里 tagc 默认全是同一个蓝）
  g('newModTagc').value = modColors[mo.name] || mo.tagc || autoTagc;
  refreshModColorTip(deps);
  g('newModDesc').value = mo.desc || '';
  g('newModDocUrl').value = mo.docUrl || '';
  renderModSchedSeg(!!mo.unscheduled, deps);
  // 回显实际值：老数据无 pri 时选中「无」，保存后仍是未设置
  renderModPriSeg(mo.pri, deps);
  g('btnNewModSave').textContent = '保存';
  const delBtn = g('btnDelMod'); if (delBtn) { delBtn.style.display = ''; delBtn.dataset.modName = modName; }
  const phaseRow = g('rowNewModPhases'); if (phaseRow) phaseRow.style.display = 'none';  // 阶段选择仅用于新建
  g('modNewMask').classList.add('show');
  g('modNewDrawer').classList.add('open');
}

function closeNewModModal(deps) {
  const m = deps.getEl('modNewMask'), d = deps.getEl('modNewDrawer');
  if (m) m.classList.remove('show');
  if (d) d.classList.remove('open');
  modEditName = null;
}

// 排期状态分段控件（true=待排期）：待排期需求只登记不排期
function renderModSchedSeg(unscheduled, deps) {
  const box = deps.getEl('segModSched');
  if (!box) return;
  box.querySelectorAll('.btn').forEach(b => b.classList.toggle('on', (b.dataset.unsched === 'true') === !!unscheduled));
}

// 优先级分段控件：无 / P0~P3。
// 「无」是合法状态 —— 历史数据没有 pri 字段，编辑时必须能原样保留「未设置」，
// 否则一打开编辑再保存就替用户臆造了一个优先级。
function renderModPriSeg(pri, deps) {
  const box = deps.getEl('segModPri');
  if (!box) return;
  const cur = normalizePriority(pri) || '';
  box.querySelectorAll('.btn').forEach(b => b.classList.toggle('on', (b.dataset.pri || '') === cur));
}

// 读取当前选中的优先级（'' = 未设置）
function readModPri(deps) {
  const box = deps.getEl('segModPri');
  const on = box ? box.querySelector('.btn.on') : null;
  return (on && on.dataset.pri) || '';
}

// 读取当前选中的排期状态
function readModSched(deps) {
  const box = deps.getEl('segModSched');
  const on = box ? box.querySelector('.btn.on') : null;
  return !!(on && on.dataset.unsched === 'true');
}

// 一次性绑定弹窗控件事件
function bindModalControls(deps) {
  const g = deps.getEl;
  const on = (id, fn) => { const el = g(id); if (el) el.addEventListener('click', fn); };

  // 新增任务：统一打开任务抽屉的新建模式（与编辑任务同一表单）
  on('btnAddTask', () => {
    if (deps.drawers && deps.drawers.openNewTaskDrawer) deps.drawers.openNewTaskDrawer();
  });
  on('btnAddModule', () => openNewModModal(deps));
  on('btnNewModCancel', () => closeNewModModal(deps));
  on('btnCloseModDrawer', () => closeNewModModal(deps));   // 抽屉头部的「× 关闭」
  on('modNewMask', () => closeNewModModal(deps));

  // 阶段快捷操作：全选 / 全不选
  const setAllPhases = (checked) => {
    const box = g('newModPhases');
    if (!box) return;
    box.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = checked; });
  };
  on('btnPhaseAll', () => setAllPhases(true));
  on('btnPhaseNone', () => setAllPhases(false));

  // 排期状态：二选一分段控件
  const segSched = g('segModSched');
  if (segSched) segSched.querySelectorAll('.btn').forEach(b => b.addEventListener('click', () => {
    segSched.querySelectorAll('.btn').forEach(x => x.classList.toggle('on', x === b));
  }));

  // 优先级：多选一分段控件（含「无」）
  const segPri = g('segModPri');
  if (segPri) segPri.querySelectorAll('.btn').forEach(b => b.addEventListener('click', () => {
    segPri.querySelectorAll('.btn').forEach(x => x.classList.toggle('on', x === b));
  }));

  // 需求颜色：实时提示撞色（input 事件在取色器拖动过程中连续触发，所见即所改）
  const tagcInp = g('newModTagc');
  if (tagcInp) tagcInp.addEventListener('input', () => refreshModColorTip(deps));

  // 需求文档只放行 http/https：拦掉 javascript: 之类的伪协议（点开即执行）
  const readDocUrl = () => {
    const v = (g('newModDocUrl').value || '').trim();
    if (!v) return { ok: true, value: '' };
    return /^https?:\/\//i.test(v)
      ? { ok: true, value: v }
      : { ok: false, msg: '文档链接需以 http:// 或 https:// 开头' };
  };

  on('btnNewModSave', () => {
    const name = g('newModName').value.trim();
    if (!name) { deps.toast('需求名称不能为空'); return; }
    const doc = readDocUrl();
    if (!doc.ok) { deps.toast(doc.msg); return; }
    if (modEditName) {
      // 编辑模式
      if (name !== modEditName && deps.planStore.state.modules.some(m => m.name === name)) {
        deps.toast('需求已存在：' + name); return;
      }
      try {
        // tagc 落「实际生效色」：与去重逻辑、后续弹窗回显保持同一口径
        deps.sched.updateModule({ oldName: modEditName, name, tag: g('newModTag').value.trim(), tagc: resolveChosenColor(g('newModTagc').value, deps.planStore.state.modules, modEditName), unscheduled: readModSched(deps), pri: readModPri(deps), desc: g('newModDesc').value, docUrl: doc.value });
        const collapsed = deps.viewState.collapsed;
        collapsed[name] = collapsed[modEditName];
        if (name !== modEditName) delete collapsed[modEditName];
        closeNewModModal(deps);
        deps.render();
        deps.toast('已更新需求');
      } catch (err) { deps.toast(err.message); }
    } else {
      // 新增模式
      if (deps.planStore.state.modules.some(m => m.name === name)) { deps.toast('需求已存在：' + name); return; }
      const phases = selectedPhases(deps);
      if (phases === null) { deps.toast('请至少选择一个要初始化的阶段'); return; }
      deps.sched.addModule({ name, tag: g('newModTag').value.trim(), tagc: resolveChosenColor(g('newModTagc').value, deps.planStore.state.modules, null), phases, unscheduled: readModSched(deps), pri: readModPri(deps), desc: g('newModDesc').value, docUrl: doc.value });
      closeNewModModal(deps);
      deps.viewState.collapsed[name] = false;
      deps.render();
      deps.toast('已新增需求');
    }
  });

  on('btnDelMod', () => {
    const delName = g('btnDelMod').dataset.modName;
    if (!delName) return;
    if (!confirm(`确认删除需求「${delName}」及其所有任务？此操作不可撤销。`)) return;
    deps.sched.deleteModule(delName);
    delete deps.viewState.collapsed[delName];
    closeNewModModal(deps);
    deps.render();
    deps.toast('已删除需求');
  });
}

export function bindModals(deps) {
  bindModalControls(deps);
  return {
    openNewModModal: () => openNewModModal(deps),
    openEditModModal: (modName) => openEditModModal(modName, deps),
    closeNewModModal: () => closeNewModModal(deps)
  };
}
