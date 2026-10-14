module.exports = {
  extends: 'stylelint-config-recommended',
  rules: {
    // Component states and theme overrides share selectors with different specificity.
    'no-descending-specificity': null,
    // Separate layout and component sections intentionally repeat selectors.
    'no-duplicate-selectors': null,
    // Visually hidden controls retain legacy clipping.
    'property-no-deprecated': [true, { ignoreProperties: ['clip'] }],
    // paneltext.ts replaces this exact flex value before the browser reads it.
    'declaration-property-value-no-unknown': [
      true,
      { ignoreProperties: { flex: ['0 0 __ARC_RAIL_WIDTH_DEFAULT__px'] } },
    ],
    // paneltext.ts replaces this exact value. Stylelint normalizes max-width to width.
    'media-feature-name-value-no-unknown': [
      true,
      { ignoreMediaFeatureNameValues: { width: ['__arc_rail_min_width_less_one__px'] } },
    ],
  },
};
