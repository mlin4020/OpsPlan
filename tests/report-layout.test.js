// ============================================================
// 排期总览布局契约测试
// 刻度尺(.rtl2-scale) 与轨道(.rtl2-track) 必须共用同一「左偏移 + 宽度」，
// 否则刻度标签会相对轨道内容（今日线 / 排期条 / 里程碑）整体偏移：
//   偏移量 Δ(p) = (scale起点 - track起点) + p × (scale宽 - track宽)
// 左端最大、右端趋近 0，表现为「今日线看似落在错误的日期刻度下方」。
//
// 历史：21dfeec 曾修刻度按真实日期比例定位；b13ee0b 新增 .rtl2-pct 百分比列
// （+32px 宽 +12px gap）时未同步 .rtl2-scale 的 margin-left，导致错位复发。
//
// jsdom 不做布局计算，故此处以 CSS 文本契约做回归保护。
// 对应源码：src/styles/gantt.css 的 .rtl2 系列规则。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../src/styles/gantt.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

// 取出形如 `.sel{ ... }` 的规则体（规则均为单行、体内不含 `}`）
const ruleBody = sel => {
  const i = css.indexOf(sel + '{');
  if (i < 0) return '';
  return css.slice(i + sel.length + 1, css.indexOf('}', i));
};

describe('report 排期总览：刻度尺与轨道几何必须一致', () => {
  it('.rtl2 上定义统一的列宽变量（名称列 / 百分比列 / 间距 / 左偏移）', () => {
    const rtl2 = ruleBody('.rtl2');
    // 名称列必须放得下常见需求名（≥96px ≈ 8 个汉字），调小它会把名字压回省略号
    const nameW = Number((rtl2.match(/--rtl2-name-w:(\d+)px/) || [])[1]);
    expect(nameW).toBeGreaterThanOrEqual(96);
    expect(rtl2).toContain('--rtl2-pct-w:32px');
    expect(rtl2).toContain('--rtl2-gap:12px');
    // 左偏移 = 名称列 + 百分比列 + 两个 gap，必须由变量推导而非写死
    expect(rtl2).toContain('--rtl2-lead:calc(');
  });

  it('刻度尺用 var(--rtl2-lead) 定位，不写死像素', () => {
    const scale = ruleBody('.rtl2-scale');
    expect(scale).toContain('var(--rtl2-lead)');
    expect(scale).not.toContain('100px');
    // 左右 padding 会改变内容区起点/宽度，必须为 0 才能与轨道等宽
    expect(scale).toContain('padding:0 0');
  });

  it('轨道各列引用同一批变量（防止列宽变化后再次漂移）', () => {
    expect(ruleBody('.rtl2-row')).toContain('gap:var(--rtl2-gap)');
    expect(ruleBody('.rtl2-name')).toContain('width:var(--rtl2-name-w)');
    // 必须固定宽度而非 min-width：百分比文本变宽会推后轨道起点
    expect(ruleBody('.rtl2-pct')).toContain('width:var(--rtl2-pct-w)');
  });

  it('需求名允许折行完整显示，不再截断成省略号', () => {
    const name = ruleBody('.rtl2-name');
    expect(name).toContain('white-space:normal');
    // 曾经的 nowrap + overflow:hidden + ellipsis 会把「标保督导增加渠道日报页面」截成「标保督导增加…」
    expect(name).not.toContain('white-space:nowrap');
    expect(name).not.toContain('text-overflow:ellipsis');
    expect(name).not.toContain('overflow:hidden');
    // 折行要能落在行高内：行高收紧，且轨道高度固定 66px —— 两三行仍居中，不撑开行距
    expect(name).toContain('line-height:1.3');
    expect(ruleBody('.rtl2-track')).toContain('height:66px');
  });

  it('单文件导出模板已同步最新样式（失败时请运行 npm run build:export）', () => {
    const p = fileURLToPath(new URL('../public/export-template.html', import.meta.url));
    if (!existsSync(p)) return;   // 未构建过导出模板时跳过
    expect(readFileSync(p, 'utf8')).toContain('--rtl2-lead');
  });
});
