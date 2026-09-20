// ============================================================
// src/views/header.js — 甘特表头渲染（月行 + 日行 + 周几行）
// 由 gantt-app.js renderHeader 迁移，改为读 ctx（不读 window 全局）
// 动态化：按项目周期 ctx.state.start → ctx.state.end 逐日渲染，
//        支持任意起止日期与跨年（不再硬编码 8~10 月窗口）。
// 纯渲染：返回 HTML 字符串，不绑定事件；container 参数为约定预留（写入由 renderAll 统一完成）
// ============================================================
import { F, addDays } from '../core/dates.js';

// 兼容 Date 对象与 'YYYY-MM-DD' 字符串的日期解析
// 注意：planStore.state.start/end 是 Date 对象（DEFAULT_START/END、服务器 loadPlan 的 parseDate、周期设置均为 Date），
//       而 core/dates.js 的 F() 只接受字符串——直接把 Date 喂给 F() 会得到 Invalid Date，
//       导致下方按月切分的循环终止条件 NaN === NaN 永不成立而无限循环、页面挂起。
function asDate(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  return F(v);
}

export function renderHeader(container, ctx) {
  const dayW = ctx.dayW;
  const zoom = ctx.zoom;
  const workday = ctx.workday;
  const start = asDate(ctx.state.start);
  const end = asDate(ctx.state.end);
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  let months = '', days = '', weeks = '';

  // 按日历月切分 [段内首日, 段内末日] 列表（首末段分别截到项目开始/结束日，支持跨年）
  const segs = [];
  const lastDate = new Date(end.getFullYear(), end.getMonth() + 1, 0); // 结束月最后一天
  for (let y = start.getFullYear(), m = start.getMonth(); ; ) {
    const monthEnd = new Date(y, m + 1, 0);
    const segStart = y === start.getFullYear() && m === start.getMonth() ? start : new Date(y, m, 1);
    const segEnd = monthEnd < end ? monthEnd : end;
    segs.push({ y, m, start: segStart, end: segEnd });
    if (segEnd.getTime() === end.getTime()) break;
    m += 1; y += Math.floor(m / 12); m %= 12;
  }

  segs.forEach(seg => {
    const segDays = Math.round((seg.end - seg.start) / 864e5) + 1;
    const w = segDays * dayW;
    const mtxt = w >= 90 ? `${seg.y}年${seg.m + 1}月` : `${seg.m + 1}月`;
    months += `<div class="mcell" style="width:${w}px">${mtxt}</div>`;

    if (zoom === 'day' || zoom === 'custom') {
      const step = dayW >= 3 ? 1 : 2;
      for (let i = 0; i < segDays; i++) {
        const d = addDays(seg.start, i);
        const dow = d.getDay();
        const info = workday ? workday.dayInfo(d) : null;
        // 着色优先级：法定节假日(红) > 调休补班(周末上班,不灰) > 普通周末(灰) > 工作日
        let wk = '';
        if (info && info.holiday) wk = 'hol';
        else if (info && info.isMakeup) wk = 'mkup';
        else wk = (dow === 0) ? 'sun' : (dow === 6) ? 'sat' : '';
        const sep = dow === 1 ? ' weeksep' : '';
        const show = step === 1 || i === 0 || i === segDays - 1 || i % 2 === 0;
        const tip = info && info.name ? ` title="${info.name}${info.holiday ? '·放假' : (info.isMakeup ? '·补班' : '')}"` : '';
        days += `<div class="dcell ${wk}${sep}" style="width:${dayW}px"${tip}>${show ? d.getDate() : ''}</div>`;
        weeks += `<div class="wcell ${wk}" style="width:${dayW}px">${show ? WEEK[dow] : ''}</div>`;
      }
    } else if (zoom === 'week') {
      for (let i = 0; i < segDays; i++) {
        const d = addDays(seg.start, i);
        const dow = d.getDay();
        if (dow === 1 || i === 0) {
          const endD = addDays(seg.start, Math.min(i + 6, segDays - 1));
          const wpx = (Math.round((endD - d) / 864e5) + 1) * dayW;
          days += `<div class="dcell weeksep" style="width:${wpx}px">${seg.m + 1}/${d.getDate()}</div>`;
          weeks += `<div class="wcell" style="width:${wpx}px">周一~周日</div>`;
        }
      }
    } else {
      days += `<div class="dcell weeksep" style="width:${w}px">${seg.m + 1}月 ${seg.start.getDate()}~${seg.end.getDate()}日</div>`;
      weeks += `<div class="wcell" style="width:${w}px">共${segDays}天</div>`;
    }
  });

  return `<div class="thead">
    <div class="months"><div class="axis-label">需求 / 阶段</div>${months}</div>
    <div class="days"><div class="axis-label">日期</div>${days}</div>
    <div class="weeks"><div class="axis-label">星期</div>${weeks}</div>
  </div>`;
}