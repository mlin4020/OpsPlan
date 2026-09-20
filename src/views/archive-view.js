// ============================================================
// src/views/archive-view.js — 归档需求页面（档案柜）
//
// 定位（与用户确认过）：**只读留档，重点是「看得清、找得到」**，不是回收站
//   → 不做批量恢复、不做永久删除。
//
// 形态：复用总览「需求进度」的卡片网格（mod-card.js 的 renderModCard）。
//   理由：归档需求本来就用这套卡片渲染（原先是总览页底的归档折叠区），
//   复用同一份 DOM 等于两处「需求列表」长得一样；而且卡片自带下钻，
//   点击委托（toolbar.js 里的 `.rmod-card` + data-report-mod）无需任何新增代码即可展开明细。
//
// 与总览的关系：
//   · 展开态**共用** report-view 的 reportExpanded —— 两个页面的需求集合不相交
//     （总览过滤掉归档需求），共用无副作用，且省掉一套状态与一次委托分发。
//   · 本页**不再**在总览底部出现；甘特图底部的归档区另有一套（画在时间轴上，见 mod-view.js）。
//
// 纯渲染：返回 HTML 字符串，不绑定事件。
// 「取消归档」复用 drawers.js 里 [data-unarchive] 的既有委托（按钮自身 stopPropagation，
// 因此不会连带触发卡片的展开/收起）。
// ============================================================
import { renderModCard, archivedAtText } from './mod-card.js';
import { isReportExpanded } from './report-view.js';

// 归档时间倒序：最近收口的排最前（查档时最常看的就是"刚归档的"）。
// 缺失/非法 archivedAt 的排到最后，不让脏数据插队。
const tsOf = mo => {
  const t = mo && mo.archivedAt ? new Date(mo.archivedAt).getTime() : 0;
  return isNaN(t) ? 0 : t;
};

export function renderArchiveView(container, ctx) {
  const { state } = ctx;
  const archived = (state.modules || []).filter(m => !!m.archived).sort((a, b) => tsOf(b) - tsOf(a));

  const head = `<div class="report-sec">
    <div class="report-head">归档需求<span>共 ${archived.length} 个 · 归档后不参与排期展示与「并行 / 逾期」统计，可随时取消归档恢复</span></div>`;

  if (!archived.length) {
    return `<div class="report-wrap">${head}
      <div class="arch-empty">
        <b>暂无归档需求</b>
        <span>在需求行右键菜单里选「归档需求」，可把已收口的需求移到这里</span>
      </div>
    </div></div>`;
  }

  // 「取消归档」：右上角小图标，不占卡片文字位（档案柜语义下恢复是低频操作）。
  // 带 data-unarchive 即被 drawers.js 的既有委托接管，无需新交互代码。
  const cards = archived.map(mo => renderModCard(mo, ctx, {
    isExpanded: isReportExpanded,
    archivedAt: archivedAtText(mo.archivedAt),
    actions: `<button type="button" class="rmod-unarch" data-unarchive="${mo.name}" title="取消归档（恢复到排期视图）" aria-label="取消归档 ${mo.name}">↩</button>`
  })).join('');

  return `<div class="report-wrap">
    ${head}
      <div class="rmod-grid">${cards}</div>
    </div>
  </div>`;
}
