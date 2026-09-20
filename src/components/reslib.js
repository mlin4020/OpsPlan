// ============================================================
// src/components/reslib.js — 资源库弹窗（人员 / 职位增删改）
// 由 gantt-app.js 1244-1310 行迁移：
//   openResLib/closeResLib/renderResLib/openResEdit/saveResEdit
//   + btnResLib/btnCloseResLib/btnAddRes/btnSaveRes/btnCancelRes/resMask 事件
// 依赖注入（deps）：sched/planStore/render/toast/getEl/（任务抽屉资源分配需 deps.renderResPicker）
// ============================================================

let editResId = null;
let editResOldName = '';

function openResLib(deps) {
  renderResLib(deps);
  const m = deps.getEl('resMask'), d = deps.getEl('resLibModal');
  if (m) m.classList.add('show');
  if (d) d.classList.add('show');
}

function closeResLib(deps) {
  const m = deps.getEl('resMask'), d = deps.getEl('resLibModal'), e = deps.getEl('resEditModal');
  if (m) m.classList.remove('show');
  if (d) d.classList.remove('show');
  if (e) e.classList.remove('show');
}

function renderResLib(deps) {
  const list = deps.getEl('resLibList');
  if (!list) return;
  list.innerHTML = (deps.planStore.state.resources || []).map(r => `
    <div class="res-lib-row">
      <span class="avatar" style="background:${r.color}">${r.name[0]}</span>
      <span class="rname">${r.name}</span><span class="rrole">${r.role || ''}</span>
      <span class="res-lib-acts">
        <button class="res-edit-btn" data-rid="${r.id}">编辑</button>
        <button class="res-edit-btn danger" data-del="${r.id}">删除</button>
      </span>
    </div>`).join('');
  list.querySelectorAll('[data-rid]').forEach(b => b.addEventListener('click', () => openResEdit(b.dataset.rid, deps)));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const r = (deps.planStore.state.resources || []).find(x => x.id === b.dataset.del);
    if (!r) return;
    if (!confirm(`确认删除资源「${r.name}」？其参与的所有任务将取消该资源分配。`)) return;
    deps.sched.deleteResource(b.dataset.del);
    renderResLib(deps);
    deps.render();
  }));
}

function openResEdit(id, deps) {
  editResId = id || null;
  const r = id ? (deps.planStore.state.resources || []).find(x => x.id === id) : null;
  editResOldName = r ? r.name : '';
  deps.getEl('resEditTitle').textContent = r ? '编辑资源' : '新增资源';
  deps.getEl('inpResName').value = r ? r.name : '';
  deps.getEl('inpResRole').value = r ? (r.role || '') : '';
  deps.getEl('inpResColor').value = r ? r.color : '#3b82f6';
  deps.getEl('resMask').classList.add('show');
  deps.getEl('resEditModal').classList.add('show');
}

function saveResEdit(deps) {
  const name = deps.getEl('inpResName').value.trim();
  if (!name) { deps.toast('名称不能为空'); return; }
  const role = deps.getEl('inpResRole').value.trim();
  const color = deps.getEl('inpResColor').value;
  if (editResId) {
    deps.sched.updateResource(editResId, { name, role, color });
    if (editResOldName && name !== editResOldName) {
      const mr = deps.shared ? deps.shared.modalRes : [];
      const i = mr.indexOf(editResOldName);
      if (i >= 0) mr[i] = name;
    }
  } else {
    deps.sched.addResource({ name, role, color });
  }
  if (deps.getEl('resLibModal').classList.contains('show')) renderResLib(deps);
  if (deps.shared && deps.shared.activeTaskId && deps.renderResPicker) deps.renderResPicker();
  deps.render();
  deps.getEl('resEditModal').classList.remove('show');
  if (!deps.getEl('resLibModal').classList.contains('show')) deps.getEl('resMask').classList.remove('show');
  deps.toast(editResId ? '已保存' : '已新增资源');
}

// 一次性绑定资源库弹窗控件事件
function bindResLibControls(deps) {
  const g = deps.getEl;
  const on = (id, fn) => { const el = g(id); if (el) el.addEventListener('click', fn); };
  on('btnResLib', () => openResLib(deps));
  on('btnCloseResLib', () => closeResLib(deps));
  on('btnAddRes', () => openResEdit(null, deps));
  on('btnSaveRes', () => saveResEdit(deps));
  on('btnCancelRes', () => {
    g('resEditModal').classList.remove('show');
    if (!g('resLibModal').classList.contains('show')) g('resMask').classList.remove('show');
  });
  on('resMask', () => closeResLib(deps));
}

export function bindResLib(deps) {
  bindResLibControls(deps);
  return {
    openResLib: () => openResLib(deps),
    closeResLib: () => closeResLib(deps),
    renderResLib: () => renderResLib(deps),
    saveResEdit: () => saveResEdit(deps)
  };
}
