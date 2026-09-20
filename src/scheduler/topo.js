// ============================================================
// src/scheduler/topo.js — 拓扑排序（纯计算，与状态/DOM 解耦）
// 由 gantt-scheduler.js 103-122 行迁移：Kahn 算法 O(V+E)
// nodeIds: 参与排序的节点 id 数组；depFn(id): 该节点依赖的前置节点数组（须在 nodeIds 内）
// 返回 { order: 拓扑序（含环上节点附于尾部）, cycle: 环上节点 id 数组 }
// ============================================================
export function topoSort(nodeIds, depFn) {
  const indeg = {}, adj = {};
  nodeIds.forEach(id => { indeg[id] = 0; adj[id] = []; });
  nodeIds.forEach(id => {
    (depFn(id) || []).forEach(p => {
      if (!(p in indeg)) return;
      adj[p].push(id);
      indeg[id]++;
    });
  });
  const q = nodeIds.filter(id => indeg[id] === 0);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    adj[id].forEach(n => { if (--indeg[n] === 0) q.push(n); });
  }
  const cycle = nodeIds.filter(id => indeg[id] > 0);
  return { order: order.concat(cycle), cycle };
}
