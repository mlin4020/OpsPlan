// ============================================================
// src/utils/export.js — 数据导出工具（JSON / 单文件 HTML）
// 由 gantt-app.js 的 buildFullHTML/exportHTML 迁移改造：
//   旧方案：运行时克隆当前 DOM + 依赖 #inline-app 内联脚本结构（已随 Vite 重构失效）
//   新方案：构建时用 vite-plugin-singlefile 生成 export-template.html（standalone 入口，
//           不含 Supabase、数据以 __PLAN_DATA__ 占位符注入）；运行时 fetch 模板 →
//           替换占位符 → blob 下载。
// 产出文件离线可打开（自动进入本地编辑模式，无网络依赖）。
// ============================================================

// 单文件导出模板路径（与部署 dist 同级的 export-template.html）
const TEMPLATE_URL = 'export-template.html';

// 从排期数据组装注入载荷（含项目时间窗口，与 plan-sync buildPayload 结构一致）
export function buildExportPayload({ name, modules, resources, start, end, savedBy }) {
  return {
    v: 1,
    name: name || '',
    savedAt: Date.now(),
    savedBy: savedBy || '',
    start: start ? fmtDate(start) : undefined,
    end: end ? fmtDate(end) : undefined,
    modules: modules || [],
    resources: resources || []
  };
}

// Date -> 'YYYY-MM-DD'
function fmtDate(d) {
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 拉取构建时生成的单文件模板（Vite 已把 standalone 入口的 JS/CSS 全部内联）
export async function fetchExportTemplate(base) {
  const url = (base || '') + TEMPLATE_URL;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('导出模板加载失败（HTTP ' + res.status + '）');
  return res.text();
}

// 注入排期数据到模板：替换 #plan-data 注入点的 __PLAN_DATA__ 占位符（防御 </script> 闭合）
// 注：模板中 __PLAN_DATA__ 可能出现在多处（内联脚本逻辑/注释），必须用唯一锚点定位注入点。
const PLAN_ANCHOR = 'id="plan-data">__PLAN_DATA__</script>';
export function injectPlanData(tpl, payload) {
  const dataJson = JSON.stringify(payload).replace(/<\//g, '<\\/');
  if (tpl.indexOf(PLAN_ANCHOR) === -1) {
    throw new Error('导出模板缺少 #plan-data 注入点');
  }
  return tpl.replace(PLAN_ANCHOR, 'id="plan-data">' + dataJson + '</script>');
}

// 组装完整可下载的导出 HTML（异步：需先 fetch 模板）
export async function buildExportHTML(payload, base) {
  const tpl = await fetchExportTemplate(base);
  return injectPlanData(tpl, payload);
}

// 触发浏览器下载
export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 200);
}

// 聚合导出
export default { buildExportPayload, buildExportHTML, injectPlanData, fetchExportTemplate, downloadFile };
