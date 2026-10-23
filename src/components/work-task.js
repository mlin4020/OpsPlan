// ============================================================
// components/work-task.js — 资源工作视图：点击修改任务完成度
//
// 为什么单独成模块（不塞进 work-filter.js）：
//   work-filter 管"看哪些"，这里管"改什么"，两件事生命周期完全不同 ——
//   筛选器只在筛选条上委托；本模块要弹层、要读权限、要提交 mutation。
//
// 为什么不做拖拽（spec §9.1）：
//   进度条填充宽 = pct%，pct=0 时没有任何可命中元素；轨道仅约 60px 宽，
//   拖一下 2% 一跳、手机上拖不准。改成"点整格 + 弹层输入"两个问题一并消失。
//
// 权限：可编辑与否由视图渲染时决定（work-view 的 taskRow 只给可编辑的行挂
// data-wk-prog）。本模块不做二次判断 —— 但数据层（sched.setProgress）仍会挡，
// 因为权限可能在弹层打开到保存之间变化（够不着也写不进去）。
// ============================================================
const PRESETS = [0, 25, 50, 75, 100];   // 档位
const STEP = 5;                         // 步进幅度

export function bindWorkTask(deps) {
  const g = deps.gantt;
  if (!g || typeof g.addEventListener !== 'function') return null;

  const doc = deps.doc;
  let pop = null;      // 弹层根元素
  let curId = null;    // 正在编辑的任务 id

  function close() {
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
    curId = null;
  }

  function commit(pct) {
    if (!curId) return;
    const v = deps.sched.setProgress(curId, pct);
    if (v === null) {
      // 被守卫拦下（权限变了 / 任务被删 / 里程碑）：给出明确原因，别让它静默失败
      if (deps.onSyncStatus) deps.onSyncStatus('fail', { msg: '无法修改该任务的完成度' });
      close();
      return;
    }
    close();
    deps.render();        // 进度条与状态徽标一起更新（状态由 done 推导）
    if (deps.onSyncStatus) deps.onSyncStatus('ok', { msg: `完成度已更新为 ${v}%` });
  }

  function open(cell) {
    curId = cell.dataset.wkProg;
    let val = Math.max(0, Math.min(100, parseInt(cell.dataset.wkDone || '0', 10) || 0));
    const rect = cell.getBoundingClientRect();

    pop = doc.createElement('div');
    pop.className = 'wkp';
    pop.innerHTML =
      '<div class="wkp-h">完成度</div>' +
      '<div class="wkp-row"><input class="wkp-n" type="number" min="0" max="100" step="1" value="' + val + '"><b>%</b>' +
        '<button type="button" class="wkp-b" data-wkp-dial="-1">−' + STEP + '</button>' +
        '<button type="button" class="wkp-b" data-wkp-dial="1">+' + STEP + '</button></div>' +
      '<div class="wkp-presets">' +
        PRESETS.map(p => '<button type="button" class="wkp-b" data-wkp-set="' + p + '">' + p + '%</button>').join('') +
      '</div>' +
      '<div class="wkp-foot"><button type="button" class="wkp-b primary" data-wkp-ok>保存</button>' +
        '<button type="button" class="wkp-b" data-wkp-cancel>取消</button></div>';
    doc.body.appendChild(pop);
    // 贴在进度格下方；靠近屏幕右/下边缘时回收，避免被裁掉
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - w - 8)) + 'px';
    pop.style.top = Math.min(rect.bottom + 6, doc.documentElement.clientHeight - h - 8) + 'px';

    const input = pop.querySelector('.wkp-n');
    const clamp = () => {
      const n = parseInt(input.value, 10);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : val;
    };
    pop.querySelectorAll('[data-wkp-set]').forEach(b => b.addEventListener('click', () => {
      val = parseInt(b.dataset.wkpSet, 10); input.value = val;
    }));
    pop.querySelectorAll('[data-wkp-dial]').forEach(b => b.addEventListener('click', () => {
      val = clamp() + STEP * parseInt(b.dataset.wkpDial, 10); val = Math.max(0, Math.min(100, val));
      input.value = val;
    }));
    pop.querySelector('[data-wkp-ok]').addEventListener('click', () => commit(clamp()));
    pop.querySelector('[data-wkp-cancel]').addEventListener('click', close);
    // Enter 保存 / Esc 取消：这是"快改一条再下一条"的场景，键盘路径必须顺手
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(clamp()); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    input.focus();
    input.select();
  }

  g.addEventListener('click', e => {
    const cell = e.target.closest && e.target.closest('[data-wk-prog]');
    if (!cell) {
      // 点弹层内部不关（上面的按钮各自处理），点外部才关
      if (pop && !(e.target.closest && e.target.closest('.wkp'))) close();
      return;
    }
    if (pop && curId === cell.dataset.wkProg) { close(); return; }   // 再点同一格 = 收起
    close();
    open(cell);
  });

  return { close };
}
