/**
 * Measured `system-prompt` behaviour, as conclusions rather than guesses.
 *
 * Every line below is an observation produced by `test/integration.test.mjs`
 * against the real `@deepseek-ai/dsh-system-prompt` + `@deepseek-ai/cordis`
 * packages in a real Cordis context — not a reading of documentation. The
 * snapshot route republishes them (`experiments`) and CONTRACT.md §5 carries
 * the same text, so the browser and the repository can never disagree about
 * what was actually run.
 *
 * @module dsh-prompt-setting/core/experiments
 */

/** One line per experiment: what was run, and what it proved. */
export const EXPERIMENTS = Object.freeze({
  E1: 'assemble() with no argument is legal and returns the registered global sections already in canonical order (harness:identity, deployment:persona-prefix, custom sections by their order, deployment:persona-suffix); sections carry no order/complete field, so their position index IS the order (integration E1).',
  E2: 'system-prompt/assemble is an outermost-first waterfall: listeners run in registration order, next() resolves the downstream value, a listener that never calls next() vetoes every later listener and its return value becomes authoritative, and a listener may await next() to transform the downstream result (integration E2).',
  E3: 'a registered complete:true section overrides the whole scope: even with the section list rewritten in a listener, the final assembly is exactly [that section] with its ORIGINAL registered text (a rewritten copy is reverted), and it is the only section in the result — the listener loses for every section, not just that one (integration E3).',
  E4: 'a scoped section shadows a global section of the same name within its scope while the global view is unchanged, and a listener registered on the root context DOES receive scoped dispatches; a listener tagged below the dispatch scope would not (integration E4).',
  E5: 'the snapshot reports mounted:true only when this plugin\'s own waterfall listener actually observed the probe. When the plugin is disabled or unloaded the /prompt-setting routes are unregistered with it, so the UI observes the absence as an unreachable endpoint rather than as mounted:false (integration/route E5).',
});
