/**
 * `dsh-prompt-setting` — Client half (stage 1C: the Prompt manager settings page).
 *
 * Hand-written CommonJS factory registered into the browser module loader:
 * no bundler, no JSX, no TypeScript, no runtime dependency beyond `react`
 * (and the optional `@deepseek-ai/dsh-client-ui-primitives` probe).
 *
 * Stage 1C scope: a real page in 「设置 / Settings」 that consumes the frozen
 * `/prompt-setting/*` REST contract (CONTRACT.md Revision 3):
 *   - status bar: `mounted`, the three-state `frozenScope` verdict, both
 *     layers' `enabled`/`path`/`reason`, `generatedAt`, a refresh button;
 *   - session selector sourced from the **props** `useSessions` root hook,
 *     with a manual-id degradation when the hook is absent;
 *   - section view: `name`/`index`/layer/`overridable`/`origin` + filters;
 *   - full-text view: `rendered` with search highlight and count, the
 *     `base` ↔ `effective` comparison, and the `renderedResolved: false`
 *     warning;
 *   - edit panel: `replace` / `hide` / `append` (with an optional target
 *     index) into the user or workspace layer, with the「next turn」notice;
 *   - override management: the merged override list with per-entry undo.
 *
 * Two hard rules from the earlier stages are preserved because they are what
 * keeps this page from going blank (see NOTES.md §4 and §7):
 *   - `primitives` vs `fallback` is *probed*, never assumed, and the branch
 *     actually taken is rendered as `data-renderer`;
 *   - every hook runs before the `try`, and building the tree happens inside
 *     it, so a failure renders a readable card instead of a white panel.
 *
 * Markers the page carries for machine inspection (`data-plugin`,
 * `data-renderer`, `data-render-state`) are joined in 1C by `data-phase`,
 * `data-frozen-state`, `data-section-name`, `data-error-code` and friends, so
 * `node --test` can assert the contract consumption without a browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-setting',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // #region primitives probe
    // Never let the probe throw past this factory: a failure here must degrade
    // to the hand-built renderer, not blank the settings panel.
    let primitivesModule = null;
    let primitivesFailure = '';
    try {
      primitivesModule = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      primitivesModule = null;
      primitivesFailure = error && error.message ? String(error.message) : String(error);
    }
    const primitives =
      primitivesModule !== null && typeof primitivesModule === 'object' ? primitivesModule : null;
    const primitivesUsable = primitives !== null && typeof primitives.Button === 'function';
    /** Which renderer this module instance actually uses: 'primitives' | 'fallback'. */
    const RENDERER = primitivesUsable ? 'primitives' : 'fallback';
    // #endregion

    /** Locale namespace owned by this plugin (zh/en dictionaries are inlined). */
    const NS = 'settings.promptSetting';
    /** Stage 1A probe route; kept as a renderer-reporting side channel. */
    const PING_PATH = '/prompt-setting/ping';
    const SNAPSHOT_PATH = '/prompt-setting/snapshot';
    const OVERRIDES_PATH = '/prompt-setting/overrides';
    /** Sentinel for "no session": never a legal `Agent.id`, so it cannot collide. */
    const GLOBAL_SESSION = '\u0000global';
    const VIEWS = ['sections', 'full', 'overrides'];
    /** CONTRACT.md §2.2 — the four `origin` values, in presentation order. */
    const ORIGINS = ['registered', 'appended', 'downstream-added', 'unmatched-override'];
    const LAYER_FILTERS = ['all', 'default', 'user', 'workspace'];
    const OVERRIDABLE_FILTERS = ['all', 'yes', 'no'];
    const ORIGIN_FILTERS = ['all', 'registered', 'appended', 'downstream-added', 'unmatched-override'];
    const ACTIONS = ['replace', 'hide', 'append'];
    /** Upper bound on rendered lines put into the DOM (a long prompt is real). */
    const MAX_VIEW_LINES = 3000;

    // #region error-code dictionary (CONTRACT.md §4.4, every code gets copy)
    /**
     * `code` → `[zh, en]`. The table is the single source of both the
     * `error.CODE` dictionary entries and the lookup used when a request
     * fails, so a code can never be rendered as a bare identifier.
     */
    const ERROR_TEXT = {
      'invalid-json': ['请求体不是合法 JSON。', 'The request body is not valid JSON.'],
      'invalid-override': ['section 缺失或不是对象。', 'The "section" field is missing or not an object.'],
      'missing-name': ['缺少段名 name。', 'The section "name" is missing.'],
      'name-too-long': ['段名超过 200 个字符。', 'The section name exceeds 200 characters.'],
      'invalid-name': ['段名包含控制字符。', 'The section name contains control characters.'],
      'unknown-action': [
        'action 必须是 replace、hide 或 append。',
        'The action must be replace, hide, or append.',
      ],
      'missing-text': [
        'replace 或 append 必须提供字符串文本。',
        'replace and append require a text string.',
      ],
      'unexpected-text': ['hide 不能携带文本。', 'A hide override must not carry text.'],
      'invalid-order': [
        'order 必须是不小于 0 的整数（结果数组下标）。',
        'The order must be a non-negative integer (a target index).',
      ],
      'unexpected-order': [
        'replace 与 hide 不能携带 order。',
        'replace and hide must not carry an order.',
      ],
      'unknown-layer': ['layer 必须是 user 或 workspace。', 'The layer must be user or workspace.'],
      'workspace-unresolved': [
        '工作区层需要一个可解析的 session id。',
        'The workspace layer needs a resolvable session id.',
      ],
      'override-not-found': [
        '该层没有这条覆盖，无法撤销。',
        'That layer holds no such override to remove.',
      ],
      'layer-not-writable': [
        '目标配置文件不是合法配置，拒绝覆盖写入。',
        'The target config file is not a valid config; it is never overwritten.',
      ],
      'text-too-large': ['文本超过 200 KiB。', 'The text exceeds 200 KiB.'],
      'body-too-large': ['请求体超过 256 KiB。', 'The request body exceeds 256 KiB.'],
      'assemble-failed': [
        '宿主装配 system prompt 时抛错，快照不可用。',
        'The host assembly threw while building the snapshot.',
      ],
      'trust-fence-unavailable': [
        '连接服务不可用，请求被信任栅栏拒绝。',
        'The connection service is unavailable, so the trust fence refused the request.',
      ],
      'not-found': ['宿主没有这个路由。', 'The host has no such route.'],
      'duplicate-name': ['同一层出现重复段名。', 'The layer holds a duplicate section name.'],
    };
    // #endregion

    const zh = {
      nav: 'Prompt 管理',
      title: 'Prompt 管理',
      subtitle:
        '查看并覆盖每轮会话最终装配的 system prompt。写入作用于下一轮装配（next-turn）。',
      refresh: '刷新快照',
      loading: '加载中…',
      loadFailed: '快照加载失败',
      sessionHeading: '查看范围',
      sessionLabel: '会话',
      sessionGlobal: '全局（不指定会话）',
      sessionManual: '手动输入 session id',
      sessionManualPlaceholder: '粘贴 session id（Agent.id）',
      sessionApply: '应用',
      sessionLimit:
        '当前 profile 未提供 useSessions（会话服务不可用），已降级为手动输入 session id：无法列出会话下拉。',
      sessionEmpty: '会话列表为空，可手动输入 session id 或使用「全局」。',
      sessionGlobalNote: '未指定会话：快照描述全局装配，工作区层不参与。',
      sessionSelectedNote: '已指定会话：快照在该会话自身作用域下探测。',
      stateHeading: '状态',
      stMounted: '覆盖引擎',
      stMountedOn: '已挂载',
      stMountedOff: '未挂载',
      stMountedUnknown: '未知',
      stGeneratedAt: '快照生成时间',
      stUserLayer: '用户级层',
      stWorkspaceLayer: '工作区级层',
      stEnabled: '已启用',
      stDisabled: '未启用',
      stPath: '路径',
      stNone: '（无）',
      stReason: '原因',
      stFrozenSession: '本会话已冻结',
      stUnfrozenSession: '本会话未冻结',
      stFrozenGlobal: '全局装配已冻结',
      stUnfrozenGlobal: '全局装配未冻结',
      stFrozenUnknown: '本会话冻结状态未知',
      viewSections: '分段',
      viewFull: '全文',
      viewOverrides: '覆盖',
      filterHeading: '筛选',
      filterLayer: '来源层',
      filterOverridable: '可覆盖',
      filterOrigin: '来源',
      fAll: '全部',
      fDefault: '默认',
      fUser: '用户级',
      fWorkspace: '工作区级',
      fYes: '可覆盖',
      fNo: '不可覆盖',
      originRegistered: '注册段',
      originAppended: '本插件 append',
      originDownstream: '其它插件加入',
      originUnmatched: '无匹配覆盖',
      originDownstreamHint: '该段由其它插件在后处理阶段加入，不是本插件的覆盖，也不是异常。',
      originUnmatchedHint: '该覆盖没有可作用的目标段。',
      colName: '段名',
      colIndex: '序号',
      colChars: '字符数 {n}',
      colReason: '原因',
      colAction: '动作',
      colLayer: '层',
      expand: '展开全文',
      collapse: '收起',
      edit: '编辑',
      cancel: '取消',
      emptyTitle: '当前装配没有任何段',
      emptyBody: '该作用域下 system prompt 装配为 0 段，这不是错误。',
      sectionsShown: '显示 {shown} / {total} 段',
      searchPlaceholder: '在最终文本中检索…',
      searchCount: '命中 {n} 处',
      searchNone: '无命中',
      copy: '复制全文',
      copied: '已复制',
      copyFail: '复制失败，请手动选择文本',
      fullHeading: '最终 rendered system prompt',
      fullFiltered: '已按来源筛选：此处为重组后的预览文本，不是服务端 rendered。',
      unresolvedTitle: '部分变量缺少上下文',
      unresolvedBody: '未解析：{list}',
      unresolvedNote:
        '这些变量在当前视图下没有值，渲染文本保留了字面占位符，请勿据此判断真实 prompt。',
      truncated: '文本过长，仅显示前 {n} 行。',
      diffHeading: 'base ↔ effective 对比',
      diffSame: '一致',
      diffChanged: '有差异',
      diffAdded: '仅 effective',
      diffRemoved: '仅 base',
      diffHint: '逐段比较：base 是注册原文，effective 是覆盖后的结果。',
      editHeading: '编辑段',
      actionReplace: '替换 replace',
      actionHide: '隐藏 hide',
      actionAppend: '追加 append',
      editText: '文本',
      editLayer: '保存层',
      editOrder: '目标下标（仅 append）',
      editOrderHint:
        'append 的 order 是结果数组的目标下标，留空表示追加到末尾；replace / hide 不携带 order。',
      editOrderInvalid: 'order 必须是不小于 0 的整数，或留空。',
      editSave: '保存',
      editSaving: '保存中…',
      editDisabledOverridable: '该段不可覆盖',
      editDisabledFrozen: '当前作用域已冻结，编辑不会生效',
      editDisabledWorkspaceLayer: '工作区层未启用，无法保存到工作区级',
      editWarnUnknown:
        '所选会话的冻结状态未知：快照的 frozen 结论描述的是全局装配，该会话自己作用域内的 complete 段不可见。保存仍被允许，但可能不生效。',
      editWarnFrozenGlobal: '全局装配已冻结，所选会话的冻结状态未知；保存可能不生效。',
      savedNotice: '已保存到{layer}，下一轮生效（next-turn）。',
      deletedNotice: '已撤销{layer}的覆盖，下一轮生效（next-turn）。',
      nextTurn: '下一轮生效',
      ovHeading: '已生效覆盖',
      ovEmpty: '当前作用域没有任何覆盖。',
      ovUndo: '撤销',
      ovTextPreview: '文本预览',
      ovMergedNote: '合并顺序：工作区级覆盖同名用户级条目，并保留其位置。',
      errTitle: '请求失败',
      errNetwork: '无法连接宿主（网络错误）',
      errHttp: '宿主返回 HTTP {status}',
      errUnknown: '未知错误码',
      errCode: '错误码',
      errDetail: '宿主消息',
      retry: '重试',
      rendererLabel: '渲染分支',
      rendererPrimitives: 'primitives（官方基础件）',
      rendererFallback: 'fallback（自绘 + 主题变量）',
      primitivesFailure: 'primitives 不可用原因',
      renderErrorTitle: 'Prompt 管理：渲染失败',
      renderErrorLabel: '错误',
    };

    const en = {
      nav: 'Prompt settings',
      title: 'Prompt settings',
      subtitle:
        'Inspect and override the system prompt assembled into every session. A write applies to the next assembly (next-turn).',
      refresh: 'Refresh snapshot',
      loading: 'Loading…',
      loadFailed: 'Snapshot request failed',
      sessionHeading: 'Scope',
      sessionLabel: 'Session',
      sessionGlobal: 'Global (no session)',
      sessionManual: 'Enter a session id',
      sessionManualPlaceholder: 'Paste a session id (Agent.id)',
      sessionApply: 'Apply',
      sessionLimit:
        'This profile provides no useSessions (session service unavailable); the picker degraded to a manual session id and cannot list sessions.',
      sessionEmpty: 'The session list is empty; enter a session id or use Global.',
      sessionGlobalNote: 'No session: the snapshot describes the global assembly and the workspace layer stays inactive.',
      sessionSelectedNote: 'Session selected: the snapshot probes that session’s own scope.',
      stateHeading: 'Status',
      stMounted: 'Override engine',
      stMountedOn: 'Mounted',
      stMountedOff: 'Not mounted',
      stMountedUnknown: 'Unknown',
      stGeneratedAt: 'Snapshot generated at',
      stUserLayer: 'User layer',
      stWorkspaceLayer: 'Workspace layer',
      stEnabled: 'Enabled',
      stDisabled: 'Disabled',
      stPath: 'Path',
      stNone: '(none)',
      stReason: 'Reason',
      stFrozenSession: 'This session is frozen',
      stUnfrozenSession: 'This session is not frozen',
      stFrozenGlobal: 'The global assembly is frozen',
      stUnfrozenGlobal: 'The global assembly is not frozen',
      stFrozenUnknown: 'This session’s frozen state is unknown',
      viewSections: 'Sections',
      viewFull: 'Full text',
      viewOverrides: 'Overrides',
      filterHeading: 'Filters',
      filterLayer: 'Layer',
      filterOverridable: 'Overridable',
      filterOrigin: 'Origin',
      fAll: 'All',
      fDefault: 'Default',
      fUser: 'User',
      fWorkspace: 'Workspace',
      fYes: 'Overridable',
      fNo: 'Not overridable',
      originRegistered: 'Registered',
      originAppended: 'Our append',
      originDownstream: 'Added by another plugin',
      originUnmatched: 'Unmatched override',
      originDownstreamHint:
        'Another plugin added this section after the waterfall. It is not our override and not an anomaly.',
      originUnmatchedHint: 'This override had no target section to act on.',
      colName: 'Section',
      colIndex: 'Index',
      colChars: 'Chars {n}',
      colReason: 'Reason',
      colAction: 'Action',
      colLayer: 'Layer',
      expand: 'Expand',
      collapse: 'Collapse',
      edit: 'Edit',
      cancel: 'Cancel',
      emptyTitle: 'The assembly has no sections',
      emptyBody: 'This scope assembled 0 sections. That is not an error.',
      sectionsShown: 'Showing {shown} / {total} sections',
      searchPlaceholder: 'Search the final text…',
      searchCount: '{n} matches',
      searchNone: 'No match',
      copy: 'Copy text',
      copied: 'Copied',
      copyFail: 'Copy failed; select the text manually',
      fullHeading: 'Final rendered system prompt',
      fullFiltered: 'Filtered by origin: this is a recomposed preview, not the server-side rendered text.',
      unresolvedTitle: 'Some variables have no context',
      unresolvedBody: 'Unresolved: {list}',
      unresolvedNote:
        'These variables had no value in this view, so the text keeps their literal placeholders. Do not read it as the real prompt.',
      truncated: 'Long text: showing the first {n} lines only.',
      diffHeading: 'base ↔ effective',
      diffSame: 'Same',
      diffChanged: 'Changed',
      diffAdded: 'effective only',
      diffRemoved: 'base only',
      diffHint: 'Compared per section: base is what was registered, effective is the result after overrides.',
      editHeading: 'Edit section',
      actionReplace: 'Replace',
      actionHide: 'Hide',
      actionAppend: 'Append',
      editText: 'Text',
      editLayer: 'Save to layer',
      editOrder: 'Target index (append only)',
      editOrderHint:
        'append’s order is a target index in the resulting array; leave it blank to append at the end. replace / hide never carry an order.',
      editOrderInvalid: 'The order must be a non-negative integer, or blank.',
      editSave: 'Save',
      editSaving: 'Saving…',
      editDisabledOverridable: 'This section is not overridable',
      editDisabledFrozen: 'The current scope is frozen; an edit would not take effect',
      editDisabledWorkspaceLayer: 'The workspace layer is disabled, so it cannot be written',
      editWarnUnknown:
        'The selected session’s frozen state is unknown: the snapshot’s frozen verdict describes the global assembly, and a complete section registered in that session’s scope would not be visible. Saving stays allowed, but it may not take effect.',
      editWarnFrozenGlobal:
        'The global assembly is frozen and the selected session’s state is unknown; saving may not take effect.',
      savedNotice: 'Saved to {layer}; effective from the next turn (next-turn).',
      deletedNotice: 'Removed the {layer} override; effective from the next turn (next-turn).',
      nextTurn: 'next-turn',
      ovHeading: 'Active overrides',
      ovEmpty: 'This scope has no overrides.',
      ovUndo: 'Undo',
      ovTextPreview: 'Text preview',
      ovMergedNote: 'Merge order: a workspace override wins over the same-name user entry and keeps its position.',
      errTitle: 'Request failed',
      errNetwork: 'Cannot reach the Host (network error)',
      errHttp: 'The Host answered HTTP {status}',
      errUnknown: 'Unknown error code',
      errCode: 'Error code',
      errDetail: 'Host message',
      retry: 'Retry',
      rendererLabel: 'Renderer',
      rendererPrimitives: 'primitives (official atoms)',
      rendererFallback: 'fallback (hand-built + theme tokens)',
      primitivesFailure: 'Why primitives is unavailable',
      renderErrorTitle: 'Prompt settings — render failure',
      renderErrorLabel: 'Error',
    };

    // One loop keeps zh/en key sets identical by construction, including every
    // `error.CODE` entry.
    for (const [code, pair] of Object.entries(ERROR_TEXT)) {
      zh[`error.${code}`] = pair[0];
      en[`error.${code}`] = pair[1];
    }

    /**
     * Last-resort translator, replaced by the bound `t` in `apply`. Only used
     * if the framework hands the component no `t` seat.
     * @param key - dictionary key.
     * @returns the key itself.
     */
    let fallbackT = (key) => key;

    /** Theme tokens only: the page must read correctly in light and dark. */
    const token = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary)',
      borderL1: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))',
      borderL2: 'var(--dsw-alias-border-l2)',
      stateError: 'var(--dsw-alias-state-error-primary)',
      stateWarn: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-error-primary))',
      stateSuccess: 'var(--dsw-alias-state-success-primary)',
      surface: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, transparent))',
      surfaceStroke: 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, transparent))',
      buttonFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, transparent))',
      buttonLabel: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      markFill: 'var(--dsw-alias-state-warning-fill, rgba(255, 200, 0, 0.35))',
      diffAddFill: 'var(--dsw-alias-state-success-fill, rgba(0, 200, 100, 0.16))',
      diffDelFill: 'var(--dsw-alias-state-error-fill, rgba(220, 60, 60, 0.16))',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };

    // #region fallback atoms (pure React.createElement + theme tokens)
    /**
     * Hand-built button. Extra props (including `data-*` markers) pass through
     * so the machine-readable attributes survive on the real DOM node.
     * @param props - `variant`, `disabled`, `onClick`, `data-*`, `style`.
     * @returns the button element.
     */
    function FxButton(props) {
      const primary = props.variant === 'primary';
      const disabled = props.disabled === true;
      const rest = { ...props };
      delete rest.variant;
      delete rest.children;
      delete rest.style;
      return h(
        'button',
        {
          ...rest,
          type: 'button',
          disabled,
          style: {
            font: 'inherit',
            fontSize: 13,
            lineHeight: '20px',
            padding: '6px 14px',
            borderRadius: 8,
            cursor: disabled ? 'default' : 'pointer',
            color: primary ? token.buttonLabel : token.labelPrimary,
            background: primary ? token.buttonFill : 'transparent',
            border: primary ? '1px solid transparent' : `1px solid ${token.borderL2}`,
            opacity: disabled ? 0.5 : 1,
            ...(props.style || {}),
          },
        },
        props.children,
      );
    }

    /**
     * Hand-built text input (single line).
     * @param props - native input props plus `data-*`.
     * @returns the input element.
     */
    function FxInput(props) {
      const rest = { ...props };
      delete rest.style;
      return h('input', {
        ...rest,
        type: props.type || 'text',
        style: {
          font: 'inherit',
          fontSize: 13,
          lineHeight: '20px',
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 10px',
          borderRadius: 8,
          color: token.labelPrimary,
          background: 'transparent',
          border: `1px solid ${token.borderL2}`,
          ...(props.style || {}),
        },
      });
    }

    /**
     * Hand-built multi-line editor (no primitive exists for a textarea).
     * @param props - `value`, `onChange`, `rows`, plus `data-*`.
     * @returns the textarea element.
     */
    function FxTextarea(props) {
      const rest = { ...props };
      delete rest.style;
      return h('textarea', {
        ...rest,
        rows: props.rows || 10,
        style: {
          font: `${13}px/20px ${token.mono}`,
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 10px',
          borderRadius: 8,
          resize: 'vertical',
          color: token.labelPrimary,
          background: 'transparent',
          border: `1px solid ${token.borderL2}`,
          ...(props.style || {}),
        },
      });
    }

    /**
     * Hand-built native select (no primitive exists; a native control keeps the
     * keyboard and screen-reader semantics for free).
     * @param props - `value`, `onChange`, option children.
     * @returns the select element.
     */
    function FxSelect(props) {
      const rest = { ...props };
      delete rest.style;
      delete rest.children;
      return h(
        'select',
        {
          ...rest,
          style: {
            font: 'inherit',
            fontSize: 13,
            lineHeight: '20px',
            maxWidth: 420,
            padding: '6px 10px',
            borderRadius: 8,
            color: token.labelPrimary,
            background: 'transparent',
            border: `1px solid ${token.borderL2}`,
            ...(props.style || {}),
          },
        },
        props.children,
      );
    }

    /**
     * Hand-built tag.
     * @param props - `tone` plus children.
     * @returns the tag element.
     */
    function FxTag(props) {
      const tone = props.tone === undefined ? 'outline' : props.tone;
      const color =
        tone === 'success'
          ? token.stateSuccess
          : tone === 'danger'
            ? token.stateError
            : tone === 'warning'
              ? token.stateWarn
              : token.labelTertiary;
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            fontSize: 12,
            lineHeight: '18px',
            padding: '1px 8px',
            borderRadius: 999,
            border: `1px solid ${token.borderL2}`,
            color,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      );
    }
    // #endregion

    /**
     * Resolve the atoms once: `RENDERER` is fixed for this module instance, so
     * re-deciding per render would only remount children needlessly.
     */
    const UI =
      RENDERER === 'primitives'
        ? {
            Button: (props) =>
              h(
                primitives.Button,
                {
                  ...props,
                  variant: props.variant === 'primary' ? 'primary' : 'outline',
                  size: 'sm',
                  disabled: props.disabled,
                },
                props.children,
              ),
            Input: (props) =>
              typeof primitives.Input === 'function' ? h(primitives.Input, props) : h(FxInput, props),
            Textarea: FxTextarea,
            Select: FxSelect,
            Tag: (props) =>
              typeof primitives.Tag === 'function'
                ? h(primitives.Tag, { tone: props.tone }, props.children)
                : h(FxTag, props),
          }
        : {
            Button: FxButton,
            Input: FxInput,
            Textarea: FxTextarea,
            Select: FxSelect,
            Tag: FxTag,
          };

    /**
     * Render a segmented control.
     *
     * Deliberately *not* a component: it is called during tree building so the
     * fallback branch emits real host button nodes (role="tab") carrying the
     * `data-tab-*` markers the tests assert on. The primitives branch uses the
     * official `SegmentedTabs` (same `items`/`value`/`onChange` shape).
     * @param items - `{value, label, id, panelId}` entries, non-empty.
     * @param value - the selected value.
     * @param onChange - selection callback.
     * @param label - accessible name for the tab list.
     * @param group - marker key identifying which filter group this is.
     * @returns the tab list element.
     */
    function tabs(items, value, onChange, label, group) {
      if (RENDERER === 'primitives' && typeof primitives.SegmentedTabs === 'function') {
        return h(primitives.SegmentedTabs, { items, value, onChange, label });
      }
      return h(
        'div',
        {
          role: 'tablist',
          'aria-label': label,
          'data-tab-group': group,
          style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
        },
        items.map((item) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              role: 'tab',
              'aria-selected': item.value === value,
              tabIndex: item.value === value ? 0 : -1,
              'data-tab-key': group,
              'data-tab-value': item.value,
              onClick: () => onChange(item.value),
              style: {
                font: 'inherit',
                fontSize: 12,
                lineHeight: '18px',
                padding: '3px 10px',
                borderRadius: 999,
                cursor: 'pointer',
                color: item.value === value ? token.buttonLabel : token.labelSecondary,
                background: item.value === value ? token.buttonFill : 'transparent',
                border: `1px solid ${item.value === value ? 'transparent' : token.borderL2}`,
              },
            },
            item.label,
          ),
        ),
      );
    }

    /** Subscribe stub used only when the framework hands no locale seat. */
    const noopSubscribe = () => () => {};
    /** Snapshot stub used only when the framework hands no locale seat. */
    const zeroRevision = () => 0;

    /**
     * Translate without ever throwing. Used only by the render-failure card,
     * where `t` itself may be the thing that broke.
     * @param t - candidate translator.
     * @param key - dictionary key.
     * @param literal - text used when the translator is absent or breaks.
     * @returns the localized text, or the literal.
     */
    function safeT(t, key, literal) {
      try {
        const value = t(key);
        return typeof value === 'string' && value.length > 0 ? value : literal;
      } catch {
        return literal;
      }
    }

    // #region pure helpers

    /**
     * Interpolate `{name}` placeholders in already-localized copy.
     * @param text - the localized template.
     * @param params - placeholder values.
     * @returns the filled string.
     */
    function fmt(text, params) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined || params[key] === null ? match : String(params[key]),
      );
    }

    /** Separators used to encode the session hook's snapshot into one string. */
    const ROW_SEP = '\u001d';
    const FIELD_SEP = '\u001f';

    /**
     * The single selector handed to the props `useSessions` root hook.
     *
     * It returns a *string*, so the hook's equality check sees a stable value
     * across unrelated store notifications, and it never throws on a
     * not-yet-ready snapshot. Layout: `currentId` then one record per session,
     * each `id / title / cwd / running`.
     * @param state - `SessionListState` (or anything shaped like it).
     * @returns the encoded string.
     */
    function sessionsProbeSelector(state) {
      const ids = state && Array.isArray(state.ids) ? state.ids : [];
      const byId = state && state.byId && typeof state.byId === 'object' ? state.byId : {};
      let current = '';
      for (const id of ids) {
        const row = byId[id];
        // Product usage (dsh-client-ui-layout): the session the main view retains.
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) {
          current = id;
          break;
        }
      }
      const records = ids.map((id) => {
        const row = byId[id] || {};
        const title = row.displayTitle || row.title || '';
        return [id, title, row.cwd || '', row.running ? '1' : '0'].join(FIELD_SEP);
      });
      return [current, ...records].join(ROW_SEP);
    }

    /**
     * Decode {@link sessionsProbeSelector}'s output.
     * @param encoded - the selector value.
     * @returns `{currentId, rows: [{id, title, cwd, running}]}`.
     */
    function decodeSessions(encoded) {
      if (typeof encoded !== 'string' || encoded.length === 0) return { currentId: '', rows: [] };
      const parts = encoded.split(ROW_SEP);
      const currentId = parts[0] || '';
      const rows = parts
        .slice(1)
        .map((record) => {
          const fields = record.split(FIELD_SEP);
          return {
            id: fields[0] || '',
            title: fields[1] || '',
            cwd: fields[2] || '',
            running: fields[3] === '1',
          };
        })
        .filter((row) => row.id.length > 0);
      return { currentId, rows };
    }

    /**
     * Read the session seat off `props.useSessions` without ever throwing.
     *
     * `useSessions` is a root-level hook contributed by
     * `dsh-client-ui-session`; it needs no inject and no require. When the
     * contribution is absent (`typeof !== 'function'`) or a call throws, the
     * picker degrades to a manual session id and says so on the page.
     * @param useSessions - the hook from props, or anything else.
     * @returns `{mode, currentId, rows, degraded, reason}`.
     */
    function readSessionSeat(useSessions) {
      if (typeof useSessions !== 'function') {
        return { mode: 'manual', currentId: '', rows: [], degraded: true, reason: 'no-hook' };
      }
      try {
        const decoded = decodeSessions(useSessions(sessionsProbeSelector));
        return {
          mode: 'sessions',
          currentId: decoded.currentId,
          rows: decoded.rows,
          degraded: false,
          reason: decoded.rows.length === 0 ? 'empty' : null,
        };
      } catch (error) {
        return {
          mode: 'manual',
          currentId: '',
          rows: [],
          degraded: true,
          reason: 'hook-threw',
          message: error && error.message ? String(error.message) : String(error),
        };
      }
    }

    /** Effective layer of a section entry: 'default' | 'user' | 'workspace'. */
    function sectionLayer(section) {
      if (section && section.overrideLayer === 'user') return 'user';
      if (section && section.overrideLayer === 'workspace') return 'workspace';
      return 'default';
    }

    /** One of the four `origin` values, with a defensive fallback. */
    function originOf(section) {
      const origin = section ? section.origin : undefined;
      if (typeof origin === 'string' && ORIGINS.indexOf(origin) >= 0) return origin;
      return section && section.action === 'append' ? 'appended' : 'registered';
    }

    /** Localized label key for an origin value. */
    function originKey(origin) {
      if (origin === 'appended') return 'originAppended';
      if (origin === 'downstream-added') return 'originDownstream';
      if (origin === 'unmatched-override') return 'originUnmatched';
      return 'originRegistered';
    }

    /** Tag tone for an origin value; `downstream-added` is neutral, not a fault. */
    function originTone(origin) {
      if (origin === 'appended') return 'info';
      if (origin === 'unmatched-override') return 'warning';
      if (origin === 'downstream-added') return 'neutral';
      return 'outline';
    }

    /** Localized label key for one filter value (layer, overridable or origin). */
    function filterLabelKey(value) {
      if (value === 'user') return 'fUser';
      if (value === 'workspace') return 'fWorkspace';
      if (value === 'default') return 'fDefault';
      if (value === 'yes') return 'fYes';
      if (value === 'no') return 'fNo';
      if (value === 'all') return 'fAll';
      return originKey(value);
    }

    /** Localized label for a layer value. */
    function layerKey(layer) {
      if (layer === 'user') return 'fUser';
      if (layer === 'workspace') return 'fWorkspace';
      return 'fDefault';
    }

    /**
     * The three-state `frozenScope` presentation (CONTRACT.md §2.4, §7.2).
     *
     * - `frozenScope: "session"` → `frozen` describes the selected session;
     * - `frozenScope: "global"` **with** a selected session → the session's own
     *   state is *unknown*; this must never be presented as "not frozen";
     * - `frozenScope: "global"` without a session → it describes the global
     *   assembly.
     * @param snapshot - the snapshot payload, or null.
     * @param sessionSelected - whether the page is scoped to a session.
     * @returns `{kind, scope, certain, frozen, reason, pending}`.
     */
    function frozenState(snapshot, sessionSelected) {
      if (!snapshot || typeof snapshot !== 'object') {
        return { kind: 'unknown', scope: 'none', certain: false, frozen: false, reason: null, pending: true };
      }
      const frozen = snapshot.frozen === true;
      const reason = snapshot.frozenReason ? String(snapshot.frozenReason) : null;
      if (snapshot.frozenScope === 'session') {
        return { kind: frozen ? 'frozen' : 'unfrozen', scope: 'session', certain: true, frozen, reason, pending: false };
      }
      if (sessionSelected) {
        return {
          kind: 'unknown',
          scope: 'global',
          certain: false,
          frozen,
          reason: snapshot.frozenScopeReason ? String(snapshot.frozenScopeReason) : null,
          pending: false,
        };
      }
      return { kind: frozen ? 'frozen' : 'unfrozen', scope: 'global', certain: true, frozen, reason, pending: false };
    }

    /** Localized copy for a frozen verdict. */
    function frozenKey(fz) {
      if (fz.kind === 'unknown') return 'stFrozenUnknown';
      if (fz.scope === 'session') return fz.frozen ? 'stFrozenSession' : 'stUnfrozenSession';
      return fz.frozen ? 'stFrozenGlobal' : 'stUnfrozenGlobal';
    }

    /**
     * Whether the edit controls must be disabled for a section.
     *
     * A section that cannot be overridden is always disabled. A frozen verdict
     * disables editing only when it is certain for the scope being viewed; the
     * `frozenScope: "global"` + session case warns instead of silently
     * allowing (CONTRACT.md §2.4: treat it as unknown, not as unfrozen).
     * @param section - the effective section entry, or null.
     * @param fz - the frozen presentation.
     * @param t - the bound translator.
     * @returns `{disabled, reasons, warn}`.
     */
    function editGate(section, fz, t) {
      const reasons = [];
      if (section && section.overridable === false) {
        reasons.push(section.reason ? String(section.reason) : t('editDisabledOverridable'));
      }
      if (fz.certain && fz.frozen) reasons.push(t('editDisabledFrozen'));
      return { disabled: reasons.length > 0, reasons, warn: !fz.certain && !fz.pending };
    }

    /** Split a text into lines without dropping a trailing empty line. */
    function splitLines(text) {
      return String(text === null || text === undefined ? '' : text).split('\n');
    }

    /** Number of non-overlapping case-insensitive occurrences. */
    function countMatches(text, query) {
      if (typeof query !== 'string' || query.length === 0) return 0;
      const haystack = String(text).toLowerCase();
      const needle = query.toLowerCase();
      let from = 0;
      let total = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) return total;
        total += 1;
        from = at + needle.length;
      }
    }

    /**
     * Split text into plain strings and highlighted `mark` nodes.
     * @param text - the text to render.
     * @param query - the search needle ('' = no highlight).
     * @returns an array of React children.
     */
    function highlightNodes(text, query) {
      const source = String(text);
      const needle = typeof query === 'string' ? query : '';
      if (needle.length === 0) return [source];
      const haystack = source.toLowerCase();
      const lower = needle.toLowerCase();
      const out = [];
      let cursor = 0;
      let index = 0;
      for (;;) {
        const at = haystack.indexOf(lower, cursor);
        if (at === -1) break;
        if (at > cursor) out.push(source.slice(cursor, at));
        out.push(
          h(
            'mark',
            {
              key: `hit-${index}`,
              'data-search-hit': 'true',
              style: { background: token.markFill, color: 'inherit', borderRadius: 3 },
            },
            source.slice(at, at + needle.length),
          ),
        );
        cursor = at + needle.length;
        index += 1;
      }
      if (cursor < source.length) out.push(source.slice(cursor));
      return out;
    }

    /**
     * Line-level common prefix/suffix trim: the cheap, honest way to point at
     * what actually changed between two section texts without an O(n·m) LCS on
     * a 50 KiB prompt.
     * @param baseText - the registered text.
     * @param effectiveText - the resulting text.
     * @returns `{base, effective}` — only the differing middle blocks.
     */
    function chunkDiff(baseText, effectiveText) {
      const a = splitLines(baseText);
      const b = splitLines(effectiveText);
      let prefix = 0;
      while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      return {
        base: a.slice(prefix, a.length - suffix),
        effective: b.slice(prefix, b.length - suffix),
      };
    }

    /**
     * Compare `base.sections` with `effective.sections` by name.
     * @param baseSections - `base.sections`.
     * @param effectiveSections - `effective.sections`.
     * @returns rows of `{name, status, base, effective}`.
     */
    function diffSections(baseSections, effectiveSections) {
      const base = Array.isArray(baseSections) ? baseSections : [];
      const effective = Array.isArray(effectiveSections) ? effectiveSections : [];
      const effectiveByName = new Map();
      for (const section of effective) effectiveByName.set(section.name, section);
      const seen = new Set();
      const rows = [];
      for (const section of base) {
        seen.add(section.name);
        const after = effectiveByName.get(section.name);
        if (!after) {
          rows.push({ name: section.name, status: 'removed', base: section, effective: null });
          continue;
        }
        const changed =
          String(after.text) !== String(section.text) || after.index === null || after.applied === true;
        rows.push({
          name: section.name,
          status: changed ? 'changed' : 'same',
          base: section,
          effective: after,
        });
      }
      for (const section of effective) {
        if (seen.has(section.name)) continue;
        rows.push({ name: section.name, status: 'added', base: null, effective: section });
      }
      return rows;
    }

    /** Localized label key for a diff status. */
    function diffKey(status) {
      if (status === 'changed') return 'diffChanged';
      if (status === 'added') return 'diffAdded';
      if (status === 'removed') return 'diffRemoved';
      return 'diffSame';
    }

    /** Tag tone for a diff status. */
    function diffTone(status) {
      if (status === 'changed' || status === 'added') return 'warning';
      if (status === 'removed') return 'danger';
      return 'outline';
    }

    /**
     * Recompose the final text from a filtered section list, honoring render
     * order and dropping suppressed (`index: null`) entries.
     * @param sections - `effective.sections`.
     * @param originFilter - one of the four origins, or 'all'.
     * @returns the joined text.
     */
    function composeSections(sections, originFilter) {
      return (Array.isArray(sections) ? sections : [])
        .filter((section) => section && section.index !== null && section.index !== undefined)
        .filter((section) => originFilter === 'all' || originOf(section) === originFilter)
        .map((section) => (typeof section.text === 'string' ? section.text : ''))
        .filter((text) => text.length > 0)
        .join('\n\n');
    }

    /**
     * Turn a failed request into localized copy. Every documented `code` has a
     * dictionary entry; an unknown code still renders readable text plus the
     * raw code, never the code alone.
     * @param t - the bound translator.
     * @param error - `{code, message, status, network}`.
     * @returns the display string.
     */
    function errorText(t, error) {
      if (!error) return t('errUnknown');
      if (error.code) {
        const key = `error.${error.code}`;
        const text = safeT(t, key, '');
        if (text.length > 0) return text;
      }
      if (error.network) return t('errNetwork');
      if (error.status) return fmt(t('errHttp'), { status: error.status });
      return t('errUnknown');
    }

    /**
     * One request, never throwing. Success requires `ok: true`, matching the
     * contract's shape for all four routes.
     * @param path - request path (may include a query string).
     * @param init - optional fetch init.
     * @returns `{ok, status, payload}` or `{ok: false, status, error}`.
     */
    async function requestJson(path, init) {
      try {
        const response = await fetch(path, {
          headers: { accept: 'application/json', ...(init && init.headers ? init.headers : {}) },
          ...(init || {}),
        });
        let text = '';
        try {
          text = await response.text();
        } catch {
          text = '';
        }
        let payload = null;
        try {
          payload = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }
        if (response.ok && payload !== null && payload.ok === true) {
          return { ok: true, status: response.status, payload };
        }
        return {
          ok: false,
          status: response.status,
          error: {
            code: payload && typeof payload.code === 'string' ? payload.code : null,
            message:
              payload && typeof payload.message === 'string'
                ? payload.message
                : text.length > 0
                  ? text.slice(0, 300)
                  : '',
            status: response.status,
            network: false,
          },
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: {
            code: null,
            message: error && error.message ? String(error.message) : String(error),
            status: 0,
            network: true,
          },
        };
      }
    }

    /**
     * Copy text, preferring the probe's own clipboard helper.
     * @param text - the text to copy.
     * @returns whether the copy succeeded.
     */
    async function copyText(text) {
      try {
        if (primitives && typeof primitives.writeClipboard === 'function') {
          await primitives.writeClipboard(text);
          return true;
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    // #endregion

    // #region tree builders (host elements, so `data-*` markers survive)

    /** Shared card style. */
    const cardStyle = {
      border: `1px solid ${token.surfaceStroke}`,
      background: token.surface,
      borderRadius: 10,
      padding: '12px 14px',
    };
    /** Shared small meta text style. */
    const metaStyle = { fontSize: 12, color: token.labelTertiary };
    /** Shared heading style. */
    const headingStyle = { margin: 0, fontSize: 15, fontWeight: 600 };

    /**
     * Render one line of layer information.
     * @param t - the bound translator.
     * @param label - the localized layer name.
     * @param layer - `layers.user` / `layers.workspace`, or undefined.
     * @param key - `data-layer-status` marker value.
     * @returns the row element.
     */
    function layerLine(t, label, layer, key) {
      const enabled = layer ? layer.enabled === true : false;
      const reason = layer && layer.reason ? String(layer.reason) : '';
      return h(
        'div',
        {
          'data-layer-status': key,
          'data-enabled': String(enabled),
          style: { fontSize: 12, color: token.labelSecondary, display: 'flex', gap: 8, flexWrap: 'wrap' },
        },
        h('strong', { style: { fontWeight: 600 } }, label),
        h(UI.Tag, { tone: enabled ? 'success' : 'warning' }, enabled ? t('stEnabled') : t('stDisabled')),
        h(
          'span',
          { style: metaStyle },
          `${t('stPath')}: ${layer && layer.path ? String(layer.path) : t('stNone')}`,
        ),
        reason ? h('span', { style: { ...metaStyle, color: token.stateWarn } }, `${t('stReason')}: ${reason}`) : null,
      );
    }

    /**
     * Render an error banner for a failed request.
     * @param t - the bound translator.
     * @param error - the error descriptor.
     * @param title - the localized banner heading.
     * @returns the banner element.
     */
    function errorBanner(t, error, title) {
      return h(
        'div',
        {
          'data-error-code': error && error.code ? String(error.code) : '',
          'data-error-status': String(error && error.status ? error.status : 0),
          style: { ...cardStyle, borderColor: token.stateError },
        },
        h('strong', { style: { color: token.stateError, fontSize: 13 } }, title || t('errTitle')),
        h('div', { style: { marginTop: 4, fontSize: 13, color: token.labelPrimary } }, errorText(t, error)),
        error && error.code
          ? h('div', { style: { ...metaStyle, marginTop: 4 } }, `${t('errCode')}: ${error.code}`)
          : null,
        error && error.message
          ? h('div', { style: { ...metaStyle, marginTop: 2, wordBreak: 'break-word' } }, `${t('errDetail')}: ${error.message}`)
          : null,
      );
    }

    /**
     * Render the status bar (mounted / frozen three-state / layers / timestamp).
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the section element.
     */
    function renderStatus(t, m, a) {
      const snapshot = m.snap.data;
      const fz = m.fz;
      const mounted = snapshot ? snapshot.mounted === true : null;
      const mountedText =
        mounted === null ? t('stMountedUnknown') : mounted ? t('stMountedOn') : t('stMountedOff');
      const frozenText = t(frozenKey(fz));
      const layers = snapshot && snapshot.layers ? snapshot.layers : {};
      return h(
        'section',
        { 'data-region': 'status', style: cardStyle },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('h3', { style: headingStyle }, t('stateHeading')),
          h(UI.Button, { variant: 'outline', 'data-action': 'refresh', onClick: a.refresh }, t('refresh')),
        ),
        h(
          'div',
          { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'span',
            { style: metaStyle },
            `${t('stMounted')}:`,
          ),
          h(UI.Tag, { tone: mounted === true ? 'success' : mounted === false ? 'danger' : 'outline' }, mountedText),
          h(UI.Tag, { tone: fz.kind === 'unknown' ? 'warning' : fz.frozen ? 'danger' : 'success' }, frozenText),
          h(
            'span',
            { style: metaStyle },
            `${t('stGeneratedAt')}: ${snapshot && snapshot.generatedAt ? String(snapshot.generatedAt) : t('stNone')}`,
          ),
        ),
        // The unknown case is stated as unknown AND explained; it is never
        // rendered as "this session is not frozen".
        fz.kind === 'unknown' && !fz.pending
          ? h(
              'p',
              {
                'data-warning': 'frozen-unknown',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
              },
              `${t('stFrozenUnknown')}${fz.reason ? ` — ${t('stReason')}: ${fz.reason}` : ''}`,
            )
          : null,
        fz.kind === 'unknown' && fz.frozen
          ? h(
              'p',
              { 'data-warning': 'frozen-global', style: { margin: '4px 0 0', fontSize: 12, color: token.stateWarn } },
              t('stFrozenGlobal'),
            )
          : null,
        fz.certain && fz.frozen
          ? h(
              'p',
              {
                'data-warning': 'frozen',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateError, wordBreak: 'break-word' },
              },
              `${frozenText}${fz.reason ? ` — ${t('stReason')}: ${fz.reason}` : ''}`,
            )
          : null,
        mounted === false
          ? h(
              'p',
              { 'data-warning': 'not-mounted', style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn } },
              t('stMountedOff'),
            )
          : null,
        h(
          'div',
          { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 } },
          layerLine(t, t('stUserLayer'), layers.user, 'user'),
          layerLine(t, t('stWorkspaceLayer'), layers.workspace, 'workspace'),
        ),
      );
    }

    /**
     * Render the session selector (root `useSessions` seat, or the manual
     * degradation with its limitation spelled out).
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the section element.
     */
    function renderSession(t, m, a) {
      const seat = m.seat;
      const manual = seat.mode === 'manual';
      const options = [];
      if (!manual) {
        options.push(h('option', { key: '__global', value: GLOBAL_SESSION }, t('sessionGlobal')));
        for (const row of seat.rows) {
          const label = `${row.title || row.id}${row.running ? ' ●' : ''}${row.cwd ? ` — ${row.cwd}` : ''}`;
          options.push(h('option', { key: row.id, value: row.id }, label));
        }
      }
      return h(
        'section',
        { 'data-region': 'session', style: cardStyle },
        h('h3', { style: headingStyle }, t('sessionHeading')),
        manual
          ? h(
              'div',
              { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h(UI.Input, {
                'data-role': 'session-manual',
                placeholder: t('sessionManualPlaceholder'),
                value: m.manualId,
                onChange: a.setManualId,
                style: { maxWidth: 320 },
              }),
              h(UI.Button, { variant: 'outline', 'data-action': 'session-apply', onClick: a.applyManual }, t('sessionApply')),
              h(UI.Button, { variant: 'outline', 'data-action': 'session-global', onClick: a.useGlobal }, t('sessionGlobal')),
            )
          : h(
              'div',
              { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h(
                'label',
                { style: { ...metaStyle, display: 'flex', gap: 6, alignItems: 'center' } },
                t('sessionLabel'),
                h(
                  UI.Select,
                  { 'data-role': 'session-select', value: m.session, onChange: a.setSession },
                  options,
                ),
              ),
            ),
        manual
          ? h(
              'p',
              {
                'data-warning': 'session-degraded',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
              },
              t('sessionLimit'),
            )
          : null,
        manual && seat.reason === 'hook-threw'
          ? h('p', { style: { margin: '4px 0 0', ...metaStyle } }, t('errDetail') + `: ${seat.message}`)
          : null,
        !manual && seat.reason === 'empty'
          ? h('p', { style: { margin: '8px 0 0', ...metaStyle } }, t('sessionEmpty'))
          : null,
        h(
          'p',
          { 'data-session-note': m.sessionArg === null ? 'global' : 'session', style: { margin: '8px 0 0', ...metaStyle } },
          m.sessionArg === null ? t('sessionGlobalNote') : t('sessionSelectedNote'),
        ),
      );
    }

    /**
     * Filter tabs for the section view.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the filter block element.
     */
    function renderFilters(t, m, a) {
      const group = (key, heading, values, selected, onPick) =>
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: metaStyle }, heading),
          tabs(
            values.map((value) => ({
              value,
              label: t(filterLabelKey(value)),
              id: `ps-${key}-${value}`,
              panelId: 'ps-panel',
            })),
            selected,
            onPick,
            heading,
            key,
          ),
        );
      return h(
        'div',
        { 'data-region': 'filters', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('span', { style: { ...metaStyle, fontWeight: 600 } }, t('filterHeading')),
        group('layer', t('filterLayer'), LAYER_FILTERS, m.filters.layer, a.setLayerFilter),
        group('overridable', t('filterOverridable'), OVERRIDABLE_FILTERS, m.filters.overridable, a.setOverridableFilter),
        group('origin', t('filterOrigin'), ORIGIN_FILTERS, m.filters.origin, a.setOriginFilter),
      );
    }

    /**
     * One section row.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param section - the `effective.sections` entry.
     * @returns the row element.
     */
    function sectionRow(t, m, a, section) {
      const origin = originOf(section);
      const layer = sectionLayer(section);
      const overridable = section.overridable === true;
      const gate = editGate(section, m.fz, t);
      const text = typeof section.text === 'string' ? section.text : '';
      const expanded = m.expanded === section.name;
      const showHint = origin === 'downstream-added' || origin === 'unmatched-override';
      return h(
        'div',
        {
          'data-section-row': section.name,
          'data-section-name': section.name,
          'data-origin': origin,
          'data-layer': layer,
          'data-overridable': String(overridable),
          'data-applied': String(section.applied === true),
          'data-index': section.index === null || section.index === undefined ? '' : String(section.index),
          style: {
            border: `1px solid ${token.borderL1}`,
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('code', { style: { fontSize: 12, color: token.labelPrimary } }, section.name),
          h('span', { style: metaStyle }, `#${section.index === null || section.index === undefined ? '—' : section.index}`),
          h(UI.Tag, { tone: originTone(origin) }, t(originKey(origin))),
          h(UI.Tag, { tone: layer === 'default' ? 'neutral' : 'info' }, t(layerKey(layer))),
          h(UI.Tag, { tone: overridable ? 'success' : 'warning' }, overridable ? t('fYes') : t('fNo')),
          section.action ? h(UI.Tag, { tone: 'info' }, String(section.action)) : null,
          h('span', { style: metaStyle }, fmt(t('colChars'), { n: text.length })),
        ),
        section.reason
          ? h(
              'div',
              { 'data-section-reason': section.name, style: { fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' } },
              `${t('colReason')}: ${String(section.reason)}`,
            )
          : null,
        showHint
          ? h('div', { style: { fontSize: 12, color: token.labelTertiary } }, t(origin === 'downstream-added' ? 'originDownstreamHint' : 'originUnmatchedHint'))
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              'data-action': 'expand',
              'data-section-name': section.name,
              onClick: () => a.toggleExpanded(section.name),
              style: {
                font: 'inherit',
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 6,
                cursor: 'pointer',
                color: token.labelSecondary,
                background: 'transparent',
                border: `1px solid ${token.borderL2}`,
              },
            },
            expanded ? t('collapse') : t('expand'),
          ),
          h(
            'button',
            {
              type: 'button',
              'data-action': 'edit',
              'data-section-name': section.name,
              disabled: gate.disabled,
              title: gate.reasons.join(' '),
              onClick: () => a.openEditor(section),
              style: {
                font: 'inherit',
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 6,
                cursor: gate.disabled ? 'default' : 'pointer',
                opacity: gate.disabled ? 0.5 : 1,
                color: token.labelSecondary,
                background: 'transparent',
                border: `1px solid ${token.borderL2}`,
              },
            },
            t('edit'),
          ),
        ),
        expanded
          ? h(
              'pre',
              {
                'data-section-full': section.name,
                style: {
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: `1px solid ${token.borderL2}`,
                  fontSize: 12,
                  lineHeight: '18px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 320,
                  overflow: 'auto',
                  color: token.labelSecondary,
                  fontFamily: token.mono,
                },
              },
              text,
            )
          : null,
      );
    }

    /**
     * The edit panel for the selected section.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element, or null when nothing is selected.
     */
    function renderEditor(t, m, a) {
      const editor = m.editor;
      if (editor === null) return null;
      const workspace = m.snap.data && m.snap.data.layers ? m.snap.data.layers.workspace : null;
      const workspaceUsable = workspace && workspace.enabled === true;
      const gate = editGate(m.editorSection, m.fz, t);
      const warnings = [];
      if (gate.warn) {
        warnings.push(m.fz.frozen ? t('editWarnFrozenGlobal') : t('editWarnUnknown'));
      }
      return h(
        'section',
        { 'data-region': 'editor', 'data-editor-name': editor.name, style: cardStyle },
        h('h3', { style: headingStyle }, `${t('editHeading')}: ${editor.name}`),
        gate.reasons.length > 0
          ? h(
              'p',
              { 'data-warning': 'edit-disabled', style: { margin: '8px 0 0', fontSize: 12, color: token.stateError } },
              gate.reasons.join(' '),
            )
          : null,
        warnings.map((text, index) =>
          h(
            'p',
            {
              key: `warn-${index}`,
              'data-warning': 'edit-uncertain',
              style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
            },
            text,
          ),
        ),
        h(
          'div',
          { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: metaStyle }, t('colAction')),
            tabs(
              ACTIONS.map((value) => ({
                value,
                label: t(value === 'replace' ? 'actionReplace' : value === 'hide' ? 'actionHide' : 'actionAppend'),
                id: `ps-action-${value}`,
                panelId: 'ps-editor-panel',
              })),
              editor.action,
              a.setAction,
              t('editHeading'),
              'action',
            ),
          ),
          editor.action === 'hide'
            ? null
            : h(
                'label',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                h('span', { style: metaStyle }, t('editText')),
                h(UI.Textarea, {
                  'data-role': 'text',
                  value: editor.text,
                  onChange: a.setEditorText,
                  rows: 10,
                }),
              ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: metaStyle }, t('editLayer')),
            tabs(
              [
                { value: 'user', label: t('ovUser'), id: 'ps-layer-user', panelId: 'ps-editor-panel' },
                {
                  value: 'workspace',
                  label: workspaceUsable ? t('ovWorkspace') : `${t('ovWorkspace')}（${t('stDisabled')}）`,
                  id: 'ps-layer-workspace',
                  panelId: 'ps-editor-panel',
                },
              ],
              editor.layer,
              a.setLayer,
              t('editLayer'),
              'editor-layer',
            ),
          ),
          workspaceUsable
            ? null
            : h(
                'p',
                { 'data-warning': 'workspace-layer-disabled', style: { margin: 0, fontSize: 12, color: token.stateWarn } },
                `${t('editDisabledWorkspaceLayer')}${workspace && workspace.reason ? ` — ${String(workspace.reason)}` : ''}`,
              ),
          editor.action === 'append'
            ? h(
                'label',
                { style: { display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 } },
                h('span', { style: metaStyle }, t('editOrder')),
                h(UI.Input, {
                  'data-role': 'order',
                  value: editor.order,
                  onChange: a.setOrder,
                  placeholder: '0',
                }),
                h('span', { style: metaStyle }, t('editOrderHint')),
              )
            : h('span', { style: metaStyle }, t('editOrderHint')),
          editor.error
            ? h('p', { 'data-editor-error': 'true', style: { margin: 0, fontSize: 12, color: token.stateError } }, editor.error)
            : null,
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h(
              UI.Button,
              {
                variant: 'primary',
                'data-action': 'save',
                disabled: gate.disabled || m.busy === true,
                onClick: a.save,
              },
              m.busy ? t('editSaving') : t('editSave'),
            ),
            h(UI.Button, { variant: 'outline', 'data-action': 'cancel', onClick: a.closeEditor }, t('cancel')),
          ),
        ),
      );
    }

    /**
     * The section list view.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the view element.
     */
    function renderSectionsView(t, m, a) {
      const sections = m.effectiveSections;
      const shown = sections.filter((section) => m.passesFilters(section));
      return h(
        'div',
        { 'data-region': 'sections', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        renderFilters(t, m, a),
        h(
          'div',
          {
            'data-sections-total': String(sections.length),
            'data-sections-shown': String(shown.length),
            style: { ...metaStyle },
          },
          fmt(t('sectionsShown'), { shown: shown.length, total: sections.length }),
        ),
        sections.length === 0
          ? h(
              'div',
              { 'data-empty': 'sections', style: cardStyle },
              h('strong', { style: { fontSize: 13 } }, t('emptyTitle')),
              h('p', { style: { margin: '4px 0 0', ...metaStyle } }, t('emptyBody')),
            )
          : null,
        shown.map((section) => h('div', { key: section.name }, sectionRow(t, m, a, section))),
      );
    }

    /**
     * The full-text view: `rendered`, search highlight, unresolved warning,
     * and the `base` ↔ `effective` comparison.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the view element.
     */
    function renderFullView(t, m, a) {
      const snapshot = m.snap.data;
      const sections = m.effectiveSections;
      const baseSections = snapshot && snapshot.base && Array.isArray(snapshot.base.sections) ? snapshot.base.sections : [];
      const resolved = snapshot ? snapshot.renderedResolved !== false : true;
      const unresolved = snapshot && Array.isArray(snapshot.unresolvedVariables) ? snapshot.unresolvedVariables : [];
      const text =
        m.fullOrigin === 'all' ? String(snapshot && snapshot.rendered ? snapshot.rendered : '') : composeSections(sections, m.fullOrigin);
      const lines = splitLines(text);
      const truncated = lines.length > MAX_VIEW_LINES;
      const shownText = (truncated ? lines.slice(0, MAX_VIEW_LINES) : lines).join('\n');
      const hits = countMatches(shownText, m.search);
      const diffRows = diffSections(baseSections, sections);
      const changed = diffRows.filter((row) => row.status !== 'same').length;

      return h(
        'div',
        { 'data-region': 'full', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        resolved
          ? null
          : h(
              'div',
              {
                'data-warning': 'rendered-unresolved',
                'data-unresolved-variables': unresolved.map((name) => String(name)).join(','),
                style: { ...cardStyle, borderColor: token.stateWarn },
              },
              h('strong', { style: { fontSize: 13, color: token.stateWarn } }, t('unresolvedTitle')),
              h(
                'div',
                { style: { marginTop: 4, fontSize: 13, color: token.labelPrimary } },
                fmt(t('unresolvedBody'), { list: unresolved.map((name) => String(name)).join(', ') }),
              ),
              h('p', { style: { margin: '4px 0 0', ...metaStyle } }, t('unresolvedNote')),
            ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('h3', { style: headingStyle }, t('fullHeading')),
          h(UI.Button, { variant: 'outline', 'data-action': 'copy', onClick: a.copy }, t('copy')),
          h(UI.Input, {
            'data-role': 'search',
            placeholder: t('searchPlaceholder'),
            value: m.search,
            onChange: a.setSearch,
            style: { maxWidth: 280 },
          }),
          h('span', { 'data-search-count': String(hits), style: metaStyle }, hits > 0 ? fmt(t('searchCount'), { n: hits }) : t('searchNone')),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: metaStyle }, t('filterOrigin')),
          tabs(
            ORIGIN_FILTERS.map((value) => ({
              value,
              label: t(value === 'all' ? 'fAll' : originKey(value)),
              id: `ps-full-${value}`,
              panelId: 'ps-full-panel',
            })),
            m.fullOrigin,
            a.setFullOrigin,
            t('filterOrigin'),
            'full-origin',
          ),
        ),
        m.fullOrigin === 'all'
          ? null
          : h('p', { 'data-warning': 'full-filtered', style: { margin: 0, ...metaStyle } }, t('fullFiltered')),
        truncated
          ? h('p', { 'data-warning': 'truncated', style: { margin: 0, ...metaStyle } }, fmt(t('truncated'), { n: MAX_VIEW_LINES }))
          : null,
        h(
          'pre',
          {
            'data-full-text': m.fullOrigin === 'all' ? 'rendered' : 'filtered',
            'data-rendered-resolved': String(resolved),
            style: {
              margin: 0,
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${token.borderL2}`,
              fontSize: 12,
              lineHeight: '18px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 460,
              overflow: 'auto',
              color: token.labelSecondary,
              fontFamily: token.mono,
            },
          },
          highlightNodes(shownText, m.search),
        ),
        h('h3', { style: { ...headingStyle, marginTop: 4 } }, t('diffHeading')),
        h('p', { style: { margin: 0, ...metaStyle } }, t('diffHint')),
        h(
          'div',
          {
            'data-region': 'diff',
            'data-diff-changed': String(changed),
            'data-diff-total': String(diffRows.length),
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
          },
          diffRows.map((row) => {
            const pair = row.base && row.effective ? chunkDiff(row.base.text, row.effective.text) : null;
            return h(
              'div',
              {
                key: row.name,
                'data-diff-row': row.name,
                'data-diff-status': row.status,
                style: {
                  border: `1px solid ${row.status === 'same' ? token.borderL1 : token.stateWarn}`,
                  borderRadius: 8,
                  padding: '6px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('code', { style: { fontSize: 12 } }, row.name),
                h(UI.Tag, { tone: diffTone(row.status) }, t(diffKey(row.status))),
                h('span', { style: metaStyle }, fmt(t('colChars'), { n: row.effective ? String(row.effective.text || '').length : 0 })),
              ),
              row.status === 'changed' && pair
                ? h(
                    'pre',
                    {
                      'data-diff-detail': row.name,
                      style: {
                        margin: 0,
                        padding: '6px 8px',
                        borderRadius: 6,
                        fontSize: 12,
                        lineHeight: '18px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: 220,
                        overflow: 'auto',
                        fontFamily: token.mono,
                      },
                    },
                    pair.base.length > 0
                      ? h(
                          'span',
                          { 'data-diff-line': 'base', style: { background: token.diffDelFill, display: 'block' } },
                          pair.base.join('\n'),
                        )
                      : null,
                    pair.effective.length > 0
                      ? h(
                          'span',
                          { 'data-diff-line': 'effective', style: { background: token.diffAddFill, display: 'block' } },
                          pair.effective.join('\n'),
                        )
                      : null,
                  )
                : null,
            );
          }),
        ),
      );
    }

    /**
     * The override-management view.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the view element.
     */
    function renderOverridesView(t, m, a) {
      const ovs = m.ovs.data;
      const merged = ovs && ovs.merged && Array.isArray(ovs.merged.overrides) ? ovs.merged.overrides : [];
      return h(
        'div',
        { 'data-region': 'overrides', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('h3', { style: headingStyle }, t('ovHeading')),
        h('p', { style: { margin: 0, ...metaStyle } }, t('ovMergedNote')),
        h(
          'div',
          { 'data-overrides-total': String(merged.length), style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          merged.length === 0
            ? h('div', { 'data-empty': 'overrides', style: cardStyle }, t('ovEmpty'))
            : null,
          merged.map((entry) =>
            h(
              'div',
              {
                key: `${entry.layer}:${entry.name}`,
                'data-override-row': entry.name,
                'data-override-layer': entry.layer,
                'data-override-action': entry.action,
                style: {
                  border: `1px solid ${token.borderL1}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                },
              },
              h('code', { style: { fontSize: 12 } }, entry.name),
              h(UI.Tag, { tone: 'info' }, String(entry.action)),
              h(UI.Tag, { tone: 'neutral' }, t(entry.layer === 'workspace' ? 'ovWorkspace' : 'ovUser')),
              typeof entry.text === 'string' && entry.text.length > 0
                ? h('span', { style: { ...metaStyle, flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.text.slice(0, 120))
                : null,
              h(
                'button',
                {
                  type: 'button',
                  'data-action': 'undo',
                  'data-override-name': entry.name,
                  'data-override-layer': entry.layer === 'workspace' ? 'workspace' : 'user',
                  onClick: () => a.removeOverride(entry),
                  style: {
                    font: 'inherit',
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: token.stateError,
                    background: 'transparent',
                    border: `1px solid ${token.borderL2}`,
                  },
                },
                t('ovUndo'),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * Build the whole page tree. Kept separate so the hook order in the
     * component above stays fixed and the entire tree is produced inside one
     * `try`.
     * @param t - the bound translator for this namespace.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the page element.
     */
    function renderSection(t, m, a) {
      const children = [];
      children.push(
        h('h2', { key: 'title', style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } }, t('title')),
      );
      children.push(h('p', { key: 'subtitle', style: { margin: 0, fontSize: 13, color: token.labelTertiary } }, t('subtitle')));
      children.push(renderSession(t, m, a));
      children.push(renderStatus(t, m, a));
      children.push(
        h(
          'div',
          { key: 'views', 'data-region': 'view-tabs' },
          tabs(
            VIEWS.map((value) => ({
              value,
              label: t(value === 'sections' ? 'viewSections' : value === 'full' ? 'viewFull' : 'viewOverrides'),
              id: `ps-view-${value}`,
              panelId: 'ps-view-panel',
            })),
            m.view,
            a.setView,
            t('title'),
            'view',
          ),
        ),
      );
      const editorPanel = renderEditor(t, m, a);
      if (editorPanel !== null) children.push(h('div', { key: 'editor-slot', style: { display: 'contents' } }, editorPanel));
      if (m.snap.phase === 'error') children.push(h('div', { key: 'snap-error' }, errorBanner(t, m.snap.error, t('loadFailed'))));
      if (m.ovs.phase === 'error') children.push(h('div', { key: 'ovs-error' }, errorBanner(t, m.ovs.error, t('loadFailed'))));
      if (m.notice) {
        children.push(
          h(
            'div',
            {
              key: 'notice',
              'data-notice': m.notice.tone,
              style: {
                ...cardStyle,
                borderColor: m.notice.tone === 'error' ? token.stateError : token.stateSuccess,
                fontSize: 13,
                color: m.notice.tone === 'error' ? token.stateError : token.stateSuccess,
              },
            },
            m.notice.text,
          ),
        );
      }
      children.push(
        h('div', { key: 'panel', 'data-region': 'panel' },
          m.snap.phase === 'loading' && !m.snap.data ? h('p', { key: 'loading', style: metaStyle }, t('loading')) : null,
          m.snap.data
            ? m.view === 'sections'
              ? renderSectionsView(t, m, a)
              : m.view === 'full'
                ? renderFullView(t, m, a)
                : renderOverridesView(t, m, a)
            : null,
        ),
      );
      children.push(
        h(
          'div',
          { key: 'renderer', style: { fontSize: 12, color: token.labelTertiary } },
          `${t('rendererLabel')}: ${t(RENDERER === 'primitives' ? 'rendererPrimitives' : 'rendererFallback')}`,
        ),
      );
      if (RENDERER === 'fallback' && primitivesFailure) {
        children.push(
          h(
            'div',
            { key: 'primitives-failure', style: { fontSize: 12, color: token.labelTertiary, wordBreak: 'break-word' } },
            `${t('primitivesFailure')}: ${primitivesFailure}`,
          ),
        );
      }
      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          'data-renderer': RENDERER,
          'data-render-state': 'ok',
          'data-phase': m.phase,
          'data-session-mode': m.seat.mode,
          'data-session': m.sessionArg === null ? 'global' : m.sessionArg,
          'data-frozen-scope': m.fz.scope,
          'data-frozen-state': m.fz.kind,
          'data-mounted': m.snap.data ? String(m.snap.data.mounted === true) : 'unknown',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            maxWidth: 860,
            color: token.labelPrimary,
          },
        },
        children,
      );
    }

    // #endregion

    /**
     * The settings section page.
     *
     * Hooks run before the `try`: their call order must be identical on every
     * render, including the render that catches. The returned tree is built
     * inside the `try` so that no failure below can escape into React's
     * reconciler and blank the panel — a readable failure card is always
     * preferable to a white screen.
     * @param props - owner props (`close`, `useSessions`, …) merged with the
     *   `locale` seat (`t`) and this entry's inject face (`subscribeLocale`,
     *   `getLocaleRevision`).
     * @returns the rendered page; never throws.
     */
    function PromptSettingSection(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const subscribe = typeof props.subscribeLocale === 'function' ? props.subscribeLocale : noopSubscribe;
      const revision =
        typeof props.getLocaleRevision === 'function' ? props.getLocaleRevision : zeroRevision;
      // Re-render this page on its own when the DSH language changes, instead
      // of relying on the shell to re-render us. Both seats are already
      // exception-free by construction (see `apply`), so this hook cannot be
      // the call that throws.
      React.useSyncExternalStore(subscribe, revision, revision);

      // The session seat: a root-level hook on props, no inject required. The
      // `typeof` branch is stable for the life of a mount, and a hook that
      // throws degrades to the manual picker instead of blanking the panel.
      const seat = readSessionSeat(props.useSessions);

      const [selection, setSelection] = React.useState(null);
      const [manualId, setManualId] = React.useState('');
      const [view, setView] = React.useState('sections');
      const [search, setSearch] = React.useState('');
      const [filters, setFilters] = React.useState({ layer: 'all', overridable: 'all', origin: 'all' });
      const [fullOrigin, setFullOrigin] = React.useState('all');
      const [expanded, setExpanded] = React.useState('');
      const [snap, setSnap] = React.useState({ phase: 'loading', data: null, error: null });
      const [ovs, setOvs] = React.useState({ phase: 'loading', data: null, error: null });
      const [reload, setReload] = React.useState(0);
      const [editor, setEditor] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const session = selection === null ? seat.currentId || GLOBAL_SESSION : selection;
      const sessionArg = session === GLOBAL_SESSION ? null : session;

      React.useEffect(() => {
        let cancelled = false;
        setSnap({ phase: 'loading', data: null, error: null });
        setOvs({ phase: 'loading', data: null, error: null });
        const query = sessionArg === null ? '' : `?session=${encodeURIComponent(sessionArg)}`;
        // Stage 1A side channel: one fire-and-forget ping tells the Host which
        // renderer branch this browser actually got (index.js `clientRenderer`).
        void requestJson(`${PING_PATH}?renderer=${RENDERER}`);
        const load = async () => {
          const snapshot = await requestJson(`${SNAPSHOT_PATH}${query}`);
          if (cancelled) return;
          setSnap(
            snapshot.ok
              ? { phase: 'ready', data: snapshot.payload, error: null }
              : { phase: 'error', data: null, error: snapshot.error },
          );
          const overrides = await requestJson(`${OVERRIDES_PATH}${query}`);
          if (cancelled) return;
          setOvs(
            overrides.ok
              ? { phase: 'ready', data: overrides.payload, error: null }
              : { phase: 'error', data: null, error: overrides.error },
          );
        };
        void load();
        return () => {
          cancelled = true;
        };
      }, [sessionArg, reload]);

      const snapshot = snap.data;
      const fz = frozenState(snapshot, sessionArg !== null);
      const effectiveSections =
        snapshot && snapshot.effective && Array.isArray(snapshot.effective.sections)
          ? snapshot.effective.sections
          : [];
      const phase = snap.phase === 'ready' && effectiveSections.length === 0 ? 'empty' : snap.phase;

      const actions = {
        refresh: () => setReload((value) => value + 1),
        setView,
        setSearch: (event) => setSearch(event && event.target ? String(event.target.value) : ''),
        setManualId: (event) => setManualId(event && event.target ? String(event.target.value) : ''),
        setSession: (event) => setSelection(event && event.target ? String(event.target.value) : GLOBAL_SESSION),
        applyManual: () => setSelection(manualId.trim().length > 0 ? manualId.trim() : GLOBAL_SESSION),
        useGlobal: () => setSelection(GLOBAL_SESSION),
        setLayerFilter: (value) => setFilters((current) => ({ ...current, layer: value })),
        setOverridableFilter: (value) => setFilters((current) => ({ ...current, overridable: value })),
        setOriginFilter: (value) => setFilters((current) => ({ ...current, origin: value })),
        setFullOrigin,
        toggleExpanded: (name) => setExpanded((current) => (current === name ? '' : name)),
        setAction: (value) => setEditor((current) => (current === null ? current : { ...current, action: value, error: null })),
        setLayer: (value) => setEditor((current) => (current === null ? current : { ...current, layer: value, error: null })),
        setOrder: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          setEditor((current) => (current === null ? current : { ...current, order: value, error: null }));
        },
        setEditorText: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          setEditor((current) => (current === null ? current : { ...current, text: value, error: null }));
        },
        openEditor: (section) => {
          const gate = editGate(section, fz, t);
          if (gate.disabled) {
            setNotice({ tone: 'error', text: gate.reasons.join(' ') });
            return;
          }
          setEditor({
            name: section.name,
            action: section.action && ACTIONS.indexOf(section.action) >= 0 ? section.action : 'replace',
            text: typeof section.text === 'string' ? section.text : '',
            layer: section.overrideLayer === 'workspace' ? 'workspace' : 'user',
            order: '',
            error: null,
          });
        },
        closeEditor: () => setEditor(null),
        copy: async () => {
          const text =
            fullOrigin === 'all' ? String(snapshot && snapshot.rendered ? snapshot.rendered : '') : composeSections(effectiveSections, fullOrigin);
          const copied = await copyText(text);
          setNotice({ tone: copied ? 'success' : 'error', text: copied ? t('copied') : t('copyFail') });
        },
        save: async () => {
          if (editor === null) return;
          const current = effectiveSections.find((section) => section.name === editor.name) || null;
          const gate = editGate(current, fz, t);
          if (gate.disabled) {
            setNotice({ tone: 'error', text: gate.reasons.join(' ') });
            return;
          }
          const sectionOverride = { name: editor.name, action: editor.action };
          if (editor.action !== 'hide') {
            sectionOverride.text = editor.text;
            if (editor.action === 'append' && String(editor.order).trim().length > 0) {
              const order = Number(String(editor.order).trim());
              if (!Number.isInteger(order) || order < 0) {
                setEditor((value) => (value === null ? value : { ...value, error: t('editOrderInvalid') }));
                return;
              }
              // CONTRACT §4.1: `order` is a target index in the resulting array
              // and is legal for `append` only.
              sectionOverride.order = order;
            }
          }
          if (editor.layer === 'workspace' && sessionArg === null) {
            setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
            return;
          }
          const body = { layer: editor.layer, section: sectionOverride };
          if (sessionArg !== null) body.session = sessionArg;
          setBusy(true);
          const result = await requestJson(OVERRIDES_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          setBusy(false);
          if (!result.ok) {
            setNotice({ tone: 'error', text: errorText(t, result.error) });
            return;
          }
          setEditor(null);
          setNotice({
            tone: 'success',
            text: fmt(t('savedNotice'), { layer: t(editor.layer === 'workspace' ? 'ovWorkspace' : 'ovUser') }),
          });
          setReload((value) => value + 1);
        },
        removeOverride: async (entry) => {
          const layer = entry.layer === 'workspace' ? 'workspace' : 'user';
          if (layer === 'workspace' && sessionArg === null) {
            setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
            return;
          }
          let path = `${OVERRIDES_PATH}?layer=${encodeURIComponent(layer)}&name=${encodeURIComponent(entry.name)}`;
          if (sessionArg !== null) path += `&session=${encodeURIComponent(sessionArg)}`;
          setBusy(true);
          const result = await requestJson(path, { method: 'DELETE' });
          setBusy(false);
          if (!result.ok) {
            setNotice({ tone: 'error', text: errorText(t, result.error) });
            return;
          }
          setNotice({
            tone: 'success',
            text: fmt(t('deletedNotice'), { layer: t(layer === 'workspace' ? 'ovWorkspace' : 'ovUser') }),
          });
          setReload((value) => value + 1);
        },
      };

      const model = {
        seat,
        session,
        sessionArg,
        manualId,
        view,
        search,
        filters,
        fullOrigin,
        expanded,
        snap,
        ovs,
        editor,
        editorSection: editor === null ? null : effectiveSections.find((section) => section.name === editor.name) || null,
        notice,
        busy,
        fz,
        effectiveSections,
        phase,
        passesFilters: (section) => {
          if (filters.layer !== 'all' && sectionLayer(section) !== filters.layer) return false;
          if (filters.overridable === 'yes' && section.overridable !== true) return false;
          if (filters.overridable === 'no' && section.overridable !== false) return false;
          if (filters.origin !== 'all' && originOf(section) !== filters.origin) return false;
          return true;
        },
      };

      try {
        return renderSection(t, model, actions);
      } catch (error) {
        return renderFailureCard(t, error);
      }
    }

    /**
     * Last-resort card, rendered when building the page tree itself throws.
     * It carries the same `data-plugin` / `data-renderer` / `data-render-state`
     * markers as the real page so a broken render is still machine-visible, and
     * it shows the error text so the settings panel is never blank.
     * @param t - candidate translator; may itself be what broke.
     * @param error - the thrown value.
     * @returns the failure card element.
     */
    function renderFailureCard(t, error) {
      const message = error && error.message ? String(error.message) : String(error);
      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          'data-renderer': RENDERER,
          'data-render-state': 'error',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxWidth: 860,
            color: token.labelPrimary,
          },
        },
        h(
          'h2',
          { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } },
          safeT(t, 'renderErrorTitle', 'Prompt settings — render failure'),
        ),
        h(
          'p',
          { style: { margin: 0, fontSize: 13, color: token.stateError, wordBreak: 'break-word' } },
          `${safeT(t, 'renderErrorLabel', 'Error')}: ${message}`,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Every locale call is guarded. `ctx.locale.subscribe` and
        // `getSnapshot().revision` are the one unproven part of the 0.1.7-rc.2
        // client contract (NOTES.md §7), and a throw from either would happen
        // *during render* — React would then unmount the whole settings
        // subtree and the panel would go blank. Losing live language switching
        // is an acceptable degradation; a white screen is not.
        const locale = ctx.locale;
        const t = typeof locale?.bind === 'function' ? locale.bind(NS) : (key) => key;
        fallbackT = t;
        ctx.effect(
          () =>
            typeof locale?.register === 'function' ? locale.register(NS, { zh, en }) : undefined,
          'prompt-setting: section dictionaries',
        );

        const canSubscribe = typeof locale?.subscribe === 'function';
        const canReadRevision = typeof locale?.getSnapshot === 'function';

        // Built once so `React.useSyncExternalStore` sees stable identities.
        const face = {
          subscribeLocale: (listener) => {
            if (!canSubscribe) return noopSubscribe();
            try {
              const unsubscribe = locale.subscribe(listener);
              return typeof unsubscribe === 'function' ? unsubscribe : noopSubscribe();
            } catch {
              return noopSubscribe();
            }
          },
          getLocaleRevision: () => {
            if (!canReadRevision) return zeroRevision();
            try {
              return locale.getSnapshot()?.revision ?? zeroRevision();
            } catch {
              return zeroRevision();
            }
          },
        };

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'prompt-setting',
              // Existing orders: account -10, general 0, models 10, plugins 15,
              // agent-presets 20 — 30 appends without touching any of them.
              order: 30,
              label: () => t('nav'),
              locale: NS,
              inject: () => face,
            },
            PromptSettingSection,
          ),
        );
      },
    };
  },
});
