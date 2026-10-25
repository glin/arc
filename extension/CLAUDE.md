# Extension instructions

Paths in code spans and commands are relative to the repository root. Run commands from the repository root.

## Development workflow

The `panel.layout*.test.ts` files run the panel in bundled Chromium, Edge, or Chrome. Each skips when no browser exists. Read the skip result after changing `extension/src/webview/panel.css`.

Build before viewing changes to `extension/src/webview/panel.css`, `extension/src/webview/panel.ts`, `extension/src/webview/main.ts`, or `extension/src/panelbundle.ts`:

```bash
npm --prefix extension run build
```

Review browser shots before and after changes to panel styles or browser code:

```bash
npm --prefix extension run shots
```

After changing panel host options, check a new panel tab in the isolated editor. Check a restored tab with `node scripts/isolated-editor.mjs restore --baseline-commit <revision>`, where the revision saved the old options. Browser tests cannot read options saved when the editor created a tab. A tab restored by the owner's own editor is an owner check.

## Browser tests

In a browser test use `page.waitForFunction` or an auto-retrying Playwright locator assertion.

`SETTLED` from `extension/test/browser.ts` waits for two animation frames. It does not confirm media-query delivery, ResizeObserver placement, compositor scrolling, or timer expiry. After those operations, wait for the state the assertion reads. Preserve the outcome assertion when repairing synchronization. Do not replace it with a retry, a larger deadline, or a wider tolerance.

Create a new browser test file only when no file covers the subject. Add a browser test only when no Node test or text scan can catch the defect. Never add a browser test to check a width, spacing, color, font or wording. A plan or brief does not override this rule. When one asks for such a test, skip it and name the conflict in your report.

Use the `themed` helper from `extension/src/panelfixture.ts` for browser tests. Never set a theme variable by hand.

## Code boundaries

Put logic in a module that does not import `vscode`. Keep `vscode` glue small and move decisions into tested modules. `extension/src/imports.test.ts` enforces VS Code exemptions, production fixture boundaries, package directions, and runtime cycles.

`extension/src/webview/panel.ts` and `extension/src/webview/panel.css` are build inputs with text, unit, and browser coverage.

`extension/src/turnfixtures.ts` holds test data, not shipping logic. Add a builder when shared tests need it. Production code must not import it.

## UI work

Read [UI design](../docs/ui-design.md) before adding or changing panel UI.

Make every visible control keyboard reachable and screen-reader readable. Use real buttons, visible focus, and accessible names that include visible information. Follow the panel reachability patterns in `docs/panel-accessibility.md`.

Follow host conventions for platform labels and shortcuts.

Use `extension/src/webview/inline-text.ts` for compound text split across elements. Render literal DOM separators because CSS gaps are visual only.

Apply relative text scaling to the text owner. Give repeated UI roles one production component or CSS rule. Review rendered peers at wide and narrow widths in each default theme.

A webview helper that performs a full Preact draw must never run inside a loop over sessions or cards. Process the list, then draw once. `extension/src/webview.integration.browser.test.ts` guards this at 100 and 1000 sessions.

Size text-related elements in `em`. Use `px` for hairlines, radii, and decorative bars.

Use the `panel-mockup` skill for a mockup or panel review. It starts with headless shots of the built panel and uses the panel stylesheet.

Use the shared relative-age formatter. Show full local time in a native tooltip and accessible name. Show time for today and a short date for earlier days when calendar context matters.

Order and word a context menu entry by the convention in `docs/panel-navigation.md`'s "Context menus and copy" section.

Use `data-hint` and `data-hint-detail` for controls. Use native `title` for read-only text and rows in open popovers. Do not put native `title` on a button. Drop a hint that repeats visible control text.

In user-facing copy, never say chip. Say Compact for the Card layout setting, or name the figure.
