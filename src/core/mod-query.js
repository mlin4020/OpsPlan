// ============================================================
// src/core/mod-query.js — 需求台账的筛选与排序（纯函数）
//
// 为什么单独成模块：台账要把「筛什么、怎么排」与「怎么画」分开 ——
// 前者是本文件（无 DOM、可单测），后者是 views/req-view.js。
//
// 依赖全部通过参数注入（deps），因为状态 / 版本 / 时间范围都来自渲染 ctx：
//   deps.today    —— 状态判定基准（moduleTag）
//   deps.versions —— 所属版本筛选与排序
//   deps.modRange —— 排期起止（views/index.js 的 modRange）
//   deps.ctx      —— 传给 modStats 的渲染上下文（workday / today），仅 pct 排序需要
// ============================================================
import { moduleTag, findGateMs } from './mod-tag.js';
import { versionOfMap, findGoMs } from './versions.js';
import { modStats } from './mod-stats.js';
import { PRIORITIES, MODULE_LIFECYCLE } from './default-data.js';
import { F } from './dates.js';
import { isOverdueTask } from './task-status.js';

const norm = s => String(s == null ? '' : s).toLowerCase();

// 默认筛选与排序：排期页入口 / 导出查看器 / 组件层兜底共用一份，避免三处各写一套默认值
export function defaultReqFilter() {
  return { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all', lifecycle: 'all' };
}
// 默认按「关注度」而不是甘特图顺序：这页是给领导与业务看的，
// 一进来先看到"最该被处理的那几条"比"按排期先后"有用得多。
export function defaultReqSort() {
  return { key: 'focus', dir: 'asc' };
}

// ============================================================
// 查询条件的持久化
// ------------------------------------------------------------
// 原先每次打开页面筛选与排序都回到默认值，用户每回都要重设一遍。
// 存 localStorage 而不是 planStore：它是"这个人习惯怎么看"，属于界面偏好，
// 不该进数据文件，更不该同步给别的使用者（各人关注点不同）。
// 按 projectId 隔离：不同项目的关注范围本来就不一样。
// ============================================================
const REQ_VIEW_LS = 'opsplan.reqView.v1';

function lsRead(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsWrite(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* 隐私模式等写入失败，忽略 */ } }

export function loadReqView(projectId) {
  const out = { filter: defaultReqFilter(), sort: defaultReqSort() };
  const raw = lsRead(REQ_VIEW_LS + ':' + (projectId || 'default'));
  if (!raw) return out;
  let saved;
  try { saved = JSON.parse(raw); } catch (e) { return out; }
  // 逐字段合并而不是整体替换：以后新增筛选维度时，
  // 旧快照缺的键会自动取默认值，不会因为老数据缺字段而整个失效
  if (saved && saved.filter) {
    Object.keys(out.filter).forEach(k => { if (saved.filter[k] != null) out.filter[k] = saved.filter[k]; });
  }
  if (saved && saved.sort && saved.sort.key) {
    out.sort.key = saved.sort.key;
    out.sort.dir = saved.sort.dir === 'desc' ? 'desc' : 'asc';
  }
  return out;
}

export function saveReqView(projectId, filter, sort) {
  if (!filter || !sort) return;
  lsWrite(REQ_VIEW_LS + ':' + (projectId || 'default'), JSON.stringify({ filter, sort }));
}

export function filterMods(mods, filter, deps) {
  const f = filter || {};
  const { today } = deps || {};
  const kw = norm(f.kw).trim();
  const status = f.status || 'all';
  const pri = f.pri || 'all';
  const ver = f.ver || 'all';
  const scope = f.scope || 'all';
  const unsched = f.unscheduled || 'all';
  const lifecycle = f.lifecycle || 'all';
  const owner = versionOfMap((deps && deps.versions) || []);

  return (mods || []).filter(mo => {
    if (!mo) return false;
    // 归档 / 待排期是两个正交维度，各自独立判定（设计文档 §4.3）
    if (scope === 'active' && mo.archived) return false;
    if (scope === 'archived' && !mo.archived) return false;
    if (unsched === 'only' && !mo.unscheduled) return false;
    if (unsched === 'exclude' && mo.unscheduled) return false;

    // 关键词命中需求名 / 描述正文 / 提出人（"某人提的需求"要能搜到）
    if (kw && !(norm(mo.name).includes(kw) || norm(mo.desc).includes(kw) || norm(mo.proposedBy).includes(kw))) return false;
    if (status !== 'all' && moduleTag(mo, today).tag !== status) return false;

    if (pri !== 'all') {
      if (pri === 'none') { if (mo.pri) return false; }
      else if (mo.pri !== pri) return false;
    }

    // 生命周期（人工维护的流程门）：none = 未设置（老数据没有该字段）
    if (lifecycle !== 'all') {
      if (lifecycle === 'none') { if (mo.lifecycle) return false; }
      else if (mo.lifecycle !== lifecycle) return false;
    }

    if (ver !== 'all') {
      const v = owner[mo.name];
      if (ver === 'none') { if (v) return false; }
      else if (!v || v.id !== ver) return false;
    }
    return true;
  });
}

// ============================================================
// 「关注度」排序（focus）：把当前最需要你动手的需求排到最上面。
//
// 为什么用分层桶而不是加权分数：分层的每一档都能直接讲给用户听，
// 也能解释"这条为什么排第一"；加权分做不到——它只会吐出一个说不清的数字，
// 回头想调整权重还得先反推各因子的量纲。
//
// 分层（数字越小越靠前）：
//   0 已逾期   —— 有任务超期未完成，要救火
//   1 进度落后 —— 尚未逾期，但完成度已低于应达（EV < PV）
//   2 临近交付 —— 未完成且在 7 个自然日内到期
//   3 待排期   —— 还没排期，需求躺着没人管，本身就是要处理的一件事
//   4 正常推进 —— 进行中且不落后
//   5 待启动   —— 还没开工
//   6 已完成   —— 交付完成，沉底
//   7 已归档   —— 留档查阅，最底
// ============================================================
const FOCUS_DUE_SOON_DAYS = 7;

function focusTier(mo, deps) {
  const { today, ctx, modRange } = deps || {};
  if (mo.archived) return 7;
  const tasks = (mo.bars || []).filter(b => b && !b.m);
  const allDone = tasks.length > 0 && tasks.every(b => (b.done || 0) >= 100);
  if (allDone) return 6;
  if (mo.unscheduled) return 3;
  const day = today instanceof Date ? today : F(today);
  if (tasks.some(b => isOverdueTask(b, day))) return 0;
  // 进度落后：需要 workday 才判得准（modStats 依赖 ctx），缺 ctx 时跳过这一档
  if (ctx) {
    const st = modStats(mo.bars, ctx);
    if (st.work && st.pct < st.planPct - 0.5) return 1;
  }
  const rng = modRange ? modRange(mo) : null;
  if (rng && day && rng.end) {
    const days = Math.round((rng.end.getTime() - day.getTime()) / 864e5);
    if (days <= FOCUS_DUE_SOON_DAYS) return 2;
  }
  const started = tasks.some(b => (b.done || 0) > 0 || (b.s && F(b.s) <= day));
  return started ? 4 : 5;
}

// 排序取值：{ v } 有值 / { miss: true } 无值。
// 无值一律排最后（与升降序无关），避免缺失数据插队刷屏。
function sortValue(mo, key, deps) {
  const { today, versions, modRange, ctx } = deps || {};
  switch (key) {
    case 'name':
      return { v: mo.name || '' };
    case 'status':
      return { v: moduleTag(mo, today).tag };
    case 'pri': {
      const i = PRIORITIES.indexOf(mo.pri);
      return i < 0 ? { miss: true } : { v: i };
    }
    case 'version': {
      const v = versionOfMap(versions || [])[mo.name];
      return v ? { v: v.date || '' } : { miss: true };
    }
    case 'start':
    case 'end': {
      const rng = modRange ? modRange(mo) : null;
      if (!rng) return { miss: true };
      return { v: key === 'start' ? rng.start.getTime() : rng.end.getTime() };
    }
    case 'pct': {
      // 无排期的需求没有可信的进度，排最后（rng 只用于这个判空，不再传给 modStats）
      const rng = modRange ? modRange(mo) : null;
      if (!rng || !ctx) return { miss: true };
      return { v: modStats(mo.bars, ctx).pct };
    }
    // 提出时间：未填写排最后（"还没补录"的需求不该插队）
    case 'proposed':
      return mo.proposedAt ? { v: mo.proposedAt } : { miss: true };
    // 生命周期：按枚举序比较（待分析 → 已上线），未设置排最后
    case 'lifecycle': {
      const i = MODULE_LIFECYCLE.indexOf(mo.lifecycle);
      return i < 0 ? { miss: true } : { v: i };
    }
    // 关键时间：按「需求确认」里程碑日排序（口径与台账展示一致）
    case 'confirm': {
      const cfm = findGateMs(mo, 'confirm');
      return cfm ? { v: cfm.m } : { miss: true };
    }
    case 'ship': {
      // 计划上线日口径与台账展示一致：版本日优先，无版本回退该需求的「上线」里程碑
      const v = versionOfMap(versions || [])[mo.name];
      if (v && v.date) return { v: v.date };
      const go = findGoMs(mo);
      return go && go.m ? { v: go.m } : { miss: true };
    }
    // 关注度：分层 → 优先级 → 计划结束日，三级压进一个数。
    // 量级刻意拉开（1e9 / 1e7），保证"分层永远压过优先级，优先级永远压过日期"——
    // 否则「高优先级但还早」会插到「低优先级但已逾期」前面，正好违背初衷。
    case 'focus': {
      const tier = focusTier(mo, deps);
      const pi = PRIORITIES.indexOf(mo.pri);
      const priRank = pi < 0 ? PRIORITIES.length : pi;   // 未设优先级排在同档最后
      let dayScore = 1000;                                // 无排期居中，不因缺日期而占便宜
      const rng = modRange ? modRange(mo) : null;
      if (rng && rng.end) {
        const day = today instanceof Date ? today : F(today);
        const days = Math.round((rng.end.getTime() - day.getTime()) / 864e5);
        // 已过期得负分、越早越该靠前；夹在 0~2000 内（小于 1e7，不会串到优先级位）
        dayScore = Math.max(0, Math.min(2000, days + 1000));
      }
      return { v: tier * 1e9 + priRank * 1e7 + dayScore };
    }
    default:
      return { v: 0 };
  }
}

export function sortMods(mods, key, dir, deps) {
  const list = [...(mods || [])];
  if (!key || key === 'order') {
    return dir === 'desc' ? list.reverse() : list;
  }
  const sign = dir === 'desc' ? -1 : 1;
  // 装饰-排序-去装饰：Array#sort 自 ES2019 起稳定，同值保持原顺序
  return list
    .map((mo, i) => ({ mo, i, sv: sortValue(mo, key, deps) }))
    .sort((a, b) => {
      if (a.sv.miss && b.sv.miss) return a.i - b.i;
      if (a.sv.miss) return 1;      // 缺失永远在后
      if (b.sv.miss) return -1;
      const va = a.sv.v, vb = b.sv.v;
      const c = (typeof va === 'string' && typeof vb === 'string')
        ? va.localeCompare(vb, 'zh-Hans-CN')
        : (va < vb ? -1 : (va > vb ? 1 : 0));
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map(x => x.mo);
}

// 提出人候选：从全量需求里收集已录入的提出人（去重、忽略空值、保持首次出现顺序）。
// 供需求弹窗的 <datalist> 用：既能选已有值，又能直接输新值（"允许新增选项"）。
// 不做人员字典表：提出人常是业务方，不一定在开发人员名单里（YAGNI）。
export function collectProposers(mods) {
  const out = [];
  const seen = new Set();
  (mods || []).forEach(mo => {
    const v = String((mo && mo.proposedBy) || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  });
  return out;
}
