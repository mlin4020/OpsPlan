// ============================================================
// src/scheduler/history.js — 撤销/重做历史记录管理器
// 基于 snapshot 栈：每次修改前记录当前状态快照（深拷贝），
// 撤销/重做时恢复对应快照，最大保留 50 步。
// ============================================================

// 深拷贝 state（modules / resources / versions / start / end 独立）
// ⚠️ versions 必须一起快照：否则撤销后「版本列表」留在新状态、而成员需求的
//    上线日已回滚 → 版本成员与日期自相矛盾（版本页显示的行和图上菱形对不上）。
function cloneState(state) {
  return {
    modules: JSON.parse(JSON.stringify(state.modules || [])),
    resources: JSON.parse(JSON.stringify(state.resources || [])),
    versions: JSON.parse(JSON.stringify(state.versions || [])),
    start: state.start ? new Date(state.start.getTime()) : null,
    end: state.end ? new Date(state.end.getTime()) : null
  };
}

// 还原 state（从快照 → 新 Date 对象）
function restoreState(target, snapshot) {
  target.modules = JSON.parse(JSON.stringify(snapshot.modules || []));
  target.resources = JSON.parse(JSON.stringify(snapshot.resources || []));
  target.versions = JSON.parse(JSON.stringify(snapshot.versions || []));
  target.start = snapshot.start ? new Date(snapshot.start.getTime()) : null;
  target.end = snapshot.end ? new Date(snapshot.end.getTime()) : null;
}

export function createHistory(ctx) {
  const stack = [];     // 快照栈（从旧到新）
  let index = -1;       // 当前指针（-1 = 无历史）
  const MAX_LEN = 50;

  // 记录当前状态为快照（在每次修改前调用）
  function recordBefore() {
    // 如果当前指针不在栈顶，说明有"未来"状态被抛弃（做了撤销后又修改）
    if (index < stack.length - 1) {
      stack.splice(index + 1);
    }
    const snapshot = cloneState(ctx.getState());
    stack.push(snapshot);
    if (stack.length > MAX_LEN) stack.shift();
    index = stack.length - 1;
  }

  function canUndo() {
    return index > 0;
  }

  function canRedo() {
    return index < stack.length - 1;
  }

  // 从栈中恢复指定索引的快照
  function restoreFromStack(idx) {
    const snapshot = stack[idx];
    restoreState(ctx.getState(), snapshot);
    // 通知 planStore 订阅者 + 重建索引 + 持久化 + 推送服务器
    ctx.setState({
      modules: ctx.getState().modules,
      resources: ctx.getState().resources,
      versions: ctx.getState().versions,
      start: ctx.getState().start,
      end: ctx.getState().end
    });
    ctx.collect();
    ctx.save(true);     // true = 跳过历史记录（避免循环）
  }

  // 撤销：恢复到上一个快照
  function undo() {
    if (!canUndo()) return false;
    index--;
    restoreFromStack(index);
    return true;
  }

  // 重做：恢复到下一个快照
  function redo() {
    if (!canRedo()) return false;
    index++;
    restoreFromStack(index);
    return true;
  }

  // 重置历史（导入/重置时清空）
  function reset() {
    stack.length = 0;
    index = -1;
  }

  // 初始记录（加载数据后调用）
  function recordInitial() {
    stack.length = 0;
    const snapshot = cloneState(ctx.getState());
    stack.push(snapshot);
    index = 0;
  }

  return {
    recordBefore,
    recordInitial,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
    get length() { return stack.length; },
    get currentIndex() { return index; }
  };
}