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

  const apply = (opts) => {
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

  // 下拉筛选：换范围 → 回到顶部
  g.addEventListener('change', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-req-f]') : null;
    if (!el) return;
    curF()[el.dataset.reqF] = el.value || 'all';
    apply({ top: true });
  });

  g.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest) return;

    // ---- 只读模式下也要能用的：展开 / 收起、排序、重置 ----
    // ⚠ 行内操作按钮（编辑 / 归档 / 删除）就在 <tr data-req-row> 内部，
    //    所以展开判定必须先排除它们：否则 closest('[data-req-row]') 先命中，
    //    "点编辑"会被当成"展开 / 收起"，四个行操作全部失效（回归见 tests/req-page.test.js）。
    const hitAct = !!(t.closest('[data-req-edit]') || t.closest('[data-req-archive]') || t.closest('[data-req-del]'));
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
