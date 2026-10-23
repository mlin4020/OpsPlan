// 当前用户 / 角色 / 项目上下文（替代 window.CURRENT_USER/window.READONLY）
//
// access（权限级别）与 readonly（能不能写）的关系（设计文档 §8.2）：
//   access = 'full'     → 管理员 / 所属人
//   access = 'collab'   → 已登录 且 profiles.resource_name 非空
//   access = 'readonly' → 其余（游客 / 没配人名 / 全局只读）
//   readonly 恒等于 (access === 'readonly')，既有 19 个组件的 isReadonly() 语义不变
export const userStore = {
  state: {
    user: null, role: 'user', resourceName: '', isOwner: false,
    // 兼容默认值：未显式给出 access 且非只读时，permission.ctxOf 视作 'full'
    //（等价改造前"readonly=false 就是能改"）。真实值由 main-gantt 的 initProject 写入。
    access: 'full',
    project: null, projectId: null, readonly: false
  },
  _listeners: new Set(),
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  set(patch) { Object.assign(this.state, patch); this.emit(); },
  reset() {
    this.state = {
      user: null, role: 'user', resourceName: '', isOwner: false,
      access: 'full', project: null, projectId: null, readonly: false
    };
    this.emit();
  },
  emit() { this._listeners.forEach(fn => { try { fn(this.state); } catch (e) {} }); }
};
