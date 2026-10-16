
    /**
     * The plugin body — everything this half does once it can be built.
     *
     * The body is deliberately **not** shifted one indent level deeper: it is
     * ~6k lines of hand-written code whose structure is asserted by
     * `test/build.test.mjs` (the fingerprint region covers exactly this text),
     * and a re-indent would be a 6k-line diff for zero behaviour change. The
     * declaration sits outside the build-stamp region's helpers only in
     * position, not in scope; the guard above is its only caller.
     * @param require - the loader's require.
     * @returns the plugin descriptor.
     */
    function buildPlugin(require) {
    const React = require('react');
    const h = React.createElement;

