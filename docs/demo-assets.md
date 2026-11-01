# Demo assets

## Panel screenshots

The ordinary command captures the full state matrix in both default themes under `extension/shots`:

```bash
npm --prefix extension run shots
```

One positional destination retains the full matrix outside plan directories:

```bash
npm --prefix extension run shots -- /path/to/shots
```

Destinations reject adjacent `.claude/plans` components without case on Windows, macOS, and Linux. Redirected or unreadable ancestors refuse before browser launch or writes. Default `shoot` and `writeLosslessWebp` also check the target's parent and reject existing file links. Shot names reaching plan directories refuse before replacement or page setup. These checks provide no sandbox against concurrent path replacement.

Explicit owner options select bounded capture through the checkout-local adapter:

```bash
npm --prefix extension run shots -- --owner PLAN --run RUN --reservation BYTES --shots wide,narrow
```

Owner, run, and reservation options are required together. Omit `--shots` for `wide,narrow`. `runPanelShots` in `extension/scripts/panel-shots.ts` owns argument validation. The adapter requires an existing In progress owner and a fresh run identifier. Select at most eight unique names from the existing shot list. Each selected state produces dark and light images. The byte reservation must exceed 8192 and stay within 10000000, including terminal receipt headroom. Whole-owner budgets and metadata reservations also apply. The command awaits terminal completion and preserves partial images on failure or cancellation. A checkout without the private adapter refuses owner captures without starting the legacy matrix. Default and safe positional captures need no private adapter.

For EPERM in a synced screenshot folder, repeat the capture outside the worktree.

A supplied screenshot writer receives the target unchanged and controls file admission and replacement. Default-writer checks do not apply to it.

## README screenshots

From `extension/`, run the README capture command:

```bash
npx tsx scripts/readme-shots.ts
```

The command builds the panel and writes `docs/images/`. Pass an output directory for external comparisons. Install bundled Chromium, Edge, or Chrome and ImageMagick 7. Captures fix the clock, `en-US` locale, `America/Chicago` timezone, and two device pixels per CSS pixel. GPU rasterization is off. `extension/scripts/readme-shots.ts` owns scene dimensions and crops. Browser version, operating system, and fonts still affect rendering.

`prepare` in `extension/scripts/readme-shots.ts` owns scene-specific presentation.

Menus use `extension/scripts/web-demo-menu.ts`, the extension manifest, and panel context.

## Static web demo

Build the sample demo from `extension/`:

```bash
node --import tsx scripts/web-demo.ts
```

The command writes the site to `.scratch-web-demo/site` at the repository root, which is `../.scratch-web-demo/site` from `extension/`. It reads nothing from `extension/dist`. Serve that folder as a static directory. Relative assets work at `/` and project paths such as `/arc/`. The demo uses the packaged panel, invented sessions, and a fixed clock. It has no agent connection. Edits remain in page memory and reset on reload. File and external links remain inert. `extension/scripts/web-demo-adapter.js` owns interactions. `extension/scripts/web-demo-export.ts` owns downloads under the [saved-session restrictions](export-session.md).

Mouse Back and Forward navigate sessions. Keyboard shortcuts leave editable fields unchanged:

| Platform | Back       | Forward      |
| -------- | ---------- | ------------ |
| Windows  | Alt+Left   | Alt+Right    |
| macOS    | Ctrl+-     | Ctrl+Shift+- |
| Linux    | Ctrl+Alt+- | Ctrl+Shift+- |

The context menu stand-in leaves New session with the same labels and both Send entries inert. Run the boundary check:

```bash
node extension/test.mjs browser src/web-demo.browser.test.ts
```

### Updating the demo

Update `extension/scripts/readme-fixture.ts` for sample turns and relationships. Keep usage, request clocks, context totals, and parent edges consistent. The exporter uses the production panel bundle, view factories, text, and manifest menus.

Run the prompt-free catalog check from `extension/` with the folder used to launch Arc:

```bash
node --import tsx scripts/demo-catalog-check.ts --cwd <launch-folder>
```

Refresh stale snapshots with `--refresh`, then review their model and default changes. Offline export does not check catalog freshness.

Classify every `PanelToHost` message in `extension/scripts/web-demo-host.ts`. Add an adapter branch for each handled message. Keep agent launch, file, and terminal actions as silent no-ops.

Publish only a commit that `main` on the `arc` remote holds. Push `main` to the `arc` remote before the checks.

Run the fixture and interaction checks with screenshots from `extension/`, then [build the site](#static-web-demo) at the same HEAD:

```bash
node test.mjs node src/panel-shots.test.ts
ARC_DEMO_SHOTS=<dir> node test.mjs browser src/web-demo.browser.test.ts
```

The browser test builds its own site from the same checkout. `ARC_DEMO_SHOTS` keeps its screenshots and downloads in `<dir>`, and the test creates `<dir>` when it is missing.

Serve the built site over local HTTP. Inspect the screenshots and the served site for both providers' context detail, cache expiry, turn history, dispatched-session navigation, and existing interactions in dark and light themes at desktop and narrow widths. Run the [README capture command](#readme-screenshots) when a shared fixture changes a published scene. Retain original image bytes when only rasterization differs. New visible states need representative sample data and interaction checks. The protocol policy does not establish complete UI coverage.

Publish from the inspected HEAD. Run this from `extension/`:

```bash
node --import tsx scripts/web-demo-publish.ts --message "<subject>"
```

The script fetches `main` and `gh-pages` from the remote. It refuses a checkout whose tracked files differ from HEAD, and a HEAD that the remote's `main` does not hold. It builds the site, runs `.github/scripts/check-web-demo-site.mjs`, and refuses when HEAD or a tracked file changed during the build. It commits the site and an empty `.nojekyll` with the remote's `gh-pages` as the one parent. The subject is `docs(demo): <subject>`, and the trailer is `Source: <full HEAD SHA>`. Then the script moves local `gh-pages` to that commit. It stops with no commit when the site matches the remote's `gh-pages`. It refuses when local `gh-pages` holds commits that the remote lacks, and when a worktree has `gh-pages` checked out. The script builds the tree in a temporary index file and creates the commit with `git commit-tree`, so commit hooks such as `pre-commit` and `commit-msg` do not run. The real index and the working tree stay untouched.

The script prints the source SHA. Check that it matches the HEAD you inspected. Without `--push`, the script prints the push command and pushes nothing. With `--push`, it runs `git push <remote> gh-pages:gh-pages`, which never forces. An agent passes `--push` only with owner approval. `--remote <name>` selects a remote other than `arc`.

## Demo source contracts

Keep the panel in the page document. Its session list and popovers mount under the body and use viewport coordinates. `view/static-shell.ts` and `webview/static-shell.css` own the shared editor frame.

Provider snapshots under `extension/scripts/demo-catalog/` are decoded through production contracts. The catalog check compares installed model catalogs plus base and model-specific defaults without prompts. `--cwd` selects the launch folder. Claude project and local settings apply. Personal user settings and model or effort variables do not. Codex uses a temporary home with only the signed-in account file. That account still selects its catalog. Without a trust entry, launch-folder project settings do not apply. `ARC_CLAUDE_PATH` and `ARC_CODEX_PATH` select executables.

Preserve omitted and null Codex model and effort settings through `codexwire.ts`. Exclude other configuration fields. The adapter uses production context, comment, navigation, and response-link contracts. Export downloads use production projection and rendering with the stylesheet embedded. `.github/scripts/check-web-demo-site.mjs` owns download admission checks. Demo and export keyboard behavior share `webview/navigation.ts`.
