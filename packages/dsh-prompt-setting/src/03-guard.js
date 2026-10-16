
    // #region factory guard (g-013)
    // The loader calls `descriptor.factory(require)` while it boots the page: a
    // throw here reaches DSH's module loader, not a boundary this plugin can
    // apologize from. So the whole body is built behind one guard — the two
    // failure modes seen in the field are `require('react')` missing and the
    // self-fingerprint above (an engine that refuses `Function#toString`).
    // `buildPlugin` is hoisted, so the guard can call a body that is declared
    // below it.
    try {
      return buildPlugin(require);
    } catch (error) {
      return degradedPlugin(require, error);
    }
    // #endregion
