// ============================================================
// src/core/mod-auto.js — 需求标签 & 人员配置自动计算
// 供 report-view.js / mod-view.js / modals.js 共享
// ============================================================
import { F } from './dates.js';
import { PNAME, PRIORITIES } from './default-data.js';

/**
 * 里程碑显示名（甘特图 / 汇报视图共用，避免两处命名逻辑漂移）
 *
 * 历史数据里手动创建的里程碑默认 label 是「需求名 + 里程碑」（addTask 的兜底值），
 * 去掉需求名后只剩「里程碑」三个字，图上完全看不出这个卡点是干什么的。
 * 兜底链路：label → 去需求名前缀 → 阶段名（如 需求确认/提测/上线）→ 「里程碑」。
 *
 * 注意：需求名可能含正则元字符（如「县域-得分排名」「（一期）」），
 * 故用字符串前缀比较而非 RegExp，避免正则注入或误匹配。
 */
export function milestoneName(b, modName) {
  if (!b) return '里程碑';
  let name = String(b.label || '').trim();
  if (modName && name.indexOf(modName) === 0) name = name.slice(String(modName).length).trim();
  // 「里程碑」是不含业务信息的通用词，视为未命名 → 回退阶段名
  if (!name || name === '里程碑') name = PNAME[b.p] || '';
  return name || '里程碑';
}

/**
 * 逾期任务判定（统一口径：顶部统计 / 汇报卡片 / 需求标签 / 甘特条 / 抽屉提示共用）
 *
 * 排除以下几类，避免逾期数字虚高：
 *   1) 里程碑：0 天单点，没有"完成度"概念
 *   2) 已完成（done >= 100）
 *   3) 结束日未过（含当天：今天到期不算逾期）
 *   4) 未分配资源的任务：还没排人负责的活儿不构成"逾期"
 *
 * 归档需求的任务由调用方在传入前过滤（归档状态挂在需求上，本函数拿不到）。
 * 注意 today 会先归一化到当天零点：调用方可能传 new Date()（带时分秒），
 * 否则「今天到期」会被误判成逾期。
 */
export function isOverdueTask(t, today) {
  if (!t || t.isMs || t.m) return false;
  if ((t.done || 0) >= 100) return false;
  if (!t.e) return false;
  const day = today instanceof Date
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
    : F(today);
  if (F(t.e) >= day) return false;
  return !!(t.res && t.res.length);
}

/**
 * 根据需求内任务的完成情况、逾期、进行中状态自动计算标签文本与颜色
 * 优先级：已逾期 > 已完成 > 进行中 > 待启动
 */
export function computeModuleTag(bars, today) {
  const tasks = bars.filter(b => !b.m);
  if (!tasks.length) return { tag: '待启动', tagc: '#94a3b8' };

  const allDone = tasks.every(b => (b.done || 0) >= 100);
  if (allDone) return { tag: '已完成', tagc: '#10b981' };

  const hasOverdue = tasks.some(b => isOverdueTask(b, today));
  if (hasOverdue) return { tag: '已逾期', tagc: '#ef4444' };

  const hasActive = tasks.some(b => (b.done || 0) < 100 && b.s && b.e && F(b.s) <= today && F(b.e) >= today);
  if (hasActive) return { tag: '进行中', tagc: '#f59e0b' };

  // 已开工：存在开始日不晚于今日的任务。
  // 覆盖两种会被 hasActive 漏掉、从而误判为「待启动」的情况：
  //   1) 今日落在任务间隙（前置任务已结束、后置任务尚未开始）
  //   2) 已开工的任务全部完成，后续任务还没到开始日
  // 注意：已完成的任务既不满足 hasActive（要求 done<100），又会打破 allFuture，
  //       若没有这一层兜底就会一路掉到「待启动」。
  const started = tasks.some(b => b.s && F(b.s) <= today);
  if (started) return { tag: '进行中', tagc: '#f59e0b' };

  // 所有任务都在未来（未开始）
  const allFuture = tasks.every(b => b.s && F(b.s) > today);
  if (allFuture) return { tag: '待启动', tagc: '#94a3b8' };

  return { tag: '待启动', tagc: '#94a3b8' };
}

/**
 * 计划应达基线（时间口径）：需求时间跨度到今天已经走过的比例
 *
 * 语义 =「按计划时间，现在应该推进到哪里」，与「实际完成度」相减得到偏差：
 *   偏差 > 0 → 超前；< 0 → 延后。回答的就是「进度是否跟得上时间」。
 *
 * 刻意不做工作量（人日）加权：工作量在时间轴上的分布并不均匀（前重后轻、并行、
 * 依赖等待空档都很常见），人日加权会把「前期任务重」的需求应达值顶得很高
 * （时间才过 1/4、应达却已 70%），与"目前是否按计划正常推进"的直觉严重背离。
 *
 * 需求范围取 modRange（含里程碑），与进度条自身的宽度口径一致 ——
 * 因此该值在条上的落点恰好就是「今日线」的位置。
 *
 * @param {{start:Date,end:Date}|null} rng 需求时间范围（modRange 结果）
 * @param {Date} today 今日
 * @returns {number} 0~100 的百分比，保留两位小数
 */
export function computePlanPct(rng, today) {
  if (!rng || !rng.start || !rng.end) return 0;
  const span = rng.end.getTime() - rng.start.getTime();
  if (span <= 0) return 100;                                 // 单点需求：视为已到期
  const passed = today.getTime() - rng.start.getTime();
  return Math.max(0, Math.min(100, Math.round(passed / span * 10000) / 100));
}

/**
 * 从需求内任务的实际人员分配中，按角色统计人数
 * 返回格式：如 "需求×2 + 开发×3 + 测试"
 */
export function computeModulePer(bars, resources) {
  const nameSet = new Set();
  bars.forEach(b => {
    if (b.res && b.res.length) b.res.forEach(n => { if (n) nameSet.add(n); });
  });
  if (!nameSet.size) return '';

  const resMap = {};
  (resources || []).forEach(r => resMap[r.name] = r.role || '执行');

  const roleMap = {};
  nameSet.forEach(n => {
    const role = resMap[n] || '执行';
    roleMap[role] = (roleMap[role] || 0) + 1;
  });

  return Object.entries(roleMap)
    .map(([role, count]) => `${role}${count > 1 ? '×' + count : ''}`)
    .join('+');
}

/**
 * 已归档需求名集合，供渲染层过滤任务（资源泳道 / 顶部统计等按任务维度展示的场景）
 * 说明：归档需求对象仍保留在 state.modules 中（导出/同步/撤销栈因此不丢数据），
 * 仅在展示层过滤；排期计算（依赖/资源占用/问题检测）仍然包含归档需求的任务。
 */
// 优先级徽标 HTML：未设置（老数据没有 pri）时返回空串 —— 不替用户臆造一个 P 值。
// 只输出结构，配色全在 CSS（.pri-p0 ~ .pri-p3），
// 且刻意做成"浅底 + 描边"的轻量徽标，与需求状态标签的实心色块区分开，不抢状态的可读性。
export const priorityBadge = p => (PRIORITIES.includes(p)
  ? `<span class="pri pri-${p.toLowerCase()}" title="优先级 ${p}">${p}</span>`
  : '');

export function archivedModSet(modules) {
  const set = new Set();
  (modules || []).forEach(m => { if (m && m.archived) set.add(m.name); });
  return set;
}

/**
 * 待排期需求名集合（与 archivedModSet 对称）
 * 待排期 = 已登记但还没排期的需求：它的日期/进度都还不可信，
 * 因此不参与总览的排期展示（只显示"待排期"），也不计入「并行 / 逾期」等执行口径统计。
 */
export function unscheduledModSet(modules) {
  const set = new Set();
  (modules || []).forEach(m => { if (m && m.unscheduled) set.add(m.name); });
  return set;
}

/**
 * 需求状态标签：待排期是人工设定的状态，优先级高于自动推算的
 * 「已逾期 / 已完成 / 进行中 / 待启动」—— 还没排期的需求不该被判成逾期。
 */
export function moduleTag(mo, today) {
  if (mo && mo.unscheduled) return { tag: '待排期', tagc: '#94a3b8' };
  return computeModuleTag((mo && mo.bars) || [], today);
}

/**
 * 需求识别色板：任务条左侧色条 / 需求行色点用。
 * 工作组规划器按人分行，同一需求的任务天然散落在不同泳道里，
 * 靠这套颜色才能一眼对上「这几个条是同一个需求的」。
 */
export const MODULE_PALETTE = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899',
  '#06b6d4', '#ef4444', '#6366f1', '#14b8a6', '#f97316'
];

/**
 * 解析「需求名 → 识别色」映射。
 *
 * 取色优先级：
 *   1) 需求自带 tagc —— 即需求弹窗里的「需求颜色」，随 state.modules 一起落库/导出/同步，
 *      人工指定优先，保证用户改过的颜色不被覆盖；
 *   2) tagc 缺失或与前面需求撞色时（历史数据里默认值全是 #3b82f6），按色板补一个未占用的色。
 *      这一层兜底是必须的：否则老数据整张图一个颜色，色条等于白加。
 *
 * 同一份 modules 顺序下结果稳定，渲染层（甘特图 / 工作组规划器 / 总览）不会闪色。
 * 需求数超过色板长度时允许循环复用（此时区分度已无法保证，只能接受撞色）。
 */
export function resolveModuleColors(modules) {
  const used = new Set();
  const out = {};
  const n = MODULE_PALETTE.length;
  let ci = 0;
  (modules || []).forEach(mo => {
    if (!mo || !mo.name) return;
    // 统一小写：数据库/色板来源的十六进制大小写不一，否则「同色」判定会漏（CSS 本身不区分大小写）
    const manual = String(mo.tagc || '').trim().toLowerCase();
    if (manual && !used.has(manual)) {
      out[mo.name] = manual;
      used.add(manual);
      return;
    }
    // 从游标处向后找第一个未被占用的色板色；游标前移保证后续需求继续往后取，避免总撞同一个
    let pick = '';
    for (let k = 0; k < n; k++) {
      const cand = MODULE_PALETTE[(ci + k) % n];
      if (!used.has(cand)) { pick = cand; ci += k + 1; break; }
    }
    if (!pick) { pick = MODULE_PALETTE[ci % n]; ci++; }
    out[mo.name] = pick;
    used.add(pick);
  });
  return out;
}

/**
 * 新建需求时的推荐颜色：色板里第一个尚未被占用的颜色。
 * 若沿用固定默认值（#3b82f6），所有新需求都会同色，任务条色条也就失去区分作用。
 */
export function nextModuleColor(modules) {
  const used = new Set(Object.values(resolveModuleColors(modules)));
  return MODULE_PALETTE.find(c => !used.has(c))
    || MODULE_PALETTE[(modules || []).length % MODULE_PALETTE.length];
}

// 待新建需求在解析时的占位名（真实需求名尚未确定，内部一次性使用，不会落到数据里）
export const PENDING_MOD_KEY = '\u0000pending-mod';

/**
 * 需求弹窗里「选定的颜色」最终会渲染成什么色。
 *
 * resolveModuleColors 会给撞色的需求补一个色板色，所以用户选的色未必是最终生效的色。
 * 编辑器必须按「实际生效色」回显与落库 —— 否则弹窗显示一个色、图上条色/色点又是另一个色。
 * modName 传空表示「待新建需求」（临时追加到末尾参与解析）。
 */
export function resolveChosenColor(hex, modules, modName) {
  const chosen = String(hex || '').trim().toLowerCase();
  const key = modName || PENDING_MOD_KEY;
  const list = (modules || []).map(m => (m && m.name === key) ? { ...m, tagc: chosen } : m);
  if (!modName) list.push({ name: PENDING_MOD_KEY, tagc: chosen });
  return resolveModuleColors(list)[key] || chosen;
}