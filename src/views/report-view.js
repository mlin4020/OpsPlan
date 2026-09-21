// ============================================================
// src/views/report-view.js — 汇报视图渲染（领导汇报：核心指标 → 排期总览 → 需求进度 → 里程碑 → 风险）
// 由 gantt-app.js renderReportView 迁移，改为读 ctx（不读 window 全局）
// 纯渲染：返回 HTML 字符串，不绑定事件（下钻展开由组件层事件委托触发 reportExpanded 变更后重渲染）
// ============================================================
import { F, fmtD } from '../core/dates.js';
import { PCOL, PNAME } from '../core/default-data.js';
import { computeModulePer, milestoneName, archivedModSet, unscheduledModSet, moduleTag } from '../core/mod-tag.js';
import { isOverdueTask } from '../core/task-status.js';
import { sortVersions, versionLateMods } from '../core/versions.js';
import { priorityBadge } from './badge.js';
// 需求进度卡片与 modStats/msName 已抽到 mod-card.js，与「归档需求」页共用同一份实现
import { renderModCard, modStats, msName } from './mod-card.js';

let reportExpanded = new Set();   // 已展开明细的需求名集合

const RISK_TYPE_NAME = { overlap: '资源重叠', depend: '依赖违反', overdue: '超期', cycle: '依赖环' };

// 里程碑名里若自带前导日期（默认数据形如 "9/9 上线"），剥掉它，
// 避免与外部已单独显示的日期拼成 "9/9 9/9 上线"


export function renderReportView(container, ctx) {
  const { state, sched, workday, today, holidays, modRange } = ctx;
  const all = sched.tasks() || [];
  // 已归档需求：数据保留，仅从「排期总览 / 需求进度」列表中过滤（不再展示）
  // 注意：核心指标（整体进度/总人日）仍统计全部任务，避免归档已完成需求后整体进度不降反退
  const mods = (state.modules || []).filter(m => !m.archived);
  const archived = (state.modules || []).filter(m => !!m.archived);
  // 统计口径：
  //   待排期需求 —— 还没排期、日期不可信：既不进核心指标（工作量/进度），也不进并行/逾期
  //   归档需求   —— 已收口：不进并行/逾期，但核心指标保留（否则归档已完成需求会让整体进度倒扣）
  const archSet = archivedModSet(state.modules);
  const unschedSet = unscheduledModSet(state.modules);
  const metricTasks = all.filter(t => !unschedSet.has(t.mod));
  const statTasks = all.filter(t => !archSet.has(t.mod) && !unschedSet.has(t.mod));
  const start = state.start, end = state.end;
  const spanMs = end.getTime() - start.getTime() || 864e5;
  const pct = d => Math.max(0, Math.min(100, ((d.getTime() - start.getTime()) / spanMs) * 100));

  // ---- 1. 核心指标 ----
  // 核心指标：只统计「阶段任务」，里程碑（isMs / 带 m 字段）不占工作量，不参与进度加权
  // 注意：部分里程碑是「任务转里程碑」产生的，同时带 s/e 与 m，仅凭 s&&e 判断会把它误算成工作量，
  // 导致总人日虚高、进度永远差一点到 100%。故统一用 !isMs 过滤，与下方任务数/应达基线口径一致。
  const isTask = t => !t.isMs && !t.m && t.s && t.e;
  const totalWork = metricTasks.reduce((a, t) => a + (isTask(t) ? workday.workDays(t.s, t.e) : 0), 0);
  const doneWork = metricTasks.reduce((a, t) => a + (isTask(t) ? workday.workDays(t.s, t.e) * ((t.done || 0) / 100) : 0), 0);
  const progress = totalWork ? Math.round((doneWork / totalWork * 100) * 100) / 100 : 0;
  const activeN = statTasks.filter(t => !t.isMs && (!t.done || t.done < 100) && F(t.s) <= today && F(t.e) >= today).length;
  // 逾期：统一口径（排除里程碑/已完成/未到期/未分配资源；statTasks 已排除归档需求）
  const overdueN = statTasks.filter(t => isOverdueTask(t, today)).length;
  const mss = statTasks.filter(t => t.isMs && t.m).sort((a, b) => F(a.m) - F(b.m));
  const nextMs = mss.find(t => F(t.m) >= today);
  const nextMsDays = nextMs ? Math.max(0, Math.round((F(nextMs.m) - today) / 864e5)) : null;

  // 核心指标：紧凑横条 —— 只保留关键数字，次要信息收进 title，
  // 避免一进总览就被 5 张大卡片占掉首屏、把真正要看的排期挤到下面。
  const taskCount = metricTasks.filter(t => !t.isMs && t.s && t.e).length;
  const msTip = nextMs
    ? `${nextMs.mod} ${milestoneName(nextMs, nextMs.mod)} · ${fmtD(F(nextMs.m))}`
    : '暂无里程碑';
  const metrics = `
  <div class="report-metrics">
    <div class="rms-item" title="已完成 ${doneWork.toFixed(1)} / 共 ${totalWork} 人日">
      <b class="blue">${progress.toFixed(1)}<i>%</i></b><span>整体进度</span>
    </div>
    <div class="rms-item" title="${taskCount} 项阶段任务">
      <b>${totalWork}</b><span>总人日</span>
    </div>
    <div class="rms-item" title="今日进行中的阶段任务">
      <b class="amber">${activeN}</b><span>今日并行</span>
    </div>
    <div class="rms-item${overdueN ? ' is-alert' : ''}" title="已排人且结束日已过未完成（不含归档需求）">
      <b class="red">${overdueN || 0}</b><span>逾期任务</span>
    </div>
    <div class="rms-item" title="${msTip}">
      <b class="green">${nextMsDays == null ? '—' : nextMsDays}</b><span>距里程碑（天）</span>
    </div>
  </div>`;

  // ---- 2. 排期总览 ----
  const spanDays = Math.max(1, Math.round(spanMs / 864e5));
  const ticks = [];
  for (let i = 0; i <= 5; i++) ticks.push(sched.addDays(start, Math.round(spanDays * i / 5)));
  const holSeg = (holidays || []).map(h => {
    const l = pct(h.s), w = Math.max(0.5, pct(h.e) - l);
    return `<div class="rtl2-hol" style="left:${l.toFixed(1)}%;width:${w.toFixed(1)}%" title="${h.n} ${fmtD(h.s)}~${fmtD(h.e)}"></div>`;
  }).join('');
  // 需求工作量口径（排期总览 + 需求进度卡片共用，避免两处算法漂移）：
  //   work/done 只统计阶段任务，里程碑（b.m）不占工作量 —— 里程碑是时间点不是工作量，
  //   且「任务转里程碑」的记录会同时带 s/e 与 m，仅凭 s&&e 判断会把它误算进分母。
  //   planPct 用时间口径（需求时间跨度已过比例，见 computePlanPct）：不做人日加权 ——
  //   工作量在时间轴上分布不均匀，加权会把应达值顶高，与"是否按计划正常推进"的直觉背离。
  const rowsHtml = mods.map(mo => {
    // 待排期需求：不画排期条与里程碑，只占一行显示「待排期」
    // （还没排期时日期与进度都不可信，画出来只会误导）
    if (mo.unscheduled) {
      return `<div class="rtl2-row">
        <span class="rtl2-name">${mo.name}</span>
        <span class="rtl2-pct">—</span>
        <div class="rtl2-track"><span class="rtl2-unsched">待排期</span></div>
      </div>`;
    }
    const rng = modRange(mo);
    // 需求进度计算（复用需求进度卡片的逻辑）
    const bars = mo.bars || [];
    const { work: mWork, done: mDone, pct: mp, planPct } = modStats(bars, rng, ctx);
    const devi = Math.round((mp - planPct) * 10) / 10;                 // 偏差：实际完成 - 今日应达
    const st = (!rng || !mWork) ? '' : (devi < -0.5 ? 'late' : (devi > 0.5 ? 'ahead' : 'on'));
    const stTxt = st === 'late' ? ` · 延后 ${Math.abs(devi).toFixed(0)}%` : (st === 'ahead' ? ` · 超前 ${devi.toFixed(0)}%` : '');
    // 进度填充色：正常/超前=标准绿(green-600)，延期=标准红(red-600)；条底色由CSS统一控制
    // 对比度：空条与轨道背景差异明显，填充色与空条对比度>4.5:1，完全解决与背景融合问题
    const fillColor = st === 'late' ? '#dc2626' : '#16a34a';
    const barHtml = rng ? `<div class="rtl2-bar ${st}" style="left:${pct(rng.start).toFixed(1)}%;width:${Math.max(0.5, pct(rng.end) - pct(rng.start)).toFixed(1)}%" title="${mo.name} · 完成 ${mp.toFixed(0)}% / 时间进度 ${planPct.toFixed(0)}%${stTxt}">
      <div class="rtl2-bar-progress" style="width:${Math.min(100, mp).toFixed(1)}%;background:${fillColor}"></div>
    </div>`
      : `<span class="rtl2-empty">暂无任务</span>`;
    const msItems = (mo.bars || []).filter(b => b.m).map(ms => {
      const p = pct(F(ms.m));
      const tice = /提测/.test(ms.label || '');
      const on = F(ms.m) <= today;
      const cls = tice ? 'tice' : (on ? 'on' : 'go');
      const nm = msName(ms, mo.name);
      const label = `${fmtD(F(ms.m))} ${nm}`;
      return { p, cls, label, nm, on, tice };
    }).sort((a, b) => a.p - b.p);
    const layers = [];
    const estW = t => Math.max(0.6, t.label.length * 0.85 + 1);
    msItems.forEach(t => {
      const s = t.p - estW(t) / 2, e = t.p + estW(t) / 2;
      const li = layers.findIndex(L => !L.some(o => s < o.e && e > o.s));
      const l = li < 0 ? (layers.push([]), layers.length - 1) : li;
      t.li = l;
      layers[l].push({ s, e });
    });
    const msHtml = msItems.map(t => {
      return `<div class="rtl2-m ${t.cls}" style="left:${t.p.toFixed(1)}%;--li:${t.li}" title="${mo.name} ${t.nm}"><i></i><b></b><em>${t.label}</em></div>`;
    }).join('');
    const maxLy = msItems.length ? Math.max(...msItems.map(t => t.li)) : 0;
    const trH = 66 + maxLy * 34;
    return `<div class="rtl2-row">
      <span class="rtl2-name">${mo.name}</span>
      <span class="rtl2-pct ${st}" title="完成 ${mp.toFixed(0)}%${stTxt}">${mp.toFixed(0)}%</span>
      <div class="rtl2-track" style="height:${trH}px">${holSeg}${barHtml}<div class="rtl2-today" style="left:${pct(today).toFixed(1)}%"></div>${msHtml}</div>
    </div>`;
  }).join('');
  // 移动端「排期总览」：横向百分比时间轴在手机上必然把条压成一条缝、里程碑标签互相压字，
  // 故同一份数据改用纵向卡片流呈现 —— 进度条占满整行宽度。
  // 两套结构同时输出，由 CSS 按断点二选一，避免依赖 JS 测宽（旋屏/分屏时无需重绘）。
  //
  // 进度条语义：条 = 需求自身排期区间（首末任务日期），填充 = 完成比例；
  // 里程碑按日期落位成菱形骑在条上，虚线下延到「日期 + 名称」标签，标签重叠时自动分层。
  // 相比桌面版按"项目全局时间轴"落位，需求内坐标让卡点分布更分散，窄屏下不容易挤成一团。
  const MTL_TRACK_W = 340;   // 卡片轨道像素宽经验值，仅用于标签宽度→百分比换算（分层去重叠用）
  const estPct = s => {
    let px = 12;                                    // padding
    for (const ch of String(s)) px += /[\x00-\xff]/.test(ch) ? 5.6 : 9.6;
    return Math.min(64, px / MTL_TRACK_W * 100);
  };
  const mobRows = mods.map(mo => {
    const mc = (ctx.modColors && ctx.modColors[mo.name]) || mo.tagc || '#94a3b8';
    if (mo.unscheduled) {
      return `<div class="mtl-card is-unsched">
        <div class="mtl-top"><span class="mtl-dot" style="background:${mc}"></span><span class="mtl-name">${mo.name}</span><span class="mtl-state">待排期</span></div>
        <div class="mtl-note">已登记需求，日期与进度待排期后确定</div>
      </div>`;
    }
    const bars = mo.bars || [];
    const rng = modRange(mo);
    const { work: mWork, pct: mp, planPct } = modStats(bars, rng, ctx);
    const devi = Math.round((mp - planPct) * 10) / 10;
    const st = (!rng || !mWork) ? '' : (devi < -0.5 ? 'late' : (devi > 0.5 ? 'ahead' : 'on'));
    const stTxt = !rng || !mWork ? '未开始'
      : (st === 'late' ? `延后 ${Math.abs(devi).toFixed(0)}%`
        : (st === 'ahead' ? `超前 ${devi.toFixed(0)}%` : '正常'));

    // 需求内坐标：0% = 需求首个任务开始日，100% = 末个任务结束日
    const span = rng ? (rng.end.getTime() - rng.start.getTime() || 864e5) : 1;
    const at = d => rng ? Math.max(0, Math.min(100, ((d.getTime() - rng.start.getTime()) / span) * 100)) : 0;
    const inRange = !!rng && today >= rng.start && today <= rng.end;

    // 里程碑：菱形在条上，标签按层下移（贪心找第一个不与已有标签重叠的层）
    const msItems = bars.filter(b => b.m).sort((a, b) => F(a.m) - F(b.m)).map(b => {
      const tice = /提测/.test(b.label || '');
      const on = F(b.m) <= today;
      return {
        pos: at(F(b.m)),
        cls: tice ? 'tice' : (on ? 'on' : 'go'),
        label: `${fmtD(F(b.m))} ${msName(b, mo.name)}`
      };
    });
    const layers = [];
    msItems.forEach(t => {
      const w = estPct(t.label);
      const s = t.pos - w / 2, e = t.pos + w / 2;
      let li = layers.findIndex(L => !L.some(o => s < o.e && e > o.s));
      if (li < 0) { layers.push([]); li = layers.length - 1; }
      t.li = li;
      layers[li].push({ s: Math.max(0, s), e: Math.min(100, e) });
    });
    const msHtml = msItems.map(t => {
      // 卡点贴两端时标签不能再用居中定位（会溢出卡片），改为向内对齐
      const edge = t.pos >= 88 ? ' is-edge-r' : (t.pos <= 12 ? ' is-edge-l' : '');
      return `<div class="mtl-ml ${t.cls}${edge}" style="left:${t.pos.toFixed(1)}%;--li:${t.li}" title="${mo.name} ${t.label}"><i></i><b></b><em>${t.label}</em></div>`;
    }).join('');
    // 容器高度随标签层数增长（与 CSS 的 li*22px 层距保持一致）：无里程碑时压到只够放条
    const maxLi = msItems.length ? Math.max(...msItems.map(t => t.li)) : 0;
    const tlH = msItems.length ? (maxLi * 22 + 50) : 28;

    const rangeTxt = rng ? `${fmtD(rng.start)}~${fmtD(rng.end)}` : '暂无任务';
    const open = reportExpanded.has(mo.name);
    const mobDetail = open ? bars.filter(b => !b.m).sort((a, b) => F(a.s) - F(b.s)).map(b => {
      const pc = PCOL[b.p] || '#94a3b8';
      const phaseName = PNAME[b.p] || '任务';
      const taskName = (b.name || '').trim() || phaseName;
      return `<div class="mtl-task">
        <span class="mtl-task-dot" style="background:${pc}"></span>
        <span class="mtl-task-name">${taskName}</span>
        <span class="mtl-task-date">${fmtD(F(b.s))}~${fmtD(F(b.e))}</span>
        <span class="mtl-task-pct">${b.done || 0}%</span>
      </div>`;
    }).join('') : '';
    return `<div class="mtl-card ${st}" data-report-mod="${mo.name}">
      <div class="mtl-top">
        <span class="mtl-dot" style="background:${mc}"></span>
        <span class="mtl-name">${mo.name}</span>
        ${priorityBadge(mo.pri)}
        <span class="mtl-state ${st}">${stTxt}</span>
        <span class="mtl-arr">${open ? '▲' : '▼'}</span>
      </div>
      <div class="mtl-tl" style="height:${tlH}px">
        <div class="mtl-bar" title="完成 ${mp.toFixed(0)}% / 时间进度 ${planPct.toFixed(0)}%">
          <span class="mtl-fill ${st}" style="width:${Math.min(100, mp).toFixed(1)}%"></span>
        </div>
        ${inRange ? `<span class="mtl-today" style="left:${at(today).toFixed(1)}%"></span>` : ''}
        ${msHtml}
      </div>
      <div class="mtl-meta"><b>${mp.toFixed(0)}%</b><span>完成</span><span class="mtl-sep"></span><span>应达 ${planPct.toFixed(0)}%</span><span class="mtl-sep"></span><span>${rangeTxt}</span></div>
      ${mobDetail ? `<div class="mtl-detail">${mobDetail}</div>` : ''}
    </div>`;
  }).join('');

  const timeline = `
  <div class="report-sec">
    <div class="report-head">排期总览<span>${fmtD(start)} ~ ${fmtD(end)} · 各需求排期与关键时间卡点</span></div>
    <div class="mtl">
      <div class="mtl-legend">
        <span class="k prog"><i></i>完成进度</span>
        <span class="k today"><b></b>今日（应达）</span>
        <span class="k tice"><i></i>提测</span>
        <span class="k go"><i></i>待上线</span>
        <span class="k on"><i></i>已上线</span>
      </div>
      ${mobRows}
      <div class="rtl2-hols">假期：${(holidays || []).map(h => `${h.n} ${fmtD(h.s)}~${fmtD(h.e)}`).join(' · ') || '无'}</div>
    </div>
    <div class="rtl2">
      <div class="rtl2-scale">${ticks.map(d => `<span style="left:${pct(d).toFixed(1)}%">${fmtD(d)}</span>`).join('')}</div>
      <div class="rtl2-body">${rowsHtml}</div>
      <div class="rtl2-legend">
        <span class="k today"><b></b>今日</span>
        <span class="k prog"><i></i>正常/超前</span>
        <span class="k late"><i></i>延期</span>
        <span class="k tice"><i></i>提测卡点</span>
        <span class="k go"><i></i>上线</span>
        <span class="k hol"><i></i>假期</span>
      </div>
      <div class="rtl2-hols">假期：${(holidays || []).map(h => `${h.n} ${fmtD(h.s)}~${fmtD(h.e)}`).join(' · ') || '无'}</div>
    </div>
  </div>`;

  // ---- 3. 需求进度 ----
  // 卡片渲染与「归档需求」页共用 mod-card.js 的 renderModCard（同一份 DOM，避免两处漂移）；
  // 展开态仍由本模块的 reportExpanded 持有，归档页传自己的谓词，两边互不干扰。
  const modRows = mods.map(mo => renderModCard(mo, ctx, { isExpanded: n => reportExpanded.has(n) })).join('');

  // 已归档需求不再挂在本页底部（原先要滚到最底才能看到），
  // 改为独立页面：顶部「归档」入口 → archive-view.js

  // ---- 4. 里程碑一览 ----
  const mileList = mss.length ? mss.map(t => {
    return `<div class="rml-item">
      <span class="rml-date">${fmtD(F(t.m))}</span>
      <span class="rml-mod">${t.mod}</span>
      <span class="rml-name">${msName(t, t.mod)}</span>
    </div>`;
  }).join('') : '<div class="report-empty">暂无里程碑</div>';

  // ---- 5. 风险与关注点 ----
  // 版本（迭代）预警排在排期问题之前：前者是「业务后果」（这版上不了），
  // 后者是「技术原因」（资源撞车/依赖违反）—— 给人看风险先看结论。
  const verLateHtml = sortVersions(state.versions || [])
    .filter(v => v && !v.shipped)
    .map(v => ({ v, list: versionLateMods(v, state) }))
    .filter(x => x.list.length)
    .map(x => x.list.slice(0, 3).map(({ mo, late }) =>
      `<div class="rr-item"><span class="rr-type ver">版本</span><span class="rr-desc">${mo.name} 赶不上「${x.v.name}」（${fmtD(F(x.v.date))} 上线），按当前排期要到 ${fmtD(late.end)}，晚 ${late.days} 天</span></div>`
    ).join(''))
    .join('');
  const problems = sched.problems().slice(0, 8);
  const problemHtml = problems.map(p =>
    `<div class="rr-item"><span class="rr-type ${p.type}">${RISK_TYPE_NAME[p.type] || p.type}</span><span class="rr-desc">${p.desc}</span></div>`
  ).join('');
  const riskHtml = (verLateHtml + problemHtml) || '<div class="rr-empty">✓ 当前无排期问题</div>';
  const holTip = (holidays || []).map(h => `${h.n} ${fmtD(h.s)}~${fmtD(h.e)}（${Math.round((h.e - h.s) / 864e5) + 1} 天）`).join('、');
  const resLoad = (state.resources || []).map(r => ({
    name: r.name,
    n: all.filter(t => !t.isMs && t.res && t.res.includes(r.name)).length
  })).filter(x => x.n > 0).sort((a, b) => b.n - a.n);
  const loadHtml = resLoad.length ? resLoad.slice(0, 3).map(r =>
    `<div class="rl-item"><span class="rl-name">${r.name}</span><span class="rl-bar"><i style="width:${Math.round(r.n / resLoad[0].n * 100)}%"></i></span><span class="rl-n">${r.n} 项</span></div>`
  ).join('') : '<div class="rr-empty">暂无资源任务分配</div>';

  return `
  <div class="report-wrap">
    ${metrics}
    ${timeline}
    <div class="report-sec">
      <div class="report-head">需求进度<span>${mods.length} 个需求 · 点击卡片查看任务明细 · 红"今"线=今天，进度越过它即为超前</span></div>
      <div class="rmod-grid">${modRows}</div>
    </div>
  
    <div class="report-cols">
      <div class="report-sec">
        <div class="report-head">里程碑一览<span>${mss.length} 个里程碑 · 按上线日期排序</span></div>
        <div class="rml">${mileList}</div>
      </div>
      <div class="report-sec">
        <div class="report-head">风险与关注点<span>版本上线风险 · 排期问题 · 假期空窗 · 资源负载</span></div>
        <div class="rr-list">${riskHtml}</div>
        <div class="rr-tip">${holTip ? `假期空窗：${holTip}` : '无假期'}</div>
        <div class="rr-sub">资源负载 TOP3</div>
        <div class="rl-list">${loadHtml}</div>
      </div>
    </div>
  </div>`;
}

// 供组件层（Task 4b）在事件委托中切换汇报下钻展开状态
export function toggleReportExpanded(name) {
  if (reportExpanded.has(name)) reportExpanded.delete(name);
  else reportExpanded.add(name);
  return reportExpanded.has(name);
}
export function isReportExpanded(name) { return reportExpanded.has(name); }
