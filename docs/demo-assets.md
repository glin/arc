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

Owner, run, and reservation options are required together. Omit `--shots` for `wide,narrow`. Unknown, duplicate, missing, or mixed positional options fail. The adapter requires an existing In progress owner and a fresh run identifier. Select at most eight unique names from the existing shot list. Each selected state produces dark and light images. The byte reservation must exceed 8192 and stay within 10000000, including terminal receipt headroom. Whole-owner budgets and metadata reservations also apply. The command awaits terminal completion and preserves partial images on failure or cancellation. A checkout without the private adapter refuses owner captures without starting the legacy matrix. Default and safe positional captures need no private adapter.

For EPERM in a synced screenshot folder, repeat the capture outside the worktree.

A supplied screenshot writer receives the target unchanged and controls file admission and replacement. Default-writer checks do not apply to it.

## README screenshots

From `extension/`, run the README capture command:

```bash
npx tsx scripts/readme-shots.ts
```

The command builds the panel and writes `docs/images/`. Pass an output directory for external comparisons. Install bundled Chromium, Edge, or Chrome and ImageMagick 7. Captures fix the clock, `en-US` locale, `America/Chicago` timezone, and two device pixels per CSS pixel. GPU rasterization is off. `extension/scripts/readme-shots.ts` owns scene dimensions and crops. Browser version, operating system, and fonts still affect rendering.

The main scene captures the exported demo without sample comments or the Prompt box comment count. It hides the shared shell header. The exported demo retains its header and normal session list width.

Other scenes use production panel markup, synthetic sessions and usage, and One Dark Pro Darker colors. Comment scenes show the selection editor and saved comment list. Review and files use One column. Menus use `extension/scripts/web-demo-menu.ts`, the extension manifest, and panel context.

## Static web demo

Build the sample demo from the repository root:

```bash
npx tsx extension/scripts/web-demo.ts
```

Serve `.scratch-web-demo/site` as a static directory. Relative assets work at `/` and project paths such as `/arc/`. The demo uses the packaged panel, invented sessions, and a fixed clock. It has no agent connection. Saved-session export downloads one offline HTML file with reachable agent and reader-started sessions under the [saved-session restrictions](export-session.md). Comments support creation, editing, and deletion in page memory across session navigation. Reload restores sample comments. Response links navigate only to recognized sample sessions. File and external links remain inert.

Mouse Back and Forward navigate sessions. Keyboard shortcuts leave editable fields unchanged:

| Platform | Back       | Forward      |
| -------- | ---------- | ------------ |
| Windows  | Alt+Left   | Alt+Right    |
| macOS    | Ctrl+-     | Ctrl+Shift+- |
| Linux    | Ctrl+Alt+- | Ctrl+Shift+- |

Right-click opens the context menu stand-in. New session with the same labels and both Send entries do nothing. Run the boundary check:

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

Classify every `PanelToHost` message in `extension/scripts/web-demo-host.ts`. Add an adapter branch for each handled message. Keep agent launch, file, and terminal actions as silent no-ops. Context replies use the production normalizer and protocol parsers.

Run the fixture and interaction checks, then export the current source:

```bash
node extension/test.mjs node src/panel-shots.test.ts
node extension/test.mjs browser src/web-demo.browser.test.ts
npm --prefix extension run build
npx tsx extension/scripts/web-demo.ts
```

Inspect both providers' context detail, cache expiry, turn history, dispatched-session navigation, and existing interactions in dark and light themes at desktop and narrow widths. Run the [README capture command](#readme-screenshots) when a shared fixture changes a published scene. Retain original image bytes when only rasterization differs. New visible states need representative sample data and interaction checks. The protocol policy does not establish complete UI coverage.

## Demo source contracts

Keep the panel in the page document. Its session list and popovers mount under the body and use viewport coordinates. `view/static-shell.ts` and `webview/static-shell.css` own the shared editor frame.

Provider snapshots under `extension/scripts/demo-catalog/` are decoded through production contracts. The catalog check compares installed model catalogs plus base and model-specific defaults without prompts. `--cwd` selects the launch folder. Claude project and local settings apply. Personal user settings and model or effort variables do not. Codex uses a temporary home with only the signed-in account file. That account still selects its catalog. Without a trust entry, launch-folder project settings do not apply. `ARC_CLAUDE_PATH` and `ARC_CODEX_PATH` select executables.

Preserve omitted and null Codex model and effort settings through `codexwire.ts`. Exclude other configuration fields. The adapter uses production context, comment, navigation, and response-link contracts. Export downloads use production projection and rendering with the stylesheet embedded. `exports.json` names admitted downloads, whose decoded data and reachable graphs the static-site checker checks. Demo and export keyboard behavior share `webview/navigation.ts`.
