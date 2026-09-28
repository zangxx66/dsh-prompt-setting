/**
 * `dsh-prompt-setting` — Client half (stage 1A: settings section placeholder).
 *
 * Hand-written CommonJS factory registered into the browser module loader:
 * no bundler, no JSX, no TypeScript. `react` and the other baseline modules
 * come from the loader's seed table through `require`.
 *
 * Stage 1A scope: one independent section in 「设置 / Settings」 that renders a
 * placeholder page and reports the result of the Host probe
 * `GET /prompt-setting/ping`.
 *
 * Two renderers coexist on purpose — see NOTES.md §4:
 *   - `primitives`: used when `@deepseek-ai/dsh-client-ui-primitives` can be
 *     required. The skill `cordis-plugin-development` forbids an external
 *     bundle from depending on it, while the browser seed table still makes
 *     the module resolvable, so the conflict is resolved by *probing* rather
 *     than assuming.
 *   - `fallback`: hand-built `React.createElement` atoms styled only with
 *     `--dsw-alias-*` theme tokens.
 * The branch actually taken is rendered on the page (`data-renderer`) so a
 * human can settle the question on the real machine without a rebuild.
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
    /** Host probe route, kept in lockstep with index.js `PING_PATH`. */
    const PING_PATH = '/prompt-setting/ping';

    const zh = {
      nav: 'Prompt 管理',
      title: 'Prompt 管理（阶段一 A 占位）',
      intro:
        '此页用于查看与覆盖最终装配进每轮会话的 system prompt。当前仅为骨架阶段：宿主侧只暴露一个只读探针路由，装配与覆盖引擎尚未接入。',
      probeHeading: '探针状态',
      probePath: '探针路由',
      probeLoading: '正在探测…',
      probeOk: '探针可用',
      probeFail: '探针失败',
      probeRetry: '重新探测',
      probeRaw: '原始响应',
      rendererLabel: '渲染分支',
      rendererPrimitives: 'primitives（官方基础件）',
      rendererFallback: 'fallback（自绘 + 主题变量）',
      primitivesFailure: 'primitives 不可用原因',
      placeholderSearch: '分段检索（阶段一 C 实现）',
      stageNote: '本页为阶段一 A 的占位实现；后续阶段将替换为分段浏览、检索与就地编辑。',
      renderErrorTitle: 'Prompt 管理：渲染失败',
      renderErrorLabel: '错误',
    };

    const en = {
      nav: 'Prompt settings',
      title: 'Prompt settings (stage 1A placeholder)',
      intro:
        'This page will show and override the system prompt assembled into every session. It is a skeleton today: the Host half exposes one read-only probe route, and the assembly/override engine is not wired yet.',
      probeHeading: 'Probe status',
      probePath: 'Probe route',
      probeLoading: 'Probing…',
      probeOk: 'Probe reachable',
      probeFail: 'Probe failed',
      probeRetry: 'Probe again',
      probeRaw: 'Raw response',
      rendererLabel: 'Renderer',
      rendererPrimitives: 'primitives (official atoms)',
      rendererFallback: 'fallback (hand-built + theme tokens)',
      primitivesFailure: 'Why primitives is unavailable',
      placeholderSearch: 'Section search (stage 1C)',
      stageNote:
        'Placeholder for stage 1A; later stages replace it with section browsing, search, and in-place editing.',
      renderErrorTitle: 'Prompt settings — render failure',
      renderErrorLabel: 'Error',
    };

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
      borderL2: 'var(--dsw-alias-border-l2)',
      stateError: 'var(--dsw-alias-state-error-primary)',
      stateSuccess: 'var(--dsw-alias-state-success-primary)',
      surface: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, transparent))',
      surfaceStroke: 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, transparent))',
      buttonFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, transparent))',
      buttonLabel: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
    };

    // #region fallback atoms (pure React.createElement + theme tokens)
    function FxButton(props) {
      const primary = props.variant === 'primary';
      const disabled = props.disabled === true;
      return h(
        'button',
        {
          type: 'button',
          disabled,
          onClick: props.onClick,
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
          },
        },
        props.children,
      );
    }

    function FxInput(props) {
      return h('input', {
        type: 'text',
        placeholder: props.placeholder,
        readOnly: true,
        disabled: props.disabled === true,
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
        },
      });
    }

    function FxTag(props) {
      const tone = props.tone === undefined ? 'outline' : props.tone;
      const color =
        tone === 'success'
          ? token.stateSuccess
          : tone === 'danger'
            ? token.stateError
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
                  variant: props.variant === 'primary' ? 'primary' : 'outline',
                  size: 'sm',
                  disabled: props.disabled,
                  onClick: props.onClick,
                },
                props.children,
              ),
            Input: (props) =>
              typeof primitives.Input === 'function'
                ? h(primitives.Input, {
                    placeholder: props.placeholder,
                    readOnly: true,
                    disabled: props.disabled,
                  })
                : h(FxInput, props),
            Tag: (props) =>
              typeof primitives.Tag === 'function'
                ? h(primitives.Tag, { tone: props.tone }, props.children)
                : h(FxTag, props),
          }
        : { Button: FxButton, Input: FxInput, Tag: FxTag };

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

    /**
     * The settings section page.
     *
     * Hooks run before the `try`: their call order must be identical on every
     * render, including the render that catches. The returned tree is built
     * inside the `try` so that no failure below can escape into React's
     * reconciler and blank the panel — a readable failure card is always
     * preferable to a white screen.
     * @param props - owner props (`close`) merged with the `locale` seat (`t`)
     *   and this entry's inject face (`subscribeLocale`, `getLocaleRevision`).
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

      const [probe, setProbe] = React.useState({ phase: 'loading', payload: null, message: '' });
      const [attempt, setAttempt] = React.useState(0);

      React.useEffect(() => {
        let cancelled = false;
        setProbe({ phase: 'loading', payload: null, message: '' });
        const run = async () => {
          try {
            // One request both probes and reports: the query parameter is how
            // a single host-side curl settles which renderer this browser
            // actually got (NOTES.md §4).
            const response = await fetch(`${PING_PATH}?renderer=${RENDERER}`, {
              headers: { accept: 'application/json' },
            });
            const text = await response.text();
            let payload = null;
            try {
              payload = JSON.parse(text);
            } catch {
              payload = null;
            }
            if (cancelled) return;
            if (response.ok && payload !== null) {
              setProbe({ phase: 'ok', payload, message: '' });
              return;
            }
            const detail =
              payload !== null
                ? JSON.stringify(payload)
                : text
                  ? text.slice(0, 300)
                  : '';
            setProbe({
              phase: 'error',
              payload: null,
              message: `HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
            });
          } catch (error) {
            if (cancelled) return;
            setProbe({
              phase: 'error',
              payload: null,
              message: error && error.message ? String(error.message) : String(error),
            });
          }
        };
        void run();
        return () => {
          cancelled = true;
        };
      }, [attempt]);

      try {
        return renderSection(t, probe, setAttempt);
      } catch (error) {
        return renderFailureCard(t, error);
      }
    }

    /**
     * Build the page tree. Kept separate so the hook order above stays fixed
     * and the entire tree is produced inside one `try`.
     * @param t - the bound translator for this namespace.
     * @param probe - the probe state cell.
     * @param setAttempt - the retry trigger.
     * @returns the page element.
     */
    function renderSection(t, probe, setAttempt) {
      const probeTone = probe.phase === 'ok' ? 'success' : probe.phase === 'error' ? 'danger' : 'outline';
      const probeText =
        probe.phase === 'ok'
          ? t('probeOk')
          : probe.phase === 'error'
            ? t('probeFail')
            : t('probeLoading');

      const card = {
        border: `1px solid ${token.surfaceStroke}`,
        background: token.surface,
        borderRadius: 10,
        padding: '12px 14px',
      };

      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          'data-render-state': 'ok',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            maxWidth: 760,
            color: token.labelPrimary,
          },
        },
        h(
          'h2',
          { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } },
          t('title'),
        ),
        h('p', { style: { margin: 0, fontSize: 13, color: token.labelTertiary } }, t('intro')),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(UI.Tag, { tone: 'neutral' }, 'dsh-prompt-setting'),
          h(UI.Tag, { tone: 'outline' }, 'v0.1.0'),
          h(UI.Input, { placeholder: t('placeholderSearch'), disabled: true }),
        ),
        h(
          'section',
          { style: card },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              },
            },
            h('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, t('probeHeading')),
            h(
              UI.Button,
              { variant: 'outline', onClick: () => setAttempt((value) => value + 1) },
              t('probeRetry'),
            ),
          ),
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(UI.Tag, { tone: probeTone }, probeText),
            h(
              'code',
              { style: { fontSize: 12, color: token.labelSecondary } },
              `${t('probePath')}: GET ${PING_PATH}`,
            ),
          ),
          probe.phase === 'error'
            ? h(
                'p',
                { style: { margin: '8px 0 0', fontSize: 13, color: token.stateError } },
                probe.message,
              )
            : null,
          probe.phase === 'ok' && probe.payload !== null
            ? h(
                'div',
                { style: { marginTop: 8 } },
                h(
                  'div',
                  { style: { fontSize: 12, color: token.labelTertiary, marginBottom: 4 } },
                  t('probeRaw'),
                ),
                h(
                  'pre',
                  {
                    style: {
                      margin: 0,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: `1px solid ${token.borderL2}`,
                      fontSize: 12,
                      lineHeight: '18px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      color: token.labelSecondary,
                    },
                  },
                  JSON.stringify(probe.payload, null, 2),
                ),
              )
            : null,
        ),
        h(
          'div',
          { style: { fontSize: 12, color: token.labelTertiary } },
          `${t('rendererLabel')}: ${t(RENDERER === 'primitives' ? 'rendererPrimitives' : 'rendererFallback')}`,
        ),
        RENDERER === 'fallback' && primitivesFailure
          ? h(
              'div',
              { style: { fontSize: 12, color: token.labelTertiary, wordBreak: 'break-word' } },
              `${t('primitivesFailure')}: ${primitivesFailure}`,
            )
          : null,
        h('p', { style: { margin: 0, fontSize: 12, color: token.labelTertiary } }, t('stageNote')),
        // Machine-readable branch marker: the deliverable is judged by reading
        // this attribute off the live DOM (NOTES.md §4).
        h('div', { 'data-renderer': RENDERER, style: { display: 'none' } }, `renderer: ${RENDERER}`),
      );
    }

    /**
     * Last-resort card, rendered when building the page tree itself throws.
     * It carries the same `data-plugin` / `data-renderer` markers as the real
     * page so a broken render is still machine-visible, and it shows the error
     * text so the settings panel is never blank.
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
            maxWidth: 760,
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
