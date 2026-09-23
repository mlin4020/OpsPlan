// ============================================================
// src/views/badge.js — 渲染层小徽标
//
// 从 core/mod-auto.js 归位过来的：priorityBadge 产出的是 HTML（带 .pri-* 类名），
// core 层不该知道 CSS 类名长什么样 —— 那是渲染层的知识。
//
// 优先级徽标 HTML：未设置（老数据没有 pri）时返回空串 —— 不替用户臆造一个 P 值。
// 只输出结构，配色全在 CSS（.pri-p0 ~ .pri-p3 / .lc-*），
// 且刻意做成"浅底 + 描边"的轻量徽标，与需求状态标签的实心色块区分开，不抢状态的可读性。
// ============================================================
import { PRIORITIES, MODULE_LIFECYCLE, LIFECYCLE_NONE } from '../core/default-data.js';

export const priorityBadge = p => (PRIORITIES.includes(p)
  ? `<span class="pri pri-${p.toLowerCase()}" title="优先级 ${p}">${p}</span>`
  : '');

// 版本徽标：这条需求属于哪个版本（迭代）。
// 取的数据是 core/versions.js 的 versionOfMap 反查结果 —— 需求侧刻意不存版本字段，
// 避免"需求改名后版本名单对不上"这类静默不一致。
export const versionBadge = v => (v && v.name
  ? `<span class="ver-badge" title="所属版本 ${v.name}${v.date ? ` · 计划 ${v.date} 上线` : ''}">${v.name}</span>`
  : '');

// 生命周期徽标：与 priorityBadge 同一分工（只出结构，配色在 CSS 的 .lc-*）。
// 差别：未设置也渲染徽标 —— 台账该列不允许出现空白，
// 空白会让读者分不清"没填"和"渲染坏了"。
const LC_CLASS = { '待确认': 'lc-todo', '已确认': 'lc-ok', '已提测': 'lc-sit', '已上线': 'lc-live' };

export const lifecycleBadge = v => {
  const key = MODULE_LIFECYCLE.includes(v) ? v : null;
  const text = key || LIFECYCLE_NONE;
  return `<span class="lc ${LC_CLASS[key] || 'lc-none'}" title="生命周期（人工维护）：${text}">${text}</span>`;
};
