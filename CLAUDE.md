# Arc

Arc is a VS Code extension with Claude Code hooks. Read `docs/architecture.md` before changing anything. Follow its reading guide for the subsystem you change.

Read `docs/glossary.md` before naming UI regions, domain objects, actions, or state. Use its terms in product copy, documentation, plans, tests, and new code.

Use Conventional Commits with a type and scope.

Do not line wrap Markdown. One paragraph is one line, and one list item is one line. The editor wraps for reading.

`docs/architecture.md` owns the component map, data sources, and non-obvious gotchas. Update it in the same commit when a change alters a component job, adds a data source, or introduces a gotcha. Keep other feature detail in code, tests, or `docs/design-goals.md`. Do not put repository inventories or counts in prose unless a test enforces them.

## Writing

`docs/` and both READMEs are public prose. Keep them timeless, and keep them true to the code.

- Every claim about the code must match the code, including every platform branch. A doc that names a key, a label, or a file-open path names all of them.
- Write the present tense of the software. No dates, no provenance, no contrast with what it replaced, and no account of how a fact was verified.
- Give code no motives. Write "openFile opens the path without rechecking it", never "openFile trusts the path".
- No emdash characters. No semicolons: write two sentences.
- One fact has one home. State it in the section that owns it, and never restate it elsewhere.
- When moving a topic between guides, update the reading guide and links to its old location.

`docs/criteria.md` is personal first-person prose and does not follow this section. Everything else does.

## Feature proposals

Read `docs/design-goals.md` before proposing a feature. State the requirement or reader job the proposal serves. Get author approval before proposing work that serves neither.

New visible controls, dialogs, and panels require authority from the author's request or explicit approval. Serving a design goal alone does not grant that authority. Plans and reviewer suggestions do not supply it. Reviewers must compare each added visible surface with the author's request before approval.

When an inference needs an unauthorized visible surface, pause the inference. Ask the author to resolve the conflict. Continue independent authorized work.

When a design goal blocks valuable work, state the conflict and its cost. The author decides whether to change the goal. Update `docs/design-goals.md` in the same commit when it changes.

## Development workflow

Read `docs/development.md` before installing dependencies, repairing the panel-mockup link, linking worktree dependencies, or profiling.

Use the diagnostic capture script in [Performance capture](docs/development.md#performance-capture) for performance investigations and diagnostic requests.

Follow the Fast iteration section of `docs/development.md` to test a change while you work and before handoff.

The `panel.layout*.test.ts` files run the panel in bundled Chromium, Edge, or Chrome. Each skips when no browser exists. Read the skip result after changing `extension/src/webview/panel.css`.

Build before viewing changes to `extension/src/webview/panel.css`, `extension/src/webview/panel.ts`, `extension/src/webview/main.ts`, or `extension/src/panelbundle.ts`:

```bash
npm --prefix extension run build
```

Review browser shots before and after changes to panel styles or browser code:

```bash
npm --prefix extension run shots
```

Open the real panel after changing panel host options. Verify restored tabs because browser tests cannot read options saved when the editor created a tab.

## Tests

Never wait a fixed time in a test. Poll for the condition the test needs, and fail on a deadline. `page.waitForTimeout`, a `setTimeout` used as a sleep, and any fixed delay before an assertion are banned. In a browser test use `page.waitForFunction` or an auto-retrying Playwright locator assertion. In a Node test use fake timers and advance the clock, or `vi.waitFor`. A fixed delay passes on a fast machine and fails on a loaded one, and it costs its full length on every run.

`SETTLED` from `extension/test/browser.ts` waits for two animation frames. It does not confirm media-query delivery, ResizeObserver placement, compositor scrolling, or timer expiry. After those operations, wait for the state the assertion reads. Preserve the outcome assertion when repairing synchronization. Do not replace it with a retry, a larger deadline, or a wider tolerance.

Control clocks and filesystem timestamps in expiry and cache-band tests. Set explicit byte budgets in cancellation and incremental-read tests. Test path rules with mixed-case fixtures and independent Windows, macOS, and Linux expectations.

Add a test to the existing file for its subject and reuse that file's setup and helpers. Create a new browser test file only when no file covers the subject. Add a browser test only when no Node test or text scan can catch the defect. Never add a browser test to check a width, spacing, color, font or wording. A plan or brief does not override this rule. When one asks for such a test, skip it and name the conflict in your report.

Review each changed timing test's trigger, time-dependent fixture setup, and controlled clock or awaited state. Before a test timing change lands, run the test several times on the old commit and on the new commit.

Use the `themed` helper from `extension/src/panelfixture.ts` for browser tests. Never set a theme variable by hand.

## Code boundaries

Put logic in a module that does not import `vscode`. Keep `vscode` glue small and move decisions into tested modules. `extension/src/imports.test.ts` enforces VS Code exemptions, production fixture boundaries, package directions, and runtime cycles.

Use the component map and ownership graph in `docs/architecture.md` when adding or moving a component. Do not maintain a separate component inventory here.

`extension/src/webview/panel.ts` and `extension/src/webview/panel.css` are build inputs with text, unit, and browser coverage.

`extension/src/turnfixtures.ts` holds test data, not shipping logic. Add a builder when shared tests need it. Production code must not import it.

## UI work

Read [UI design](docs/ui-design.md) before adding or changing panel UI.

Make every visible control keyboard reachable and screen-reader readable. Use real buttons, visible focus, and accessible names that include visible information. Follow the panel reachability patterns in `docs/rail-and-navigation.md`.

Support Windows, macOS, and Linux. Follow host conventions for platform labels and shortcuts. Test every platform branch.

Use `extension/src/webview/inline-text.ts` for compound text split across elements. Render literal DOM separators because CSS gaps are visual only.

Apply relative text scaling to the text owner. Give repeated UI roles one production component or CSS rule. Review rendered peers at wide and narrow widths in each default theme.

A webview helper that performs a full Preact draw must never run inside a loop over sessions or cards. Process the list, then draw once. `extension/src/webview.integration.browser.test.ts` guards this at 100 and 1000 sessions.

Size text-related elements in `em`. Use `px` for hairlines, radii, and decorative bars.

Use the `panel-mockup` skill for a mockup or panel review. It starts with real panel shots and uses the panel stylesheet.

Use the shared relative-age formatter. Show full local time in a native tooltip and accessible name. Show time for today and a short date for earlier days when calendar context matters.

Order and word a context menu entry by the convention in `docs/rail-and-navigation.md`'s "Context menus and copy" section.

Use `data-hint` and `data-hint-detail` for controls. Use native `title` for read-only text and rows in open popovers. Do not put native `title` on a button. Drop a hint that repeats visible control text.

In user-facing copy, never say chip. Say Compact for the Card layout setting, or name the figure.
