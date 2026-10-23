// ============================================================
// src/components/req-page.js — 需求台账页的事件委托
//
// 为什么单独成模块（与 work-filter.js / version-page.js 同样的理由）：
// 筛选条与行操作要在两个入口都能用 ——
//   1) 排期页：components/index.js 的 bindAll 里调用；
//   2) 导出的单文件查看器：main-standalone.js 没有组件层，得自己调。
// 把绑定逻辑抽出来共用，避免"导出的页面里台账筛选点了没反应"。
//
// 一切都委托在 #gantt 容器上：renderAll 只替换它的 innerHTML，元素本身不换，
// 所以只需绑一次；筛选条每次重绘后被重建，委托链依旧有效。
//
// 唯一的坑是搜索框：重绘会连带把它一起换掉 → 焦点丢失，只能输进去一个字。
// 故记住光标位置，重绘后还原（与 work-filter.js 同一套处理）。
// ============================================================
import { defaultReqFilter, defaultReqSort } from '../core/mod-query.js';
import { userStore } from '../store/user-store.js';
import { ctxOf, canManageModule } from '../utils/permission.js';

// 行内编辑字段的中文名（提示文案用；未列出的字段只提示「已更新」）
// version 不在表里：它的提示要说出"调到哪个版本"，文案在 commitInline 里单独出
const INLINE_LABEL = { lifecycle: '生命周期', proposedBy: '提出人' };

export function bindReqPage(deps) {
  const g = deps && deps.gantt;
  const vs = deps && deps.viewState;
  if (!g || !vs || typeof g.addEventListener !== 'function') return null;
  // viewState 由各入口各自构造，这里兜底一份默认值 —— 免得两个入口都要记得加这两个字段
  if (!vs.reqFilter) vs.reqFilter = defaultReqFilter();
  if (!vs.reqSort) vs.reqSort = defaultReqSort();
  // 一律通过 curXxx() 取当前对象：重置 / 换入口时若整体替换了对象，闭包里的旧引用会失效
  const curF = () => vs.reqFilter;
  const curS = () => vs.reqSort;

  let caret = null;   // 搜索框重绘后要还原的光标位置（null = 本次不需要还原）

  // 查询条件落盘：防抖 300ms —— 搜索框是逐字触发的，
  // 不加防抖会每敲一个键就写一次 localStorage（同步 API，打多了会卡输入）
  let persistTimer = null;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (deps.saveReqView) deps.saveReqView(deps.projectId, curF(), curS());
    }, 300);
  };

  const apply = (opts) => {
    persist();
    if (typeof deps.render === 'function') deps.render();
    // 换筛选范围 = 列表整块重排，留在原滚动位置多半落进空白，故回到顶部；打字则保持原位
    if (opts && opts.top && deps.gsc) deps.gsc.scrollTop = 0;
    if (caret != null) {
      const el = g.querySelector && g.querySelector('[data-req-q]');
      if (el) {
        el.focus();
        if (el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch (e) { /* 类型不支持时忽略 */ } }
      }
      caret = null;
    }
  };

  const toggleExpand = (name) => {
    // 展开态由视图模块持有（跨重绘保持），这里只负责切换后重绘
    if (deps.toggleReqExpanded) deps.toggleReqExpanded(name);
    deps.render();
  };

  // 需求归属级动作（归档 / 删除）的判定：按这条需求归不归我，而不是"全局只读"。
  // 按钮本身已在视图层按同一口径不渲染；这里是第二道（旧 DOM 残留 / 其它入口）。
  // 找不到需求时不拦：那是行已失效（改名/删除后重绘前的瞬间），交给 sched 自己的守卫。
  const canManageMod = (name) => {
    const mods = (deps.planStore && deps.planStore.state && deps.planStore.state.modules) || null;
    if (!mods) return true;
    const mo = mods.find(m => m.name === name);
    return mo ? canManageModule(mo, ctxOf(userStore.state)) : true;
  };

  // 搜索框：输入即筛（实时），命中需求名与描述正文
  g.addEventListener('input', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-req-q]') : null;
    if (!el) return;
    caret = el.selectionStart == null ? 0 : el.selectionStart;
    curF().kw = el.value;
    apply();
  });

  // 行内编辑提交：只写真正变过的字段；失败时把控件回滚成原值，避免界面与数据不一致。
  // 生命周期下拉与提出人输入框都用 change —— 原生语义就是"值确定了"（输入框在失焦时触发）。
  const commitInline = (el) => {
    if (deps.isReadonly && deps.isReadonly()) return;
    const field = el.dataset.reqInline;
    const name = el.dataset.name;
    const prev = el.dataset.prev == null ? '' : el.dataset.prev;
    const next = String(el.value == null ? '' : el.value).trim();
    // 没变就不写、不重绘：否则每次点开下拉再关掉都会触发一次无谓的保存
    if (next === prev) return;
    try {
      // 所属版本是唯一的"不在需求上"的字段：需求侧不存 versionId，归属由版本侧的成员名单
      // 持有（见 core/versions.js），所以这里不能走 updateModule —— 传给它的 version 字段
      // 会被当成需求自身属性，静默什么也不做。改归属一次要同时落新旧两个版本的名单。
      if (field === 'version') {
        if (!deps.sched.setModuleVersion) throw new Error('当前入口不支持调整版本');
        const r = deps.sched.setModuleVersion(name, next || null);
        deps.render();
        const to = r && r.to;
        deps.toast(to ? `已调整到「${to.name}」` : '已移出版本');
        return;
      }
      deps.sched.updateModule({ oldName: name, [field]: next });
      deps.render();
      deps.toast(INLINE_LABEL[field] ? `已更新${INLINE_LABEL[field]}` : '已更新');
    } catch (err) {
      el.value = prev;
      deps.toast(err.message);
    }
  };

  // 提出人输入框：回车即提交。change 只在失焦时触发，不处理回车会让用户以为没生效
  g.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    const inline = t && t.closest ? t.closest('[data-req-inline]') : null;
    if (!inline) return;
    e.preventDefault();
    commitInline(inline);
  });

  // 下拉筛选：换范围 → 回到顶部
  // 行内编辑必须先判：它与筛选下拉一样都落在 change 上
  g.addEventListener('change', e => {
    const t = e.target;
    if (!t || !t.closest) return;
    const inline = t.closest('[data-req-inline]');
    if (inline) { commitInline(inline); return; }
    // 排序方式下拉：值编码成 "key:dir"
    const sortSel = t.closest('[data-req-sortsel]');
    if (sortSel) {
      const [key, dir] = String(sortSel.value || 'group:asc').split(':');
      const s = curS();
      s.key = key;
      s.dir = dir === 'desc' ? 'desc' : 'asc';
      apply({ top: true });
      return;
    }
    const el = t.closest('[data-req-f]');
    if (!el) return;
    curF()[el.dataset.reqF] = el.value || 'all';
    apply({ top: true });
  });

  // 拖拽排序（只在默认的「进行中优先」排序下渲染手柄，见 views/req-view.js 的 dragOn）
  let dragActive = false;   // 拖动中 / 刚松手的一瞬：拦住随后的 click，别把它当成"展开行"
  let dragName = null;      // 正在拖的需求名
  let dragTier = null;      // 它所属的分层档：只有同档的行才给落点

  g.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (dragActive) return;

    // ---- 只读模式下也要能用的：展开 / 收起、排序、重置 ----
    // ⚠ 行内操作按钮（编辑 / 归档 / 删除）与行内编辑控件（生命周期下拉 / 提出人输入框）
    //    都在 <tr data-req-row> 内部，所以展开判定必须先排除它们：否则 closest('[data-req-row]')
    //    先命中，"点编辑"会被当成"展开 / 收起"，行操作与行内编辑全部失效
    //    （回归见 tests/req-page.test.js）。
    const hitAct = !!(t.closest('[data-req-edit]') || t.closest('[data-req-archive]') || t.closest('[data-req-del]')
      || t.closest('[data-req-inline]'));
    const row = hitAct ? null : t.closest('[data-req-row]');
    if (row) { toggleExpand(row.dataset.reqRow); return; }

    const sortTh = t.closest('[data-req-sort]');
    if (sortTh) {
      const key = sortTh.dataset.reqSort;
      const s = curS();
      // 同列再点一次 = 反向；换列 = 该列升序
      if (s.key === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      else { s.key = key; s.dir = 'asc'; }
      apply({ top: true });
      return;
    }

    if (t.closest('[data-req-reset]')) {
      Object.assign(vs.reqFilter, defaultReqFilter());
      Object.assign(vs.reqSort, defaultReqSort());
      apply({ top: true });
      return;
    }

    // ---- 以下都会改数据 ----
    if (deps.isReadonly && deps.isReadonly()) return;

    if (t.closest('[data-req-new]')) {
      if (deps.modals) deps.modals.openNewModModal();
      return;
    }
    const edit = t.closest('[data-req-edit]');
    if (edit) {
      if (deps.modals) deps.modals.openEditModModal(edit.dataset.reqEdit);
      return;
    }
    const arch = t.closest('[data-req-archive]');
    if (arch) {
      const name = arch.dataset.name;
      if (!canManageMod(name)) return;
      const to = arch.dataset.archived === '1';
      deps.sched.archiveModule(name, !to);
      deps.render();
      deps.toast(to ? '已取消归档' : '已归档');
      return;
    }
    const del = t.closest('[data-req-del]');
    if (del) {
      const name = del.dataset.name;
      if (!canManageMod(name)) return;
      if (!confirm(`确认删除需求「${name}」及其所有任务？此操作不可撤销。`)) return;
      deps.sched.deleteModule(name);
      deps.render();
      deps.toast('已删除需求');
    }
  });

  // ---- 台账行拖动排序 ----
  // 为什么用原生 DnD 而不是鼠标位移模拟：与排期页的需求行排序是同一套交互
  // （gantt-interactions.js 的 setupRowDnD），两处手感一致，也不必再养一套拖拽实现。
  //
  // 拖拽改的是 modules 的数组顺序（sched.moveModule）—— 那就是甘特图顺序本身，
  // 所以台账里拖出来的次序，切到排期页看是同一次序。
  //
  // 两条硬规则：
  //   1) 只在同一分层档内换位。档位由需求状态自动算（进行中 / 待排期 / 已完成…），
  //      跨档拖动改变不了它属于哪一档，松手后照样被分组规则拉回原处 ——
  //      与其让用户白拖一次再看着它弹回去，不如直接拦住并说清楚。
  //   2) 只改顺序，不改状态、不改日期，也不动任何任务条。
  // 只清"这一下要落在哪儿"的提示；拖动本身的状态（源行变淡 / 异档变淡）留着
  const clearDropHints = () => {
    if (!g.querySelectorAll) return;
    g.querySelectorAll('.req-row.drop-hint-before,.req-row.drop-hint-after')
      .forEach(el => el.classList.remove('drop-hint-before', 'drop-hint-after'));
  };
  // 拖拽收尾：落点提示 + 源行 / 异档的淡化一起清掉
  const clearDragHints = () => {
    if (g.querySelectorAll) {
      g.querySelectorAll('.req-row.drop-hint-before,.req-row.drop-hint-after,.req-row.dragging,.req-row.req-dim')
        .forEach(el => el.classList.remove('drop-hint-before', 'drop-hint-after', 'dragging', 'req-dim'));
    }
    if (g.classList) g.classList.remove('req-dragging');
  };

  // 拖动期间把"不可落的档"整体变淡：可拖范围一眼可见，不必靠试错去发现
  const markDragScope = (srcRow, tier) => {
    if (g.classList) g.classList.add('req-dragging');
    if (!g.querySelectorAll) return;
    g.querySelectorAll('.req-row').forEach(r => {
      if (r !== srcRow && Number(r.dataset.reqTier) !== tier) r.classList.add('req-dim');
    });
  };

  // 落点在目标行的上半 → 插到它前面；下半 → 插到它后面（与排期页同一判定）
  const dropBefore = (e, row) => {
    const r = row.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  };

  g.addEventListener('dragstart', e => {
    const t = e.target;
    const handle = t && t.closest ? t.closest('[data-req-drag]') : null;
    if (!handle) return;
    // 只读模式下连拖都不让起：在事件层拦住比只靠 CSS 稳，避免"能拖但存不进去"
    if (deps.isReadonly && deps.isReadonly()) { e.preventDefault(); return; }
    const row = handle.closest('[data-req-row]');
    dragActive = true;
    dragName = handle.dataset.reqDrag;
    dragTier = row ? Number(row.dataset.reqTier) : NaN;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragName); } catch (err) { /* 老浏览器不认自定义 MIME，忽略 */ }
    }
    if (row && row.classList) row.classList.add('dragging');
    markDragScope(row, dragTier);
  });

  g.addEventListener('dragover', e => {
    if (dragName == null) return;
    const t = e.target;
    const row = t && t.closest ? t.closest('[data-req-row]') : null;
    // 离开有效的行（拖到表外 / 拖回自己身上）时把上一次的落点提示擦掉，
    // 否则光标早已移开，蓝线还留在原地指挥用户
    if (!row) { clearDropHints(); return; }
    // 跨档不 preventDefault → 浏览器显示"禁止放置"光标，也不会有 drop 事件
    if (Number(row.dataset.reqTier) !== dragTier || row.dataset.reqRow === dragName) { clearDropHints(); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearDropHints();
    row.classList.add(dropBefore(e, row) ? 'drop-hint-before' : 'drop-hint-after');
  });

  g.addEventListener('drop', e => {
    const from = dragName;
    if (from == null) return;
    const t = e.target;
    const row = t && t.closest ? t.closest('[data-req-row]') : null;
    const to = row ? row.dataset.reqRow : null;
    const before = row ? dropBefore(e, row) : false;
    dragName = null;
    if (!row || to === from) { clearDragHints(); return; }
    // 兜底：dragover 已按档拦住，这里再判一次，免得别的入口（如浏览器扩展）直接投递 drop
    if (Number(row.dataset.reqTier) !== dragTier) {
      clearDragHints();
      deps.toast('只能在同一分组内调整顺序');
      return;
    }
    e.preventDefault();
    deps.sched.moveModule(from, to, before);
    deps.render();
    deps.toast('已调整需求顺序');
  });

  g.addEventListener('dragend', () => {
    dragName = null;
    dragTier = null;
    clearDragHints();
    // 拖动结束后浏览器还会补一个 click，延迟清掉标记，免得那一下把行展开/收起
    setTimeout(() => { dragActive = false; }, 120);
  });

  // 新建需求后把它滚进视野并闪一下。
  //
  // 为什么需要：台账默认按「进行中优先」排序，新建的需求还没有任何任务，
  // 落在「待启动」档，会被排到列表靠下的位置 —— 建完还得手动翻下去才能接着
  // 给它加任务。排序逻辑本身没错（它就是"还没启动"），缺的是"建完把你带过去"。
  //
  // 标记由 components/modals.js 在创建成功后写入 viewState.focusMod，
  // 这里在每次重绘后消费一次（不消费会每次重绘都滚，用户就没法往下看了）。
  const focusPending = () => {
    const name = vs.focusMod;
    if (!name) return;
    vs.focusMod = null;   // 只定位一次
    const rows = g.querySelectorAll ? g.querySelectorAll('[data-req-row]') : [];
    // 按 dataset 比对而不是用属性选择器：需求名可能含引号等特殊字符
    const row = [...rows].find(r => r.dataset && r.dataset.reqRow === name);
    if (!row) return;     // 被当前筛选挡掉了：如实不做事，不硬找也不报错
    if (row.scrollIntoView) {
      try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch (e) { row.scrollIntoView(); }   // 老浏览器不认 options 对象
    }
    if (row.classList) {
      row.classList.add('is-flash');
      setTimeout(() => row.classList.remove('is-flash'), 1600);
    }
  };

  return { focusPending };
}

export default { bindReqPage };
