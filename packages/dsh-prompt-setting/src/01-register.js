window.__ModuleLoader__.load({
  id: 'dsh-prompt-setting',
  // A *named function expression*, not the method shorthand, so the body can
  // refer to the function itself (`promptSettingFactory.toString()`) and
  // fingerprint the very bytes this tab is running — the only way an already
  // open tab can say which build it is (CONTRACT.md §14). The loader still
  // calls `descriptor.factory(require)`; nothing about that changes.
  factory: function promptSettingFactory(require) {
