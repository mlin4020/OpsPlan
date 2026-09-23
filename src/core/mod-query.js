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
import { moduleTag } from './mod-tag.js';
import { versionOfMap, findGoMs } from './versions.js';
import { modStats } from './mod-stats.js';
import { PRIORITIES } from './default-data.js';

const norm = s => String(s == null ? '' : s).toLowerCase();

// 默认筛选与排序：排期页入口 / 导出查看器 / 组件层兜底共用一份，避免三处各写一套默认值
export function defaultReqFilter() {
  return { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all' };
}
export function defaultReqSort() {
  return { key: 'order', dir: 'asc' };
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
  const owner = versionOfMap((deps && deps.versions) || []);

  return (mods || []).filter(mo => {
    if (!mo) return false;
    // 归档 / 待排期是两个正交维度，各自独立判定（设计文档 §4.3）
    if (scope === 'active' && mo.archived) return false;
    if (scope === 'archived' && !mo.archived) return false;
    if (unsched === 'only' && !mo.unscheduled) return false;
    if (unsched === 'exclude' && mo.unscheduled) return false;

    if (kw && !(norm(mo.name).includes(kw) || norm(mo.desc).includes(kw))) return false;
    if (status !== 'all' && moduleTag(mo, today).tag !== status) return false;

    if (pri !== 'all') {
      if (pri === 'none') { if (mo.pri) return false; }
      else if (mo.pri !== pri) return false;
    }

    if (ver !== 'all') {
      const v = owner[mo.name];
      if (ver === 'none') { if (v) return false; }
      else if (!v || v.id !== ver) return false;
    }
    return true;
  });
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
      const rng = modRange ? modRange(mo) : null;
      if (!rng || !ctx) return { miss: true };
      return { v: modStats(mo.bars, rng, ctx).pct };
    }
    case 'ship': {
      // 计划上线日口径与台账展示一致：版本日优先，无版本回退该需求的「上线」里程碑
      const v = versionOfMap(versions || [])[mo.name];
      if (v && v.date) return { v: v.date };
      const go = findGoMs(mo);
      return go && go.m ? { v: go.m } : { miss: true };
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
