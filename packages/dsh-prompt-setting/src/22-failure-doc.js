
    /**
     * Last-resort card, rendered when building the page tree itself throws.
     * It carries the same `data-plugin` / `data-renderer` / `data-render-state`
     * markers as the real page — plus `data-build` and `data-plugin-version`,
     * both `unknown` because nothing was asked — so a broken render is still
     * machine-visible, and it shows the error text so the settings panel is
     * never blank.
     * @param t - candidate translator; may itself be what broke.
     * @param error - the thrown value.
     * @returns the failure card element.
     */
