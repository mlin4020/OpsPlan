// ============================================================
// core/workday.js — 工作日计算 + 公开接口（带缓存）
// 由 gantt-workday.js 迁移而来，改造为依赖注入形态：
//   createWorkday({ storage, fetchImpl, holidays })
//     storage   - 兼容 localStorage 对象（getItem/setItem），缺省则用空实现（不落盘）
//     fetchImpl - fetch 实现，缺省用内置 fetch
//     holidays  - 本地兜底假期带 [{s:Date, e:Date, n:string}]（替代 window.HOLIDAYS）
// 行为与 window.WORKDAY 完全一致。
//
// 两个核心口径（全程统一，不再混用）：
//   时间周期 spanDays(s,e) = 日历跨度（含首尾，e-s+1 天），含周末与假期 —— 甘特条占位/排期用
//   工作量   workDays(s,e) = 实际工作日数（去除周末与法定假日，含调休补班）—— 人日/工作量用
// ============================================================
export function createWorkday({ storage, fetchImpl, holidays } = {}) {
  const store = storage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };
  const doFetch = fetchImpl || fetch;

  const MS = 864e5;
  // 公开接口：timor.tech 中国法定节假日（含调休补班），返回 code:0 + holiday{MM-DD:{holiday,name}}
  const API_BASE = 'https://timor.tech/api/holiday/year/';
  const CACHE_PREFIX = 'sched-holiday-cache-';
  const CACHE_TTL = 1000 * 60 * 60 * 24 * 30; // 30 天

  const pad = n => (n < 10 ? '0' + n : '' + n);
  // 统一日期解析：兼容 'YYYY-MM-DD' 字符串与 Date 对象（取本地零点）
  const F = s => {
    if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
    const p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const diff = (a, b) => Math.round((a - b) / MS);
  const md = d => pad(d.getMonth() + 1) + '-' + pad(d.getDate()); // MM-DD，与接口键一致

  // year -> { 'MM-DD': { holiday:bool, name:string } }
  const cache = {};

  function loadCache(year) {
    if (cache[year]) return cache[year];
    try {
      const raw = store.getItem(CACHE_PREFIX + year);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && obj.data && (Date.now() - obj.ts) < CACHE_TTL) {
          cache[year] = obj.data;
          return obj.data;
        }
      }
    } catch (e) { /* 忽略损坏缓存 */ }
    return null;
  }
  function saveCache(year, data) {
    cache[year] = data;
    try { store.setItem(CACHE_PREFIX + year, JSON.stringify({ ts: Date.now(), data })); } catch (e) { /* 配额或隐私模式忽略 */ }
  }

  // 拉取某年假期（公开接口），成功后写入缓存；失败/无数据返回 null
  function fetchYear(year) {
    if (loadCache(year)) return Promise.resolve(cache[year]);
    return doFetch(API_BASE + year)
      .then(r => (r && r.ok ? r.json() : null))
      .then(j => {
        if (!j || j.code !== 0 || !j.holiday) return null;
        const map = {};
        Object.keys(j.holiday).forEach(k => {
          const it = j.holiday[k];
          // 归一化键为 MM-DD（兼容接口偶尔返回 YYYY-MM-DD 的情况）
          const key = k.length > 5 ? k.slice(k.indexOf('-') + 1) : k;
          map[key] = { holiday: !!it.holiday, name: it.name || '' };
        });
        saveCache(year, map);
        return map;
      })
      .catch(() => null); // 网络/跨域失败 → 回退本地兜底
  }

  // 同步取某日信息：优先接口缓存，否则回退 holidays 兜底带
  function infoOf(date) {
    const y = date.getFullYear();
    const map = loadCache(y);
    if (map) return map[md(date)] || null;
    const t = date.getTime();
    const fb = (holidays || []).find(h => h.s.getTime() <= t && t <= h.e.getTime());
    if (fb) return { holiday: true, name: fb.n };
    return null;
  }

  // 是否为工作日：周末→否；法定假日→否；调休补班(name 含"班")→是；其余普通日→是
  function isWorkday(date) {
    const d = date instanceof Date ? date : F(date);
    const info = infoOf(d);
    if (info) {
      if (info.holiday) return false;                              // 法定假日
      if (info.name && info.name.indexOf('班') >= 0) return true;  // 调休补班（周末也上班）
    }
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return false;                      // 周末（无补班覆盖时）
    return true;
  }

  // 时间周期（日历跨度，含首尾）：e - s + 1 天
  function spanDays(s, e) {
    return diff(F(e), F(s)) + 1;
  }

  // 工作量（实际工作日数）：起止日期内去除周末与法定假日、含调休补班
  function workDays(s, e) {
    let n = 0;
    const a = F(s), b = F(e);
    let d = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    const end = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    while (d <= end) { if (isWorkday(d)) n++; d = addDays(d, 1); }
    return n;
  }

  // 从 start 起第 n 个工作日（含周末/假期的日历跨度会被自动跳过）
  function addWorkdays(start, n) {
    if (n <= 0) return F(start);
    let d = F(start), cnt = 0;
    while (cnt < n) {
      if (isWorkday(d)) cnt++;
      if (cnt === n) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
      d = addDays(d, 1);
    }
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // 第 n 个工作日对应的日历结束日（用于后续"按工作日排期"扩展）
  function spanEndByWorkdays(start, n) {
    let d = F(start), cnt = 0;
    while (cnt < n) {
      if (isWorkday(d)) cnt++;
      if (cnt === n) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
      d = addDays(d, 1);
    }
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // 预热：空闲时拉取并缓存所需年份（不阻塞渲染），返回 Promise
  function prefetch(years) {
    const ps = (years || []).map(y => (loadCache(y) ? null : fetchYear(y)));
    return Promise.all(ps.filter(Boolean));
  }

  // 某日排期信息（供表头着色）：返回 { holiday, name, isWeekend, isWorkday, isMakeup }
  //   holiday  = true 表示法定节假日（接口为准，未拉取时回退本地兜底假期带）
  //   isMakeup = name 含「班」的调休补班日（周末上班，按工作日对待）
  //   isWeekend  = 周六/周日（无补班覆盖时）
  function dayInfo(date) {
    const d = date instanceof Date ? date : F(date);
    const info = infoOf(d);
    const dow = d.getDay();
    const isWeekend = dow === 0 || dow === 6;
    let holiday = false, name = '', isMakeup = false;
    if (info) {
      holiday = !!info.holiday;
      name = info.name || '';
      isMakeup = !holiday && name.indexOf('班') >= 0;
    }
    return {
      holiday, name, isWeekend, isMakeup,
      isWorkday: isWorkday(d)
    };
  }

  return {
    isWorkday, spanDays, workDays, addWorkdays, spanEndByWorkdays,
    prefetch, fetchYear, dayInfo,
    _loadCache: loadCache, _saveCache: saveCache, _infoOf: infoOf
  };
}

// 兼容默认实例：注入全局兜底假期（与旧 window.HOLIDAYS 等价），其余依赖走默认
export default createWorkday;
