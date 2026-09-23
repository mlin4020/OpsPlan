// ============================================================
// src/core/mod-tag.js — 需求级标签 / 应达基线 / 需求人员统计 / 软状态集合
//
// 从 core/mod-auto.js 拆出。这些函数都围绕"一个需求整体处于什么状态"回答，
// 与任务级状态（core/task-status.js）刻意分家：两者口径必须一致，但不该混在一个文件里。
//
// 依赖方向：本模块 → task-status（需求状态由任务状态汇总而来），单向。
// ============================================================
import { F, fmt } from './dates.js';
import { PNAME } from './default-data.js';
import { isOverdueTask } from './task-status.js';

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
 * 需求状态标签：待排期是人工设定的状态，优先级高于自动推算的
 * 「已逾期 / 已完成 / 进行中 / 待启动」—— 还没排期的需求不该被判成逾期。
 */
export function moduleTag(mo, today) {
  if (mo && mo.unscheduled) return { tag: '待排期', tagc: '#94a3b8' };
  return computeModuleTag((mo && mo.bars) || [], today);
}

/**
 * 需求当前所处阶段：进行中的最早未完成任务所属阶段；
 * 没有进行中的任务但有未完成任务 → 「待启动」；全部完成 → 「已全部完成」。
 *
 * 从 views/mod-card.js 抽出：总览卡片与需求台账都要显示"现在到哪一步"，
 * 两处各写一份必然给出两个答案。
 */
export function currentPhase(mo, today) {
  const bars = (mo && mo.bars) || [];
  const curTask = bars
    .filter(b => !b.m && (!b.done || b.done < 100) && F(b.s) <= today && F(b.e) >= today)
    .sort((a, b) => F(a.s) - F(b.s))[0];
  if (curTask) return PNAME[curTask.p] || curTask.p;
  return bars.some(b => !b.m && (!b.done || b.done < 100)) ? '待启动' : '已全部完成';
}

/**
 * 计划应达基线（工作量口径，即 EVM 的 Planned Value）：到 today 为止，
 * **按计划应该完成的人日**占总人日的比例。
 *
 * 语义 =「按计划，现在应该推进到哪里」，与「实际完成度 EV」相减得到偏差：
 *   偏差 > 0 → 超前；< 0 → 延后。
 *
 * 每个普通任务按其计划窗口贡献 PV：
 *   · 计划结束日 ≤ today → 全额计入（这段计划本来今天就该做完；做没做是 EV 的事）
 *   · 计划开始日 > today → 不计入（还没到该做的时候）
 *   · 跨 today           → 按已过的计划工作日比例计入
 *
 * 为什么不用「需求时间跨度的流逝比例」（2026-09-23 修正前的旧口径）：
 *   它隐含假设"工作量在时间上均匀分布"，而真实计划常常前重后轻 ——
 *   「县域-得分排名」19 人日里有 18 人日的任务计划在 9/23 前完成，需求跨度却因
 *   末尾的上线里程碑拉到 10/15；旧口径算出"只走过 42%"，于是把一条**有任务已逾期
 *   未完成**的需求判成「超前」。按工作量口径应达 94.7%、实际 78.9% → 延后，
 *   与事实一致。旧注释担心的"人日加权把应达顶得很高"其实不是失真：
 *   计划把 90% 的活排在前半段，前半段结束时本来就该完成 90%。
 *
 * ⚠️ workday 必须与 EV（modStats 的 work/done）同源，否则 PV 与 EV 的分母口径
 * 不一致，两者相减出来的偏差就没有意义。
 *
 * @param {Array} bars 需求内的任务条（含里程碑，内部过滤）
 * @param {Date} today 今日
 * @param {{workDays:(s:string,e:string)=>number}} workday 工作日口径
 * @returns {number} 0~100 的百分比，保留两位小数
 */
export function computePlanPct(bars, today, workday) {
  const tasks = (bars || []).filter(b => !b.m && b.s && b.e);
  if (!tasks.length || !workday || typeof workday.workDays !== 'function') return 0;
  const day = today instanceof Date
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
    : F(today);
  // workDays 内部走 F()，只吃 "YYYY-MM-DD" 字符串 —— 这里必须传字符串，不能传 Date
  const dayStr = fmt(day);
  let total = 0, planned = 0;
  tasks.forEach(b => {
    const w = workday.workDays(b.s, b.e);
    if (!w) return;
    total += w;
    if (F(b.e) <= day) { planned += w; return; }                  // 计划已完成
    if (F(b.s) > day) return;                                      // 计划未开始
    planned += w * Math.min(1, workday.workDays(b.s, dayStr) / w); // 跨今天
  });
  return total ? Math.max(0, Math.min(100, Math.round(planned / total * 10000) / 100)) : 0;
}

/**
 * 进度偏差：用「完成度（EV）」减「应达（PV）」，并给出给读者看的措辞。
 *
 * 三处视图（总览卡片 / 排期总览 / 需求台账）原本各写一份同样的判定，措辞还略有出入，
 * 抽到这里统一——尤其下面这条规则必须三处一致，否则会出现自相矛盾的组合。
 *
 * ⚠️ 已 100% 完成的需求**不再给偏差**。此时「超前 5%」的真实含义只是
 * 「计划把最后 1 人日排在明天到期」，而需求交付早已是终态：对读者只有干扰，
 * 「已完成」这个标签本身就说清了。判定口径与 computeModuleTag 的 allDone 对齐。
 *
 * @param {Array} bars 需求内的任务条（内部过滤里程碑）
 * @param {{pct:number,done:number,work:number,planPct:number}} stats modStats 的返回值
 * @returns {{key:'late'|'ahead'|'on'|'', label:string, value:number, finished:boolean}}
 *   key 供样式类名使用（'' 表示不标注）；label 是可直接展示的文案（无常量前缀）
 */
export function progressDeviation(bars, stats) {
  const { pct = 0, work = 0, planPct = 0 } = stats || {};
  const tasks = (bars || []).filter(b => !b.m);
  const finished = tasks.length > 0 && tasks.every(b => (b.done || 0) >= 100);
  if (finished || !work) return { key: '', label: '', value: 0, finished };
  const value = Math.round((pct - planPct) * 10) / 10;
  if (value < -0.5) return { key: 'late', label: `延后 ${Math.abs(value).toFixed(0)}%`, value, finished: false };
  if (value > 0.5) return { key: 'ahead', label: `超前 ${value.toFixed(0)}%`, value, finished: false };
  return { key: 'on', label: '', value, finished: false };
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
