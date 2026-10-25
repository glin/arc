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

Positional destinations reject adjacent `.claude/plans` components regardless of letter case on Windows, macOS, and Linux. Existing redirected or unreadable ancestors also refuse before browser launch or file writes. Exported `shoot` with its default writer and direct `writeLosslessWebp` calls check the actual target's parent and refuse existing file links before capture. Shot names that reach plan directories also refuse before replacement or page setup. These checks provide no filesystem sandbox or protection against concurrent path replacement.

Explicit owner options select bounded capture through the checkout-local adapter:

```bash
npm --prefix extension run shots -- --owner PLAN --run RUN --reservation BYTES --shots wide,narrow
```

Owner, run, and reservation options are required together. Omit `--shots` for `wide,narrow`. Unknown, duplicate, missing, or mixed positional options fail. The adapter requires an existing In progress owner and a fresh run identifier. Select at most eight unique names from the existing shot list. Each selected state produces dark and light images. The byte reservation must exceed 8192 and stay within 10000000, including terminal receipt headroom. Whole-owner budgets and metadata reservations also apply. The command awaits terminal completion and preserves partial images on failure or cancellation. A checkout without the private adapter refuses owner captures without starting the legacy matrix. Default and safe positional captures need no private adapter.

The shots run fails with EPERM when its output directory sits inside a folder that a file sync client watches, and passes with an output directory outside the working tree.

Panel capture scripts reuse the state setup in `extension/scripts/panel-shots.ts`. Its default writer checks file admission before clearing the target or setting up the page, then writes lossless WebP. A supplied writer receives the target unchanged and controls file admission and replacement. The screenshot command selects the full fixture matrix or the checkout-local bounded capture adapter. [Panel screenshots](#panel-screenshots) owns command syntax, destination admission, and adapter availability.

## README screenshots

From `extension/`, run the README capture command:

```bash
npx tsx scripts/readme-shots.ts
```

The command builds the panel and writes the README images to `docs/images/`. Pass an output directory to keep comparison captures outside the repository. Bundled Chromium, Edge, or Chrome and ImageMagick 7 must be available. Captures use a fixed clock, `en-US` locale, `America/Chicago` timezone, and two device pixels per CSS pixel. GPU rasterization is off.

The main image captures the exported web demo with its session list narrowed to 270 CSS pixels. Its capture data omits sample comments, including the Prompt box count. The panel viewport is 1120 by 740 CSS pixels. The exported demo supplies the decorative VS Code title bar, activity strip, and Arc tab. The frame adds 16 CSS pixels of transparent spacing and a soft shadow. Its final image is 2372 by 1652 pixels. The capture hides the header through the shared shell stylesheet. The exported demo keeps its header and session list width.

The other captures use the production panel with synthetic Arc sessions and One Dark Pro Darker colors. Comment captures show the selection editor and the saved comment list beside response text. Their session list is 380 CSS pixels wide. The review and files viewports are 1100 by 1000 CSS pixels and use One column card layout. The files image crops the Commits and Files sections and adds 18 CSS pixels of surrounding panel background. Session-menu, response-menu, and cache-expiry viewports are 1430 CSS pixels wide. Other viewports are 1350 CSS pixels wide. All are 700 CSS pixels tall except review and files. Cost and usage figures come from synthetic request records and limit readings. Menu captures use the stand-in from `extension/scripts/web-demo-menu.ts`, which reads the extension manifest and panel context. Browser version, operating system, and fonts affect rendering.

## Static web demo

Build the sample demo from the repository root:

```bash
npx tsx extension/scripts/web-demo.ts
```

Serve `.scratch-web-demo/site` as a static directory. Its relative assets work at the server root and under a project path such as `/arc/`. The page uses the packaged panel renderer, invented session data, and a fixed clock. `view/static-shell.ts` and `webview/static-shell.css` supply its decorative editor frame. Narrow screens hide the activity strip and window title bar. The shell adds no keyboard stops. The panel and its fixed elements share the page viewport, so the demo stylesheet offsets the session list, sticky headings, prompt box, and usage bar. It has no agent connection. `Export session as HTML...` in the saved-session menu downloads the selected invented session and its reachable agent and reader-started sessions. Each download opens offline as one HTML file. The download uses the saved-session export restrictions. Selecting response text opens the production comment action. Comments support saving, editing, and deletion in page memory across session navigation. Back and Forward use the mouse navigation buttons. Keyboard navigation uses Alt+Left and Alt+Right on Windows, Ctrl+- and Ctrl+Shift+- on macOS, and Ctrl+Alt+- and Ctrl+Shift+- on Linux. These shortcuts leave editable fields unchanged. Reloading the page restores the sample comments. A right-click opens the same context menu stand-in with the entries the demo can answer in page memory. New session with the same labels and both Send entries perform no action. Run the browser boundary check with `node extension/test.mjs browser src/web-demo.browser.test.ts`.

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

`view/static-shell.ts` and `webview/static-shell.css` own the decorative editor frame shared by the exported site and main README capture. The panel remains in the page document because its session list and popovers mount directly under the body and use viewport coordinates. Invented session records for a sample site that uses the panel bundle without starting the extension host or reading agent records. Production decoders read provider-response snapshots in `extension/scripts/demo-catalog/`. `demo-catalog-check.ts` compares installed CLI catalogs and base and model-specific defaults without sending prompts. Its `--refresh` option replaces those snapshots. Codex snapshots preserve omitted and null model and effort settings through `codexwire.ts`, so each model retains its configured default. Other configuration fields are excluded. Its `--cwd` option selects the launch folder, whose Claude project and local settings affect catalog aliases and applied defaults. The check launches Claude without the user settings file or model and effort variables, so those personal choices stay out of the snapshots. The check launches Codex in a private temporary home that holds only a copy of the signed-in account file. The account still selects the catalog, and personal settings stay out of the snapshots. The home has no trust entry, so Codex ignores the project settings of the launch folder. `ARC_CLAUDE_PATH` and `ARC_CODEX_PATH` select CLI executables. Offline export does not establish snapshot freshness. `web-demo-host.ts` classifies every panel request and normalizes sample context detail through production contracts. `web-demo-adapter.js` answers supported requests in page memory. `web-demo-export.ts` builds each invented outgoing session graph with the production export projection and renderer. The saved-session menu downloads its prebuilt HTML with the production stylesheet embedded. `exports.json` names the admitted downloads. The static-site checker checks their decoded data blocks and reachable session graphs. The adapter's comment store uses the production normalizer and mutation rules across session navigation. The adapter's navigation trail uses `turnplaces.ts` for session visits and Back and Forward. The demo admits response links only when `domain/session-link.ts` recognizes a sample session. File and external links remain inert. Demo and export keyboard shortcuts use `webview/navigation.ts`. `webview/static-menu.ts` stands in for the editor's context menu there and in the README captures
