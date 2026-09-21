// ============================================================
// src/core/versions.js — 版本（迭代）领域逻辑
//
// 业务定位（已与用户确认）：
//   · 迭代 = 版本，同一件事：给一组需求一个「权威上线日」，让它们一起上线
//   · 加入版本 → 该需求图上那个「上线」里程碑被钉到版本上线日（写数据，见 scheduler/mutations.js），
//     从而图上的菱形、任务抽屉、总览「里程碑一览」、导出/分享、撤销栈全部自动一致
//   · 排期引擎保持正向（依赖 + 资源的最早工作日），本模块只做「赶不上」预警 —— 不做反向排期
//
// 数据形状（存在 planStore.state.versions）：
//   { id, name, date:'YYYY-MM-DD', shipped:boolean, shippedAt:'YYYY-MM-DD'|null, mods:[需求名] }
//
// 需求侧**不存**字段：版本是主、需求名是成员，一律靠 mods 反查（versionOfMap）。
// 两处存两份必然在「需求改名」时对不上，这是本项目反复踩过的坑。
// ============================================================
import { F, diff } from './dates.js';

// 版本状态色：与需求状态标签同一套语义（完成绿 / 逾期红 / 进行中琥珀 / 待启动灰）——
// 同一件事在两处不能是两个颜色。
export const VERSION_COLORS = {
  shipped: '#10b981',
  ready: '#f59e0b',
  overdue: '#ef4444',
  doing: '#f59e0b',
  todo: '#94a3b8'
};

// 版本 id：稳定标识，改名不失联（成员沿用项目既有的"以需求名引用"惯例）
export function newVersionId() {
  return 'ver_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 版本成员（需求对象数组，按 mods 顺序；引用了不存在的需求时静默跳过 —— 自愈脏数据）
export function versionMembers(v, state) {
  const all = (state && state.modules) || [];
  return ((v && v.mods) || [])
    .map(name => all.find(mo => mo.name === name))
    .filter(Boolean);
}

// 需求名 → 版本（反查表）。
// 业务约束是"一条需求只能属于一个版本"（由 mutations 把关），这里遇到重复归属时
// 以先出现的版本为准，避免需求上渲染出两个版本徽标。
export function versionOfMap(versions) {
  const out = {};
  ((versions || [])).forEach(v => {
    ((v && v.mods) || []).forEach(name => {
      if (name && !out[name]) out[name] = v;
    });
  });
  return out;
}

export function findVersion(state, id) {
  return ((state && state.versions) || []).find(v => v && v.id === id) || null;
}

// 某条需求所属的版本（无则 null）
export function versionOfMod(state, modName) {
  return versionOfMap(state && state.versions)[modName] || null;
}

// 需要排期的任务（非里程碑且有起止）：完成度、最晚完成日都只算这一类
export function workTasks(mo) {
  return ((mo && mo.bars) || []).filter(b => !b.m && b.s && b.e);
}

// 需求最晚完成日（只看普通任务；null = 没有可判断的任务）
export function modLatestEnd(mo) {
  const ts = workTasks(mo).map(b => F(b.e));
  if (!ts.length) return null;
  return ts.reduce((a, b) => (b > a ? b : a));
}

// 版本排期区间：成员任务的最早开始 ~ 最晚结束（版本卡上展示用，不落库）
export function versionRange(v, state) {
  const mods = versionMembers(v, state);
  const s = [], e = [];
  mods.forEach(mo => workTasks(mo).forEach(b => { s.push(F(b.s)); e.push(F(b.e)); }));
  if (!s.length) return null;
  return {
    start: s.reduce((a, b) => (b < a ? b : a)),
    end: e.reduce((a, b) => (b > a ? b : a))
  };
}

// 版本完成度：按人日加权，与需求卡片 modStats 完全同口径（同一件事两处必须同一个数）
export function versionProgress(v, state, workday) {
  let work = 0, done = 0;
  versionMembers(v, state).forEach(mo => {
    workTasks(mo).forEach(b => {
      const wd = (workday && typeof workday.workDays === 'function') ? workday.workDays(b.s, b.e) : 1;
      work += wd;
      done += wd * ((b.done || 0) / 100);
    });
  });
  return { work, done, pct: work ? Math.round(done / work * 10000) / 100 : 0 };
}

// 「赶不上」判定：需求排得最晚的普通任务晚于版本上线日 → 返回 {days, end}，否则 null。
//   1) 待排期（unscheduled）需求不参与：它的日期本来就不可信，不该拿来报警
//   2) 没有普通任务（空需求）不参与判定
//   3) 只看普通任务，不含里程碑 —— 里程碑（上线/提测）是被钉的对象，拿它判会自我循环
export function modLate(v, mo) {
  if (!v || !v.date || !mo || mo.unscheduled) return null;
  const end = modLatestEnd(mo);
  if (!end) return null;
  const over = diff(F(v.date), end);   // > 0 表示比上线日晚
  return over > 0 ? { days: over, end } : null;
}

// 版本内所有"赶不上"的成员：[{ mo, late }]，用于版本卡与总览风险项
export function versionLateMods(v, state) {
  return versionMembers(v, state)
    .map(mo => ({ mo, late: modLate(v, mo) }))
    .filter(x => !!x.late);
}

// 版本状态口径：
//   已上线   —— 人工标记（实际发版常提前/延后，靠日期自动认定会撒谎）
//   待上线   —— 成员全部完成但还没标记上线
//   已逾期   —— 过了上线日仍有成员未完成
//   进行中   —— 有成员已开工（开工日不晚于今日，或已有完成度）
//   未开始   —— 其余
// 注意顺序：已上线 > 待上线 > 已逾期 > 进行中 > 未开始（先判"更确定"的状态）
export function versionStatus(v, state, today) {
  const mods = versionMembers(v, state);
  if (v && v.shipped) return { key: 'shipped', text: '已上线', color: VERSION_COLORS.shipped };
  const day = today instanceof Date
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
    : F(today);
  const allDone = mods.length > 0 && mods.every(mo => workTasks(mo).every(b => (b.done || 0) >= 100));
  if (allDone) return { key: 'ready', text: '待上线', color: VERSION_COLORS.ready };
  if (v && v.date && F(v.date) < day && mods.length) {
    return { key: 'overdue', text: '已逾期', color: VERSION_COLORS.overdue };
  }
  const started = mods.some(mo => workTasks(mo).some(b => (b.done || 0) > 0 || (b.s && F(b.s) <= day)));
  if (started) return { key: 'doing', text: '进行中', color: VERSION_COLORS.doing };
  return { key: 'todo', text: '未开始', color: VERSION_COLORS.todo };
}

// 版本排序：上线日升序（最近的版本排最前）；同日的按创建顺序稳定排列
export function sortVersions(versions) {
  return [...(versions || [])].sort((a, b) => {
    const da = a && a.date ? F(a.date).getTime() : Infinity;
    const db = b && b.date ? F(b.date).getTime() : Infinity;
    return da - db;
  });
}
