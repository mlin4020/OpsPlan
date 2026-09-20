// ============================================================
// src/components/drag.js — 拖拽交互（任务条移动 / 边缘调整工作量 / 里程碑移动）
// 由 gantt-app.js 663-889 行迁移（startBarDrag/startBarResize/startMsDrag
//   + moveMsPreview/moveResizePreview/moveGhost/clearGhost + 全局 mousemove/mouseup）
// 这是交互核心，行为必须与源一致（含拖拽中实时预览 previewCascade/previewResize、
// 松手落位 cascade/resizeTask/moveMilestone、翻转限制、抑制点击等）。
// 依赖注入（deps）：
//   sched    - SCHED API（getTask/addDays/previewCascade/previewResize/cascade/resizeTask/moveMilestone/diff/F）
//   workday  - 工作日 API（spanDays）
//   getCtx   - () => 当前渲染 ctx，需提供 { X(d), dayW }
//   gsc      - 横向滚动容器元素
//   render   - 重绘回调
//   doc      - Document（缺省 document），用于全局事件注册与 cursor/userSelect
//   win      - Window（缺省 doc.defaultView），用于 mousemove/mouseup 全局监听
//   isReadonly - () => boolean，只读时不启动拖拽（复用 readonly.js）
// ============================================================

let barDrag = null;    // 任务条整体拖动
let barResize = null;  // 边缘调整工作量
let msDrag = null;     // 里程碑拖动
let drag = null;       // 空白处横向滚动拖拽
let suppressClick = false;
let suppressTimer = null;   // 独立计时器句柄（strict mode 下不能给 primitive 挂属性）
let lastMouseX = 0;

// 防误触：拖拽结束后短暂抑制下一次点击，避免拖拽完误开抽屉/弹层。
// 触摸设备上拖动滚动不合成 click 事件，标志会残留导致下次点击被吞，故加超时自动过期。
export function armSuppress() {
  suppressClick = true;
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => { suppressClick = false; suppressTimer = null; }, 600);
}

// 消费/检查点击抑制状态：返回当前是否处于抑制期，并清除单次抑制（供 bar click 判断）
export function consumeSuppress() {
  if (!suppressClick) return false;
  suppressClick = false;
  return true;
}

// 统一取某任务某字段为 Date（兼容字符串 'YYYY-MM-DD' 与 Date；用 sched.F）
function asDate(deps, v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  return deps.sched.F ? deps.sched.F(v) : new Date(String(v));
}

// 里程碑拖拽预览：仅横向移动上线日菱形
function moveMsPreview(days, deps) {
  const b = msDrag;
  const { getCtx, sched } = deps;
  const { X } = getCtx();
  const newDate = sched.addDays(b.startM, days);
  b.el.classList.add('dragging');
  b.el.style.left = X(newDate) + 'px';
}

// 边缘调整工作量预览：实时重绘条宽并高亮受影响任务
function moveResizePreview(days, deps) {
  const { sched, getCtx, doc } = deps;
  const { X, dayW } = getCtx();
  const b = barResize;
  const t = sched.getTask(b.taskId);
  if (!t) return;
  const newDate = sched.addDays(b.anchorDate, days);
  const s = b.edge === 'l' ? newDate : asDate(deps, t.s);
  const e = b.edge === 'r' ? newDate : asDate(deps, t.e);
  if (sched.diff(e, s) < 0) return;   // 翻转限制：不允许开始晚于结束
  b.el.classList.add('dragging');
  b.el.style.left = X(s) + 'px';
  b.el.style.width = (X(e) - X(s) + dayW) + 'px';
  const shifted = sched.previewResize(b.taskId, b.edge, newDate);
  doc.querySelectorAll('.bar[data-task-id]').forEach(el => {
    const id = el.dataset.taskId;
    if (id === b.taskId) return;
    el.classList.toggle('preview', shifted.has(id));
  });
}

// 任务条整体拖动预览：实时移动并高亮级联受影响任务
function moveGhost(days, deps) {
  const { sched, getCtx, doc } = deps;
  const { X } = getCtx();
  const b = barDrag;
  const newStart = sched.addDays(b.startD, days);
  b.el.classList.add('dragging');
  b.el.style.left = X(newStart) + 'px';
  const shifted = sched.previewCascade(b.taskId, newStart);
  doc.querySelectorAll('.bar[data-task-id]').forEach(el => {
    const id = el.dataset.taskId;
    const isAnchor = id === b.taskId;
    el.classList.toggle('preview', !isAnchor && shifted.has(id));
  });
}

function clearGhost(deps) {
  deps.doc.querySelectorAll('.bar.dragging,.bar.preview').forEach(el => {
    el.classList.remove('dragging', 'preview');
  });
}

// 全局 mousemove：按当前拖拽态分发到对应预览函数
function onMouseMove(e, deps) {
  const { getCtx, gsc } = deps;
  const { dayW } = getCtx();
  if (msDrag) {
    const days = Math.round((e.clientX - msDrag.startClientX) / dayW);
    if (!msDrag.moved && Math.abs(days) >= 1) {
      msDrag.moved = true;
      gsc.style.cursor = 'grabbing';
      deps.doc.body.style.userSelect = 'none';
    }
    if (msDrag.moved) {
      requestAnimationFrame(() => moveMsPreview(Math.round((e.clientX - msDrag.startClientX) / dayW), deps));
    }
    return;
  }
  if (barResize) {
    const days = Math.round((e.clientX - barResize.startClientX) / dayW);
    if (!barResize.moved && Math.abs(days) >= 1) {
      barResize.moved = true;
      gsc.style.cursor = 'ew-resize';
      deps.doc.body.style.userSelect = 'none';
    }
    if (barResize.moved) {
      requestAnimationFrame(() => moveResizePreview(Math.round((e.clientX - barResize.startClientX) / dayW), deps));
    }
    return;
  }
  if (barDrag) {
    const days = Math.round((e.clientX - barDrag.startClientX) / dayW);
    if (!barDrag.moved && Math.abs(days) >= 1) {
      barDrag.moved = true;
      gsc.style.cursor = 'grabbing';
      deps.doc.body.style.userSelect = 'none';
    }
    if (barDrag.moved) {
      requestAnimationFrame(() => moveGhost(Math.round((e.clientX - barDrag.startClientX) / dayW), deps));
    }
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (!drag.moved && Math.abs(dx) > 4) {
    drag.moved = true;
    gsc.style.cursor = 'grabbing';
    deps.doc.body.style.userSelect = 'none';
  }
  if (drag.moved) gsc.scrollLeft = drag.sl - dx;
}

// 全局 mouseup：按当前拖拽态落位
function onMouseUp(deps) {
  const { sched, getCtx, gsc, render } = deps;
  const { dayW } = getCtx();
  if (msDrag) {
    if (msDrag.moved) {
      const days = Math.round((lastMouseX - msDrag.startClientX) / dayW);
      if (days !== 0) {
        const newDate = sched.addDays(msDrag.startM, days);
        sched.moveMilestone(msDrag.taskId, newDate);
      }
      armSuppress();
      render();
    }
    gsc.style.cursor = '';
    deps.doc.body.style.userSelect = '';
    msDrag = null;
    return;
  }
  if (barResize) {
    if (barResize.moved) {
      const days = Math.round((lastMouseX - barResize.startClientX) / dayW);
      if (days !== 0) {
        const newDate = sched.addDays(barResize.anchorDate, days);
        sched.resizeTask(barResize.taskId, barResize.edge, newDate);
      }
      armSuppress();
      clearGhost(deps);
      render();
    }
    gsc.style.cursor = '';
    deps.doc.body.style.userSelect = '';
    barResize = null;
    return;
  }
  if (barDrag) {
    if (barDrag.moved) {
      const days = Math.round((lastMouseX - barDrag.startClientX) / dayW);
      if (days !== 0) {
        const newStart = sched.addDays(barDrag.startD, days);
        sched.cascade(barDrag.taskId, newStart);
      }
      armSuppress();
      clearGhost(deps);
      render();
    }
    gsc.style.cursor = '';
    deps.doc.body.style.userSelect = '';
    barDrag = null;
    return;
  }
  if (drag) {
    if (drag.moved) {
      gsc.style.cursor = '';
      deps.doc.body.style.userSelect = '';
      armSuppress();
    }
    drag = null;
  }
}

// 任务条 mousedown：边缘 → 调整工作量；主体 → 整体拖动（只读不响应）
export function startBarDrag(e, taskId, deps) {
  if (e.button !== 0) return;
  if (deps.isReadonly && deps.isReadonly()) return;
  const t = deps.sched.getTask(taskId);
  if (!t || t.isMs) return;
  e.stopPropagation();
  e.preventDefault();
  const rEl = e.target.closest('.bar-resize');
  if (rEl) {
    startBarResize(e, taskId, rEl.classList.contains('l') ? 'l' : 'r', t, deps);
    return;
  }
  barDrag = {
    taskId,
    startD: asDate(deps, t.s),
    durDays: deps.workday.spanDays(t.s, t.e),
    startClientX: e.clientX,
    moved: false,
    el: e.currentTarget
  };
}

function startBarResize(e, taskId, edge, t, deps) {
  if (deps.isReadonly && deps.isReadonly()) return;
  barResize = {
    taskId, edge,
    anchorDate: asDate(deps, edge === 'l' ? t.s : t.e),
    startClientX: e.clientX,
    moved: false,
    el: e.currentTarget
  };
}

// 里程碑 mousedown（只读不响应）
export function startMsDrag(e, taskId, deps) {
  if (e.button !== 0) return;
  if (deps.isReadonly && deps.isReadonly()) return;
  const t = deps.sched.getTask(taskId);
  if (!t || !t.isMs) return;
  e.stopPropagation();
  e.preventDefault();
  msDrag = {
    taskId,
    startM: asDate(deps, t.m),
    startClientX: e.clientX,
    moved: false,
    el: e.currentTarget
  };
}

// 从该位置按下时，是否应该走"空白处横向平移"。
// 需要让位的几类元素（各有自己的拖拽语义）：
//   .bar / .mile        任务条、里程碑 → 横向改期（自己 stopPropagation，这里兜底）
//   .mname[draggable]   左侧固定名称列 → 行排序手柄
//   .bar-resize         条两端手柄 → 调整工作量
// 其余区域（轨道空白、表头、需求汇总条）一律平移 —— 与工作组规划器一致。
export function isPanTarget(target) {
  if (!target || typeof target.closest !== 'function') return true;
  if (target.closest('.bar') || target.closest('.mile')) return false;
  if (target.closest('.bar-resize')) return false;
  if (target.closest('.mname[draggable="true"]')) return false;
  return true;
}

// 空白处横向滚动拖拽（与任务条拖拽区分）
export function bindGscDrag(deps) {
  if (!deps.gsc) return;
  deps.gsc.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (!isPanTarget(e.target)) return;
    drag = { x: e.clientX, sl: deps.gsc.scrollLeft, moved: false };
  });
  deps.gsc.addEventListener('click', e => {
    if (consumeSuppress()) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

// 绑定全局拖拽事件（mousemove/mouseup/鼠标位置跟踪）。返回清理函数。
export function bindDrag(deps) {
  const win = deps.win || (deps.doc && deps.doc.defaultView) || null;
  if (!win) return () => {};
  const onMove = e => {
    lastMouseX = e.clientX;
    onMouseMove(e, deps);
  };
  const onUp = () => onMouseUp(deps);
  const onTrack = e => { lastMouseX = e.clientX; };
  win.addEventListener('mousemove', onMove);
  win.addEventListener('mouseup', onUp);
  win.addEventListener('mousemove', onTrack, { passive: true });
  return () => {
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', onUp);
    win.removeEventListener('mousemove', onTrack);
  };
}
