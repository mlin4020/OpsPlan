// ============================================================
// src/utils/dom.js — DOM 通用工具
// 由 gantt-app.js 迁移：$ / bindTip / toast / modal 弹窗显隐
// 组件层（Toolbar/Drawers/Modals/Reslib 等）复用；不读 window 全局，
// DOM 引用一律经参数注入（doc / container），便于测试与解耦。
// ============================================================

// 元素选择（替代全局 $）：支持 id / [data-x] 选择器；缺省 doc = document
export function $(sel, root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  if (typeof sel === 'string' && sel[0] === '#') return doc.getElementById(sel.slice(1));
  if (typeof sel === 'string') {
    return (root || doc).querySelector(sel);
  }
  return sel; // 已是元素则原样返回
}

// 绑定悬浮提示：mousemove 跟随 + mouseleave 隐藏
// 需要 doc 提供 #tip 元素（与源结构一致）；tip 元素缺省用 document 查找
export function bindTip(el, title, desc, doc) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root) return;
  const tip = root.getElementById('tip');
  if (!tip) return;
  el.addEventListener('mousemove', e => {
    tip.innerHTML = `<b>${title}</b><div class="d">${desc}</div>`;
    tip.style.opacity = 1;
    const r = tip.getBoundingClientRect();
    const vw = (typeof innerWidth !== 'undefined') ? innerWidth : (root.defaultView ? root.defaultView.innerWidth : 0);
    tip.style.left = Math.min(e.clientX + 14, vw - r.width - 10) + 'px';
    tip.style.top = e.clientY + 14 + 'px';
  });
  el.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
}

// 轻提示 toast：首次自动创建 #toast 元素挂到 body
export function toast(msg, doc) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root) return;
  let el = root.getElementById('toast');
  if (!el) {
    el = root.createElement('div');
    el.id = 'toast'; el.className = 'toast';
    root.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2000);
}

// modal 弹窗显隐：show = true 显示（加 show class），false 隐藏
// 若同时提供 mask 元素，联动 mask 的 show class
export function modal(el, show, mask) {
  if (!el) return;
  el.classList.toggle('show', !!show);
  if (mask) mask.classList.toggle('show', !!show);
}

// 便捷：给元素批量挂 click 委托，命中 selector 内的回调执行（事件委托）
export function onDelegate(root, selector, event, handler) {
  if (!root) return;
  root.addEventListener(event, e => {
    const t = e.target && e.target.closest ? e.target.closest(selector) : null;
    if (t) handler(t, e);
  });
}
