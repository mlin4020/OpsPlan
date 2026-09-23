// 需求台账事件委托的**行为**测试（不需要 jsdom）：
// bindReqPage 只依赖 deps.gantt.addEventListener + viewState + 若干回调，
// 于是可以把捕获到的 click 处理器拿出来，用假 event.target 直接驱动，
// 断言"点了哪个按钮 → 调了哪个回调"。
// 这类顺序 bug 用渲染契约（只断言 HTML 里存在 data-req-*）是测不出来的：
// 渲染层一直是对的，坏掉的是委托分支的先后顺序。
import { describe, it, expect, beforeEach } from 'vitest';
import { bindReqPage } from '../src/components/req-page.js';

// 假 event.target：closest(sel) 命中时返回一个只有 dataset 的桩对象（处理器只读 dataset）
function fakeTarget(map) {
  return { target: { closest: sel => (map[sel] ? { dataset: map[sel] } : null) } };
}

function makeEnv() {
  const calls = [];
  const handlers = {};
  const deps = {
    gantt: { addEventListener: (type, fn) => { handlers[type] = fn; } },
    viewState: {},
    isReadonly: () => false,
    render: () => calls.push(['render']),
    toast: m => calls.push(['toast', m]),
    toggleReqExpanded: n => calls.push(['expand', n]),
    sched: {
      archiveModule: (n, b) => calls.push(['archive', n, b]),
      deleteModule: n => calls.push(['delete', n])
    },
    modals: {
      openNewModModal: () => calls.push(['new']),
      openEditModModal: n => calls.push(['edit', n])
    }
  };
  bindReqPage(deps);
  return { calls, click: e => handlers.click(e) };
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
});
