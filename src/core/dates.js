// 日期工具：从原 scheduler/app 重复的日期函数统一收口
const MS = 864e5;

export function F(s) {
  const p = String(s).split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}
export function pad(n) { return n < 10 ? '0' + n : '' + n; }
export function fmt(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
export function addDays(d, n) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}
export function diff(a, b) { return Math.round((b - a) / MS); }
export function fmtD(d) { return (d.getMonth() + 1) + '/' + d.getDate(); }
