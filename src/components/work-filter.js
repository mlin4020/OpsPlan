// ============================================================
// src/components/work-filter.js — 资源工作视图筛选条的事件绑定
//
// 为什么单独成模块：筛选条要在两个入口都能用 ——
//   1) 排期页：components/index.js 的 bindAll 里调用；
//   2) 导出的单文件查看器：main-standalone.js **没有组件层**，得自己调。
//   把绑定逻辑抽出来共用，避免"导出的页面里筛选条点了没反应"（导出件恰恰发给人看，最需要筛选）。
//
// 一切都委托在 #gantt 容器上：renderAll 只替换它的 innerHTML，元素本身不换，
// 所以只需绑一次；筛选条在每次重绘后被重建，委托链依旧有效。
//
// 唯一的坑是搜索框：重绘会连带把输入框一起换掉 → 焦点丢失，只能输进去一个字。
// 故记住光标位置，重绘后还原（输入类交互必须做这一步，否则筛选等于不可用）。
// ============================================================
import { defaultWorkFilter } from '../core/work-filter.js';

export function bindWorkFilter(deps) {
  const g = deps.gantt;
  const vs = deps.viewState;
  if (!g || !vs || typeof g.addEventListener !== 'function') return null;
  // viewState 由各入口各自构造，这里兜底一份默认筛选 —— 免得两个入口都要记得加这个字段
  if (!vs.workFilter) vs.workFilter = defaultWorkFilter();
  // 一律通过 cur() 取当前对象：重置/换入口时若整体替换了 workFilter，闭包里的旧引用会失效
  const cur = () => vs.workFilter;

  // 搜索框重绘后要还原的光标位置（null = 本次不需要还原）
  let caret = null;

  const apply = (opts) => {
    if (typeof deps.render === 'function') deps.render();
    // 换人 / 重置是"换了个观察范围"：列表会整块重排，留在原滚动位置多半落进空白，
    // 故回到顶部；打字则保持原位（每次敲键都跳顶部会让人没法边打边看）
    if (opts && opts.top && deps.gsc) deps.gsc.scrollTop = 0;
    if (caret != null) {
      const el = g.querySelector && g.querySelector('[data-wk-q]');
      if (el) {
        el.focus();
        if (el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch (e) { /* 类型不支持时忽略 */ } }
      }
      caret = null;
    }
  };

  const toggle = (arr, v) => {
    const i = arr.indexOf(v);
    if (i === -1) arr.push(v); else arr.splice(i, 1);
  };

  // 搜索框：输入即筛（实时）
  g.addEventListener('input', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-wk-q]') : null;
    if (!el) return;
    caret = el.selectionStart == null ? 0 : el.selectionStart;
    cur().q = el.value;
    apply();
  });

  // 人员下拉：换人 = 换观察范围，回到顶部
  g.addEventListener('change', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-wk-person]') : null;
    if (!el) return;
    cur().person = el.value || '';
    apply({ top: true });
  });

  g.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest) return;
    const state = t.closest('[data-wk-state]');
    if (state) { toggle(cur().states, state.dataset.wkState); apply(); return; }
    const pri = t.closest('[data-wk-pri]');
    if (pri) { toggle(cur().pris, pri.dataset.wkPri); apply(); return; }
    if (t.closest('[data-wk-reset]')) {
      Object.assign(vs.workFilter, defaultWorkFilter());
      apply({ top: true });
      return;
    }
    // 点人名 / 点「未分配」标题 = 快速筛选到这个人（再点一次取消，回到全部人员）
    const pick = t.closest('[data-wk-pick]');
    if (pick) {
      const v = pick.dataset.wkPick;
      vs.workFilter.person = (cur().person === v) ? '' : v;
      apply({ top: true });
    }
  });

  return { filter: () => vs.workFilter };
}
