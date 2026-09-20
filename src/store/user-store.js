// 当前用户 / 角色 / 项目上下文（替代 window.CURRENT_USER/window.READONLY）
export const userStore = {
  state: { user: null, role: 'user', project: null, projectId: null, readonly: false },
  _listeners: new Set(),
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  set(patch) { Object.assign(this.state, patch); this.emit(); },
  reset() {
    this.state = { user: null, role: 'user', project: null, projectId: null, readonly: false };
    this.emit();
  },
  emit() { this._listeners.forEach(fn => { try { fn(this.state); } catch (e) {} }); }
};
