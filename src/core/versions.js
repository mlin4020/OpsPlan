// ============================================================
// src/core/versions.js — 版本（迭代）领域逻辑
//
// 业务定位（已与用户确认）：
//   · 迭代 = 版本，同一件事：给一组需求一个「权威上线日」，让它们一起上线
//   · 加入版本 → 该需求图上那个「上线」里程碑被钉到版本上线日（写数据，见 scheduler/mutations.js），
//     从而图上的菱形、任务抽屉、总览「里程碑一览」、导出/分享、撤销栈全部自动一致
//   · 排期引擎保持正向（依赖 + 资源的最早工作日），本模块不做反向排期
//
// 数据形状（存在 planStore.state.versions）：
//   { id, name, date:'YYYY-MM-DD', shipped:boolean, shippedAt:'YYYY-MM-DD'|null, mods:[需求名] }
//
// 需求侧**不存**字段：版本是主、需求名是成员，一律靠 mods 反查（versionOfMap）。
// 两处存两份必然在「需求改名」时对不上，这是本项目反复踩过的坑。
// ============================================================
import { F, fmtD } from './dates.js';

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

// 需要排期的任务（非里程碑且有起止）：完成度、排期区间都只算这一类
export function workTasks(mo) {
  return ((mo && mo.bars) || []).filter(b => !b.m && b.s && b.e);
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

// 该需求的「上线」里程碑（多个取最后一个，与 addModule 的创建顺序一致）。
//
// ⚠️ 不能只认 p === 'go'：默认数据与历史数据里的上线里程碑是 `{ m:'2026-09-09', label:'9/9 上线' }`，
// **没有 p 字段**（阶段色靠 `PCOL[b.p] || PCOL.go` 兜底，一直没人注意）。
// 只按 p 找会"找不到 → 补建一个"，于是每加入一次版本就凭空多出一个「上线」菱形。
// 故按「p === 'go' 或 label 里含上线」识别：这条口径同时覆盖默认数据里的"11/13 整体上线"。
// 从 scheduler/mutations.js 搬来：需求台账读「计划上线日」必须与版本钉日期用同一口径。
export function isGoMs(b) {
  if (!b || !b.m) return false;
  if (b.p === 'go') return true;
  return /上线/.test(String(b.label || ''));
}

export function findGoMs(mo) {
  let ms = null;
  ((mo && mo.bars) || []).forEach(b => { if (isGoMs(b)) ms = b; });
  return ms;
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

// 版本下拉选项的文案：`V2.3（10/29）`。
//
// 为什么收在 core：选版本这件事有两个入口 —— 需求台账的「所属版本」下拉、
// 版本页成员行的「改版本」下拉。两处文案必须同源：同一个版本在两个页面
// 显示成两种样子，用户会怀疑自己选错了东西。
export function versionOptionLabel(v) {
  if (!v) return '';
  return `${v.name || ''}${v.date ? `（${fmtD(F(v.date))}）` : ''}`;
}

// 版本排序：**上线日倒序**（最新的排最前）；同日的按创建顺序稳定排列。
//
// 为什么倒序：版本页是"接下来要上什么"的看板，正序会把早就发完的旧版本顶在最上面，
// 每次打开都得往下翻到最新的一版 —— 那是反的。列表、台账的「所属版本」下拉、
// 成员行的「改版本」下拉共用这一份顺序，三处不能各排各的（同一页两个顺序最费解）。
//
// 没有上线日的版本排最后（老数据可能缺日期）：它不是"最新"，不该因为缺值插到队首。
export function sortVersions(versions) {
  return [...(versions || [])].sort((a, b) => {
    const da = a && a.date ? F(a.date).getTime() : null;
    const db = b && b.date ? F(b.date).getTime() : null;
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return db - da;
  });
}
