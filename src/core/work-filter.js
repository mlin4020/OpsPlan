// ============================================================
// src/core/work-filter.js — 资源工作视图的筛选口径（纯逻辑，不碰 DOM）
//
// 为什么单独成模块：筛选条要在两个入口都能用 ——
//   排期页（components/index.js 的 bindAll）与导出的单文件查看器（main-standalone.js 没有组件层）。
//   把"什么算命中"收敛到一处，两边共用同一套判定，避免同一份数据在两处筛出不同结果。
//
// 四个维度默认全空 = 不过滤（空数组是"不限"而不是"一个都不要"），维度之间是 AND 关系。
// 状态口径复用 core/task-status.js 的 taskStatus，与清单里的状态徽标同源（筛"已逾期"必须
// 恰好筛出显示"已逾期"的那几条，否则用户第一眼就会不信这个筛选器）。
// ============================================================
import { PNAME, PRIORITIES, normalizePriority } from './default-data.js';
import { taskStatus } from './task-status.js';

// 状态筛选项：key 必须与 taskStatus 的返回 key 一一对应（漂移会静默筛成空）
export const WORK_STATE_OPTIONS = [
  { key: 'overdue', text: '已逾期', color: '#ef4444' },
  { key: 'doing', text: '进行中', color: '#f59e0b' },
  { key: 'todo', text: '未开始', color: '#94a3b8' },
  { key: 'done', text: '已完成', color: '#10b981' }
];

// 优先级筛选项：末尾的 ''（未设置）是**刻意保留**的一项 ——
// 历史数据里没有 pri 的任务最容易在梳理时被漏掉，筛选器必须能单独把它们翻出来
export const WORK_PRI_OPTIONS = [...PRIORITIES, ''];

// 人员筛选的两个特殊值：'' = 全部人员；UNASSIGNED = 还没有排人负责的任务
export const UNASSIGNED = '__none__';

export const WORK_PRI_TEXT = { '': '未设置' };

// 空白筛选：新建 / 重置都用它，保证"重置"回到的是同一份口径而不是手写的另一份默认值
export function defaultWorkFilter() {
  return { q: '', person: '', states: [], pris: [] };
}

// 归一化：外部（viewState / URL 参数 / 测试）传进来的值一律过一遍，
// 剔除已不存在的状态 key 与非法优先级，避免一个脏值让整个筛选器永远筛不出东西
export function normalizeWorkFilter(f) {
  if (!f) return defaultWorkFilter();
  return {
    q: String(f.q == null ? '' : f.q),
    person: f.person ? String(f.person) : '',
    states: Array.isArray(f.states)
      ? f.states.filter(k => WORK_STATE_OPTIONS.some(o => o.key === k))
      : [],
    pris: Array.isArray(f.pris)
      ? f.pris.filter(p => WORK_PRI_OPTIONS.includes(p))
      : []
  };
}

// 是否有任何条件生效（决定重置按钮是否可点、清单标题是否打"已筛选"标记）
export function isWorkFilterActive(f) {
  const n = normalizeWorkFilter(f);
  return !!(n.q || n.person || n.states.length || n.pris.length);
}

// 人员在筛选器里的归属：'unassigned' | 'person' | null（不限）
export function personScope(nf) {
  if (nf.person === UNASSIGNED) return 'unassigned';
  if (nf.person) return 'person';
  return null;
}

/**
 * 单条任务是否命中筛选。
 * @param {object} t 任务（含 mod / res / s / e / done / p / name）
 * @param {object} filter 原始筛选对象（内部会归一化）
 * @param {{today:Date, modPri:Object}} deps 状态判定与优先级取值所需
 */
export function taskMatchesFilter(t, filter, deps) {
  const f = normalizeWorkFilter(filter);
  const today = deps && deps.today;
  const modPri = (deps && deps.modPri) || {};

  // 人员：'未分配' 与具体人名互斥，所以放在同一个分支里，不写成两条 AND 条件（否则会互相打架）
  const scope = personScope(f);
  if (scope === 'unassigned') {
    if (t.res && t.res.length) return false;
  } else if (scope === 'person') {
    if (!(t.res || []).includes(f.person)) return false;
  }

  if (f.states.length && !f.states.includes(taskStatus(t, today).key)) return false;

  if (f.pris.length) {
    // 未设置归一成 ''（而不是 null），与 WORK_PRI_OPTIONS 的取值口径一致
    const p = normalizePriority(modPri[t.mod]) || '';
    if (!f.pris.includes(p)) return false;
  }

  if (f.q) {
    // 关键词同时匹配任务名 / 阶段名 / 需求名 / 人名：
    // 员工通常直接搜自己的名字，不该逼他先想清楚"这算哪个维度"
    const q = f.q.trim().toLowerCase();
    if (q) {
      const hay = [
        t.name || '',
        PNAME[t.p] || '',
        t.mod || '',
        (t.res || []).join(' ')
      ].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
  }
  return true;
}

// 批量过滤（保持入参顺序，排序交给视图层）
export function filterWorkTasks(list, filter, deps) {
  if (!isWorkFilterActive(filter)) return list;
  return list.filter(t => taskMatchesFilter(t, filter, deps));
}

/**
 * 筛选条件的一句话描述（用于清单标题的"已筛选：…"提示）。
 * 空条件不返回空串以外的内容，调用方据此决定是否显示。
 */
export function describeWorkFilter(f, deps) {
  const n = normalizeWorkFilter(f);
  const parts = [];
  if (n.person === UNASSIGNED) parts.push('未分配');
  else if (n.person) parts.push(n.person);
  if (n.q) parts.push(`关键词「${n.q}」`);
  if (n.states.length) {
    parts.push(n.states.map(k => (WORK_STATE_OPTIONS.find(o => o.key === k) || {}).text || k).join('/'));
  }
  if (n.pris.length) {
    parts.push(n.pris.map(p => WORK_PRI_TEXT[p] || p).join('/'));
  }
  return parts.join(' · ');
}
