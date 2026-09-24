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

// 行内编辑字段的中文名（提示文案用；未列出的字段只提示「已更新」）
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
      const [key, dir] = String(sortSel.value || 'focus:asc').split(':');
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

  g.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest) return;

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
      const to = arch.dataset.archived === '1';
      deps.sched.archiveModule(name, !to);
      deps.render();
      deps.toast(to ? '已取消归档' : '已归档');
      return;
    }
    const del = t.closest('[data-req-del]');
    if (del) {
      const name = del.dataset.name;
      if (!confirm(`确认删除需求「${name}」及其所有任务？此操作不可撤销。`)) return;
      deps.sched.deleteModule(name);
      deps.render();
      deps.toast('已删除需求');
    }
  });

  return {};
}

export default { bindReqPage };
