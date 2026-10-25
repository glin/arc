# Arc

Arc is a VS Code extension with Claude Code hooks. Read `docs/architecture.md` before changing anything. Follow its reading guide for the subsystem you change.

Read `docs/glossary.md` before naming UI regions, domain objects, actions, or state. Use its terms in product copy, documentation, plans, tests, and new code.

Use Conventional Commits with a type and scope.

Do not line wrap Markdown. One paragraph is one line, and one list item is one line. The editor wraps for reading.

`docs/components.md` owns component responsibilities. `docs/architecture.md` owns the system map and package boundaries. `docs/data-sources.md` owns source locations and provenance. `docs/window-channel.md` owns local cross-process contracts. Topic guides own their consequential constraints. Update the owning guide in the same commit when a change alters a component job, adds a data source, or introduces a gotcha. Keep other feature detail in code, tests, or `docs/design-goals.md`. Do not put repository inventories or counts in prose unless a test enforces them.

Read [CLI instructions](cli/CLAUDE.md) for CLI changes, including command help and CLI documentation outside `cli/`. Read [extension instructions](extension/CLAUDE.md) for extension changes and tests.

## Writing

`docs/` and both READMEs are public prose. Keep them timeless, and keep them true to the code.

- Every claim about the code must match the code, including every platform branch. A doc that names a key, a label, or a file-open path names all of them.
- Write the present tense of the software. No dates, no provenance, no contrast with what it replaced, and no account of how a fact was verified.
- Give code no motives. Write "openFile opens the path without rechecking it", never "openFile trusts the path".
- No emdash characters. No semicolons: write two sentences.
- One fact has one home. State it in the section that owns it, and never restate it elsewhere.
- When moving a topic between guides, update the reading guide and links to its old location.
- Use literal verbs and existing names.
- Preserve technical terms, conditions, and uncertainty when simplifying prose. Never strengthen a claim to satisfy a writing rule.

`docs/criteria.md` is personal first-person prose and does not follow this section. Everything else does.

## CLI

Agent calls must use `--json` when the command supports it.

## Feature proposals

Read `docs/design-goals.md` before proposing a feature. State the requirement or reader job the proposal serves. Get author approval before proposing work that serves neither.

New visible controls, dialogs, and panels require authority from the author's request or explicit approval. Serving a design goal alone does not grant that authority. Plans and reviewer suggestions do not supply it. Reviewers must compare each added visible surface with the author's request before approval.

When an inference needs an unauthorized visible surface, pause the inference. Ask the author to resolve the conflict. Continue independent authorized work.

When a design goal blocks valuable work, state the conflict and its cost. The author decides whether to change the goal. Update `docs/design-goals.md` in the same commit when it changes.

## Development workflow

Before committing, check changed documentation, comments, and product messages against the writing rules. Check code claims against the relevant code. Reviewers must repeat these checks.

Read `docs/development.md` before installing dependencies, repairing the panel-mockup link, linking worktree dependencies, or profiling.

Use the diagnostic capture script in [Performance capture](docs/development.md#performance-capture) for performance investigations and diagnostic requests.

Follow the Fast iteration section of `docs/development.md` to test a change while you work and before handoff.

Check a change with the cheapest method that reaches it, in this order:

1. Node tests.
2. Named browser tests.
3. Panel shots, which render the built panel in a headless browser.
4. The Arc command line and saved state, limited to your own test sessions and your own isolated window.
5. The isolated editor: installed VS Code with a fresh profile, launched and driven through Playwright by `scripts/isolated-editor.mjs`.
6. Computer use, only on an isolated editor, and only for a surface the driver cannot reach, such as a native OS dialog. Name the cheaper methods that cannot answer the check.

A launcher, attach, or selector failure in the isolated editor is a defect. Fix it or report it. It never justifies computer use.

Agents never drive the owner's own VS Code window, with computer use or any other tool. When a check needs state that only the owner's window holds, give the owner the exact steps. The commands are in [Fast iteration](docs/development.md#fast-iteration) and [Isolated extension host](docs/development.md#isolated-extension-host).

## Tests

Never wait a fixed time in a test. Poll for the condition the test needs, and fail on a deadline. `page.waitForTimeout`, a `setTimeout` used as a sleep, and any fixed delay before an assertion are banned. In a Node test use fake timers and advance the clock, or `vi.waitFor`. A fixed delay passes on a fast machine and fails on a loaded one, and it costs its full length on every run.

Control clocks and filesystem timestamps in expiry and cache-band tests. Inject operating-system process reads in tests of code that has a deadline. Test the real read separately, without that deadline. Set explicit byte budgets in cancellation and incremental-read tests. Test path rules with mixed-case fixtures and independent Windows, macOS, and Linux expectations.

Tests that simulate platform paths must produce the same results on every host. For filesystem-backed simulations, map reached paths, including roots and ancestors, into owned fixtures. Apply the case rules the code uses for that platform. Record unmapped paths and check them after the call, including when the code catches filesystem errors.

Add a test to the existing file for its subject and reuse that file's setup and helpers.

Review each changed timing test's trigger, time-dependent fixture setup, and controlled clock or awaited state. Before a test timing change lands, run the test several times on the old commit and on the new commit.

## Code boundaries

Use `docs/components.md` and the package boundaries in `docs/architecture.md` when adding or moving a component. Do not maintain a separate component inventory here.

Support Windows, macOS, and Linux. Test every platform branch.
