// 需求台账事件委托的**行为**测试（不需要 jsdom）：
// bindReqPage 只依赖 deps.gantt.addEventListener + viewState + 若干回调，
// 于是可以把捕获到的 click 处理器拿出来，用假 event.target 直接驱动，
// 断言"点了哪个按钮 → 调了哪个回调"。
// 这类顺序 bug 用渲染契约（只断言 HTML 里存在 data-req-*）是测不出来的：
// 渲染层一直是对的，坏掉的是委托分支的先后顺序。
import { describe, it, expect, beforeEach } from 'vitest';
import { bindReqPage } from '../src/components/req-page.js';
import { userStore } from '../src/store/user-store.js';

// 假 event.target：closest(sel) 命中时返回桩对象（处理器只读 dataset 与 value）。
// props 用于补 value —— 行内编辑靠它取值。
function fakeTarget(map, props) {
  return { target: { closest: sel => (map[sel] ? { dataset: map[sel], ...(props || {}) } : null) } };
}

function makeEnv(opts) {
  const calls = [];
  const handlers = {};
  const deps = {
    gantt: { addEventListener: (type, fn) => { handlers[type] = fn; } },
    viewState: {},
    isReadonly: () => !!(opts && opts.readonly),
    planStore: opts && opts.planStore,
    render: () => calls.push(['render']),
    toast: m => calls.push(['toast', m]),
    toggleReqExpanded: n => calls.push(['expand', n]),
    sched: {
      archiveModule: (n, b) => calls.push(['archive', n, b]),
      deleteModule: n => calls.push(['delete', n]),
      updateModule: o => calls.push(['update', o]),
      moveModule: (from, to, before) => calls.push(['moveModule', from, to, before]),
      // 版本归属不在需求上（需求侧不存 versionId），走的是这条独立入口。
      // id === 'ver_bad' 用来模拟"已归档需求不能加入版本"这类拒绝。
      setModuleVersion: (n, id) => {
        if (id === 'ver_bad') throw new Error('已归档需求不能加入版本，请先取消归档');
        calls.push(['setVersion', n, id]);
        return { to: id ? { id, name: 'V2' } : null };
      }
    },
    modals: {
      openNewModModal: () => calls.push(['new']),
      openEditModModal: n => calls.push(['edit', n])
    }
  };
  bindReqPage(deps);
  return {
    calls,
    click: e => handlers.click(e),
    change: e => handlers.change(e),
    keydown: e => handlers.keydown(e),
    dragstart: e => handlers.dragstart(e),
    dragover: e => handlers.dragover(e),
    drop: e => handlers.drop(e),
    dragend: e => handlers.dragend(e)
  };
}

describe('components/req-page: 台账行内操作的委托顺序', () => {
  let env;
  beforeEach(() => { env = makeEnv(); });

  it('点「编辑」打开编辑抽屉，不能被当成"展开/收起行"', () => {
    // 真实 DOM 里编辑按钮就在 <tr data-req-row> 内部 → 两个 closest 都会命中
    env.click(fakeTarget({
      '[data-req-edit]': { reqEdit: '重点县域' },
      '[data-req-row]': { reqRow: '重点县域' }
    }));
    expect(env.calls).toContainEqual(['edit', '重点县域']);
    expect(env.calls.some(c => c[0] === 'expand')).toBe(false);
  });

  it('点「归档 / 取消归档」走 archiveModule，并带上反向布尔', () => {
    env.click(fakeTarget({
      '[data-req-archive]': { name: '重点县域', archived: '1' },
      '[data-req-row]': { reqRow: '重点县域' }
    }));
    expect(env.calls).toContainEqual(['archive', '重点县域', false]);   // 已归档 → 取消归档
    expect(env.calls.some(c => c[0] === 'expand')).toBe(false);
  });

  it('点「删除」走 deleteModule（confirm 放行）', () => {
    const orig = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      env.click(fakeTarget({
        '[data-req-del]': { name: '重点县域' },
        '[data-req-row]': { reqRow: '重点县域' }
      }));
      expect(env.calls).toContainEqual(['delete', '重点县域']);
      expect(env.calls.some(c => c[0] === 'expand')).toBe(false);
    } finally { globalThis.confirm = orig; }
  });

  it('点行本身（没点到操作按钮）仍然是展开 / 收起', () => {
    env.click(fakeTarget({ '[data-req-row]': { reqRow: '重点县域' } }));
    expect(env.calls).toContainEqual(['expand', '重点县域']);
  });

  it('点表头仍然是排序，不受行操作影响', () => {
    env.click(fakeTarget({ '[data-req-sort]': { reqSort: 'name' } }));
    expect(env.calls).toContainEqual(['render']);
    expect(env.calls.some(c => c[0] === 'expand' || c[0] === 'edit')).toBe(false);
  });

  // ---- 行内编辑（生命周期 / 提出人）----
  // 三个坑：① 控件在 <tr data-req-row> 内，点它会顺手展开行；
  //        ② change 与「筛选下拉」共用同一个事件，分支顺序不能反；
  //        ③ 值没变不能写数据，否则点开下拉再关掉都会存一次。

  it('行内改生命周期：commit 到 updateModule，且不被当成展开行', () => {
    env.change(fakeTarget({
      '[data-req-inline]': { reqInline: 'lifecycle', name: '重点县域', prev: '待确认' },
      '[data-req-row]': { reqRow: '重点县域' }
    }, { value: '已确认' }));
    expect(env.calls).toContainEqual(['update', { oldName: '重点县域', lifecycle: '已确认' }]);
    expect(env.calls).toContainEqual(['render']);
    expect(env.calls.some(c => c[0] === 'expand')).toBe(false);
  });

  it('行内改提出人：回车即提交（change 只在失焦触发，不处理回车会像没生效）', () => {
    env.keydown({
      key: 'Enter',
      preventDefault: () => {},
      target: {
        closest: sel => (sel === '[data-req-inline]'
          ? { dataset: { reqInline: 'proposedBy', name: '重点县域', prev: '' }, value: '郑致远' }
          : null)
      }
    });
    expect(env.calls).toContainEqual(['update', { oldName: '重点县域', proposedBy: '郑致远' }]);
  });

  it('值没变就不写、不重绘', () => {
    env.change(fakeTarget({
      '[data-req-inline]': { reqInline: 'lifecycle', name: '重点县域', prev: '已确认' }
    }, { value: '已确认' }));
    expect(env.calls.some(c => c[0] === 'update')).toBe(false);
    expect(env.calls.some(c => c[0] === 'render')).toBe(false);
  });

  it('点行内控件不会展开行（与点操作按钮同一套排除逻辑）', () => {
    env.click(fakeTarget({
      '[data-req-inline]': { reqInline: 'lifecycle' },
      '[data-req-row]': { reqRow: '重点县域' }
    }));
    expect(env.calls.some(c => c[0] === 'expand')).toBe(false);
  });

  it('只读模式下行内编辑不写数据', () => {
    const ro = makeEnv({ readonly: true });
    ro.change(fakeTarget({
      '[data-req-inline]': { reqInline: 'lifecycle', name: '重点县域', prev: '待确认' }
    }, { value: '已确认' }));
    expect(ro.calls.some(c => c[0] === 'update')).toBe(false);
  });

  // ---- 行内调所属版本 ----
  // 三个坑：① 版本不在需求上（需求侧不存 versionId）→ 必须走 setModuleVersion，
  //         若顺手走 updateModule，传进去的 version 字段会被当成需求属性、静默无效；
  //        ② 「未加入版本」要传 null，不能把空串当版本 id；
  //        ③ 失败（如已归档）要回滚控件，界面不能显示成"已改好"。

  it('行内改所属版本：走 setModuleVersion，且不被当成展开行', () => {
    env.change(fakeTarget({
      '[data-req-inline]': { reqInline: 'version', name: '重点县域', prev: 'ver_1' },
      '[data-req-row]': { reqRow: '重点县域' }
    }, { value: 'ver_2' }));
    expect(env.calls).toContainEqual(['setVersion', '重点县域', 'ver_2']);
    expect(env.calls.some(c => c[0] === 'update')).toBe(false);   // 不能误走需求字段入口
    expect(env.calls).toContainEqual(['toast', '已调整到「V2」']);
    expect(env.calls.some(c => c[0] === 'expand')).toBe(false);
  });

  it('行内改所属版本：选「未加入版本」传 null，提示已移出', () => {
    env.change(fakeTarget({
      '[data-req-inline]': { reqInline: 'version', name: '重点县域', prev: 'ver_1' }
    }, { value: '' }));
    expect(env.calls).toContainEqual(['setVersion', '重点县域', null]);
    expect(env.calls).toContainEqual(['toast', '已移出版本']);
  });

  it('改版本被拒（已归档）：控件回滚成原值，不重绘', () => {
    const el = { dataset: { reqInline: 'version', name: '重点县域', prev: 'ver_1' }, value: 'ver_bad' };
    env.change({ target: { closest: sel => (sel === '[data-req-inline]' ? el : null) } });
    expect(el.value).toBe('ver_1');
    expect(env.calls.some(c => c[0] === 'setVersion' || c[0] === 'render')).toBe(false);
    expect(env.calls).toContainEqual(['toast', '已归档需求不能加入版本，请先取消归档']);
  });
});

// ---- 拖动调整组内顺序 ----
// 假元素 / 假事件：处理器会读 dataset、classList、getBoundingClientRect 与 clientY。
// 手柄（[data-req-drag]）还得能自己 closest 到所属行 —— 真实 DOM 里 td.closest('tr') 正是这么走的。
function fakeEl(ds, extra) {
  return {
    dataset: ds,
    classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({ top: 0, height: 10 }),
    ...(extra || {})
  };
}
function dragEvt(map, clientY) {
  const row = map['[data-req-row]'] ? fakeEl(map['[data-req-row]']) : null;
  const handle = map['[data-req-drag]']
    ? fakeEl(map['[data-req-drag]'], { closest: sel => (sel === '[data-req-row]' ? row : null) })
    : null;
  return {
    target: { closest: sel => (sel === '[data-req-drag]' ? handle : (sel === '[data-req-row]' ? row : null)) },
    clientY: clientY == null ? 0 : clientY,
    prevented: 0,
    preventDefault() { this.prevented++; },
    dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' }
  };
}

describe('components/req-page: 台账拖动排序', () => {
  let env;
  beforeEach(() => { env = makeEnv(); });

  const start = (name, tier) => env.dragstart(dragEvt({
    '[data-req-drag]': { reqDrag: name },
    '[data-req-row]': { reqRow: name, reqTier: String(tier) }
  }));

  it('同档内可落位：moveModule(from, to, before) + 重绘 + 提示', () => {
    start('甲', 3);
    const e = dragEvt({ '[data-req-row]': { reqRow: '乙', reqTier: '3' } }, 9);   // 落在行的下半 → 插到其后
    env.dragover(e);
    expect(e.prevented).toBe(1);            // preventDefault 才是"允许放下"的信号
    env.drop(e);
    expect(env.calls).toContainEqual(['moveModule', '甲', '乙', false]);
    expect(env.calls).toContainEqual(['render']);
    expect(env.calls).toContainEqual(['toast', '已调整需求顺序']);
  });

  it('落在行的上半 → 插到它前面', () => {
    start('甲', 3);
    env.drop(dragEvt({ '[data-req-row]': { reqRow: '乙', reqTier: '3' } }, 1));
    expect(env.calls).toContainEqual(['moveModule', '甲', '乙', true]);
  });

  it('跨档拦住：不给落点（不 preventDefault），也不动数据', () => {
    start('甲', 3);
    const e = dragEvt({ '[data-req-row]': { reqRow: '乙', reqTier: '6' } });
    env.dragover(e);
    expect(e.prevented).toBe(0);
    env.drop(e);
    expect(env.calls.some(c => c[0] === 'moveModule')).toBe(false);
    expect(env.calls).toContainEqual(['toast', '只能在同一分组内调整顺序']);
  });

  it('拖回自己身上不动数据', () => {
    start('甲', 3);
    const e = dragEvt({ '[data-req-row]': { reqRow: '甲', reqTier: '3' } });
    env.dragover(e);
    env.drop(e);
    expect(env.calls.some(c => c[0] === 'moveModule')).toBe(false);
  });

  it('只读模式：拖都不让起，后续 drop 也不处理', () => {
    env = makeEnv({ readonly: true });
    const s = dragEvt({
      '[data-req-drag]': { reqDrag: '甲' },
      '[data-req-row]': { reqRow: '甲', reqTier: '3' }
    });
    env.dragstart(s);
    expect(s.prevented).toBe(1);
    env.drop(dragEvt({ '[data-req-row]': { reqRow: '乙', reqTier: '3' } }));
    expect(env.calls.some(c => c[0] === 'moveModule')).toBe(false);
  });
});

// ============================================================
// Task 12：台账行操作的归属口径
//   按钮在视图层已按归属不渲染（见 tests/views.test.js）；这里锁委托层：
//   即使拿到一个"本该被藏起来的"按钮（旧 DOM 残留 / 键盘路径），也不能写。
//   但字段级行内编辑（生命周期 / 提出人 / 所属版本）对协作者必须仍然可用。
// ============================================================
describe('components/req-page: 归档/删除按归属拦截（Task 12）', () => {
  const planStoreOf = owner => ({
    state: { modules: [{ name: '重点县域', owner, bars: [] }] }
  });
  const withCollab = (env) => {
    userStore.set({ readonly: false, access: 'collab', resourceName: '张三', role: 'user' });
    return env;
  };

  beforeEach(() => { userStore.reset(); });

  it('协作者点别人的需求的「归档」：不调 archiveModule', () => {
    const env = withCollab(makeEnv({ planStore: planStoreOf('李四') }));
    env.click(fakeTarget({
      '[data-req-archive]': { name: '重点县域', archived: '0' },
      '[data-req-row]': { reqRow: '重点县域' }
    }));
    expect(env.calls.some(c => c[0] === 'archive')).toBe(false);
  });

  it('协作者点无主需求的「删除」：不调 deleteModule', () => {
    const env = withCollab(makeEnv({ planStore: planStoreOf(undefined) }));
    const orig = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      env.click(fakeTarget({
        '[data-req-del]': { name: '重点县域' },
        '[data-req-row]': { reqRow: '重点县域' }
      }));
      expect(env.calls.some(c => c[0] === 'delete')).toBe(false);
    } finally { globalThis.confirm = orig; }
  });

  it('协作者点自己需求的「归档」：放行', () => {
    const env = withCollab(makeEnv({ planStore: planStoreOf('张三') }));
    env.click(fakeTarget({
      '[data-req-archive]': { name: '重点县域', archived: '0' },
      '[data-req-row]': { reqRow: '重点县域' }
    }));
    expect(env.calls).toContainEqual(['archive', '重点县域', true]);
  });

  it('字段级行内编辑（生命周期）对协作者仍然可用 —— 不被归属判定误伤', () => {
    const env = withCollab(makeEnv({ planStore: planStoreOf('李四') }));
    env.change(fakeTarget({
      '[data-req-inline]': { reqInline: 'lifecycle', name: '重点县域', prev: '待确认' },
      '[data-req-row]': { reqRow: '重点县域' }
    }, { value: '已确认' }));
    expect(env.calls).toContainEqual(['update', { oldName: '重点县域', lifecycle: '已确认' }]);
  });
});


