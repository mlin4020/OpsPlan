// ============================================================
// src/components/version-page.js — 版本（迭代）页面的交互
//
// 绑定策略与项目其它页面一致：
//   · 页面内的按钮全部通过 [data-ver-*] 属性委托在 #gantt 上（委托只绑一次，
//     重绘不会丢事件，也无需每次 innerHTML 后重新绑定）；
//   · 表单集中在 shell.js 的一个弹窗里（新建 / 编辑 / 加需求三合一）；
//   · 所有改数据的入口（含弹窗打开）都先过只读判断，双击路径不会绕过。
//
// 一个刻意设计：弹窗底部没有「删除版本」——删除是不可撤销的破坏性操作，
// 放在卡片操作区（带 confirm）比放在表单里更不容易误点。
// ============================================================
import { fmt } from '../core/dates.js';
import { isReadonly } from '../utils/readonly.js';
import { findVersion, versionOfMap, versionMembers, versionStatus } from '../core/versions.js';
import { toggleVersionExpanded, isVersionExpanded, setVersionPage, versionPageOf } from '../views/version-view.js';

const SEL = '[data-ver-new],[data-ver-edit],[data-ver-toggle],[data-ver-page],[data-ver-add],[data-ver-remove],[data-ver-ship],[data-ver-unship],[data-ver-archive],[data-ver-del]';

export function bindVersionPage(deps) {
  const doc = deps.doc;
  const g = deps.getEl;
  let editingId = null;   // 弹窗正在编辑的版本 id（null = 新建）

  const todayStr = () => fmt(new Date());

  // 弹窗是否打开（供 Esc 关闭链判断）
  const isModalOpen = () => {
    const m = g('verModal');
    return !!(m && m.classList.contains('show'));
  };

  // ---- 弹窗：新建 / 编辑（改名 · 改上线日 · 勾选成员） ----
  function openModal(id) {
    if (isReadonly()) return;
    editingId = id || null;
    const state = deps.planStore.state;
    const v = id ? findVersion(state, id) : null;
    const title = g('verModalTitle');
    if (title) title.textContent = v ? `编辑版本 · ${v.name}` : '新建版本';
    const nameEl = g('inpVerName');
    if (nameEl) nameEl.value = v ? v.name : '';
    const dateEl = g('inpVerDate');
    if (dateEl) dateEl.value = (v && v.date) || todayStr();
    // 实际上线日：只对"已标记上线"的版本开放（没上线就谈不上实际日期）
    const actualRow = g('verActualRow');
    const actualEl = g('inpVerActual');
    if (actualRow) actualRow.hidden = !(v && v.shipped);
    if (actualEl) actualEl.value = (v && v.shippedAt) || (v && v.date) || todayStr();
    renderPicker(v);
    const mask = g('verMask'), modal = g('verModal');
    if (mask) mask.classList.add('show');
    if (modal) modal.classList.add('show');
    if (nameEl && nameEl.focus) nameEl.focus();
  }

  function closeModal() {
    const mask = g('verMask'), modal = g('verModal');
    if (mask) mask.classList.remove('show');
    if (modal) modal.classList.remove('show');
    editingId = null;
  }

  // 成员勾选列表。不可选的两种：已归档（已收口，与"待上线"语义冲突）、已在别的版本（1 需求 : 1 版本）
  function renderPicker(v) {
    const box = g('verPicker');
    if (!box) return;
    const state = deps.planStore.state;
    const mods = state.modules || [];
    if (!mods.length) {
      box.innerHTML = '<div class="ver-pick-empty">还没有需求 · 先建需求再放进版本</div>';
      return;
    }
    const owner = versionOfMap(state.versions);
    box.innerHTML = mods.map(mo => {
      const ow = owner[mo.name];
      const mine = !!(v && (v.mods || []).includes(mo.name));
      const taken = !!ow && (!v || ow.id !== v.id);
      const off = !!mo.archived || taken;
      const hint = mo.archived ? '已归档' : (taken ? `已在 ${ow.name}` : '');
      return `<label class="ver-pick-item${off ? ' off' : ''}">
        <input type="checkbox" value="${mo.name}"${mine ? ' checked' : ''}${off ? ' disabled' : ''}>
        <span class="ver-pick-name" title="${mo.name}">${mo.name}</span>
        ${hint ? `<span class="ver-pick-hint">${hint}</span>` : ''}
      </label>`;
    }).join('');
  }

  function save() {
    const nameEl = g('inpVerName');
    const dateEl = g('inpVerDate');
    const box = g('verPicker');
    const picked = box
      ? [...box.querySelectorAll('input[type=checkbox]')].filter(i => i.checked && !i.disabled).map(i => i.value)
      : [];
    const patch = {
      name: nameEl ? nameEl.value : '',
      date: dateEl ? dateEl.value : '',
      mods: picked
    };
    const actualRow = g('verActualRow');
    const actualEl = g('inpVerActual');
    if (actualRow && !actualRow.hidden && actualEl && actualEl.value) patch.shippedAt = actualEl.value;
    try {
      const r = editingId ? deps.sched.updateVersion(editingId, patch) : deps.sched.createVersion(patch);
      // 新建 / 改上线日都可能让这个版本落在别的页上：把它的那一页翻出来再重绘，
      // 否则用户"保存完看不见自己刚建的版本"（版本页每页 6 个，列表一长必踩）
      const vid = r && r.version && r.version.id;
      if (vid) setVersionPage(versionPageOf(deps.planStore.state, vid));
      closeModal();
      deps.render();
      const rej = (r && r.rejected) || [];
      deps.toast(rej.length
        ? `已保存 · ${rej.length} 个需求未加入（${rej[0].name}：${rej[0].reason}）`
        : '已保存');
    } catch (e) {
      deps.toast(e && e.message ? e.message : '保存失败');
    }
  }

  // ---- 页面内点击委托 ----
  function onClick(e) {
    const t = e.target;
    const el = (t && t.closest) ? t.closest(SEL) : null;
    if (!el) return;
    const d = el.dataset || {};

    // 打开弹窗 / 展开收起：只读下也允许（纯查看）
    if (d.verNew != null) { openModal(null); return; }
    if (d.verEdit != null) { openModal(d.verEdit); return; }
    if (d.verAdd != null) { openModal(d.verAdd); return; }
    if (d.verToggle != null) { toggleVersionExpanded(d.verToggle); deps.render(); return; }
    // 翻页：纯查看动作，只读下也要能用（导出件里版本多了一样得翻）
    if (d.verPage != null) { setVersionPage(d.verPage); deps.render(); return; }

    if (isReadonly()) return;   // 以下都会改数据

    if (d.verRemove != null) {
      if (!confirm(`把「${d.mod}」从本版本移出？\n移出后它的「上线」日期恢复为跟随任务自动计算。`)) return;
      deps.sched.removeModFromVersion(d.verRemove, d.mod);
      deps.render();
      deps.toast(`已移出「${d.mod}」`);
      return;
    }

    if (d.verShip != null) {
      const state = deps.planStore.state;
      const v = findVersion(state, d.verShip);
      if (!v) return;
      const st = versionStatus(v, state, deps.today());
      if (st.key !== 'shipped' && st.key !== 'ready'
        && !confirm(`「${v.name}」里还有需求没完成，确认已经上线？\n（标记后版本变只读，可随时取消）`)) return;
      deps.sched.shipVersion(d.verShip, true);
      deps.render();
      deps.toast('已标记上线 · 实际上线日可在「编辑」里调整');
      return;
    }

    if (d.verUnship != null) {
      if (!confirm('取消「已上线」标记？版本会恢复为可编辑。')) return;
      deps.sched.shipVersion(d.verUnship, false);
      deps.render();
      deps.toast('已取消上线标记');
      return;
    }

    if (d.verArchive != null) {
      const state = deps.planStore.state;
      const v = findVersion(state, d.verArchive);
      if (!v) return;
      const n = versionMembers(v, state).filter(mo => !mo.archived).length;
      if (!n) { deps.toast('该版本的需求都已归档'); return; }
      if (!confirm(`把「${v.name}」的 ${n} 个需求全部归档？\n归档后不再显示在排期视图与统计里（可在「归档」页恢复）。`)) return;
      const cnt = deps.sched.archiveVersionMods(d.verArchive);
      deps.render();
      deps.toast(`已归档 ${cnt} 个需求`);
      return;
    }

    if (d.verDel != null) {
      const v = findVersion(deps.planStore.state, d.verDel);
      if (!v) return;
      if (!confirm(`删除版本「${v.name}」？\n成员需求本身不会被删除，它们的「上线」日期恢复为跟随任务自动计算。`)) return;
      deps.sched.deleteVersion(d.verDel);
      deps.render();
      deps.toast(`已删除版本「${v.name}」`);
      return;
    }
  }

  // 成员行「改版本」下拉：一次完成"从本版本移出 + 加入目标版本"（见 scheduler 的 setModuleVersion）。
  // 与点需求卡片上的「移出」不同，这里不需要 confirm —— 目标是明确的另一个版本，
  // 不是"移出去悬空"，且改错了再改回来即可。
  function onChange(e) {
    const t = e.target;
    const el = (t && t.closest) ? t.closest('[data-ver-move]') : null;
    if (!el) return;
    const from = el.dataset.verMove;      // 原版本 id：失败 / 位置没变时用它回滚
    if (isReadonly()) { el.value = from; return; }
    const name = el.dataset.mod;
    const to = el.value;
    if (!to || to === from) return;
    try {
      const r = deps.sched.setModuleVersion(name, to);
      const target = r && r.to;
      // 把目标版本卡展开、并翻到它所在的那一页：改完那一行会从当前卡里消失，
      // 不展开 / 不翻页就等于"点完没反应，需求不见了"。先切状态再重绘，避免多画一次。
      if (target) {
        if (!isVersionExpanded(target.id)) toggleVersionExpanded(target.id);
        setVersionPage(versionPageOf(deps.planStore.state, target.id));
      }
      deps.render();
      deps.toast(target ? `已把「${name}」调整到「${target.name}」` : `已把「${name}」移出版本`);
    } catch (err) {
      el.value = from;
      deps.toast(err && err.message ? err.message : '调整版本失败');
    }
  }

  // 委托绑在 #gantt 上（版本页内容在它内部重绘）；弹窗的按钮在 shell 里，单独绑
  if (deps.gantt) {
    deps.gantt.addEventListener('click', onClick);
    deps.gantt.addEventListener('change', onChange);
  }
  const mask = g('verMask');
  if (mask) mask.addEventListener('click', closeModal);
  const btnSave = g('btnSaveVer');
  if (btnSave) btnSave.addEventListener('click', save);
  const btnCancel = g('btnCancelVer');
  if (btnCancel) btnCancel.addEventListener('click', closeModal);
  // 上线日留空时浏览器会拦住提交，这里补一层：没选日期直接提示，避免"点了没反应"
  const dateEl = g('inpVerDate');
  if (dateEl) dateEl.required = true;

  return { openModal, closeModal, isModalOpen, renderPicker };
}
