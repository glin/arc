---
name: panel-mockup
description: Review the panel's UI, draw a mockup for it, or compare several mockup candidates. Screenshots the real page first, then draws every board with the panel's own stylesheet so the mockup argues about the design and not about the style. Use when asked for a UI review, a mockup, a redesign, a candidate comparison, or before-and-after pictures of the panel.
---

# Panel mockups

Read [UI design](../../../docs/ui-design.md) for visual rules and pattern choices.

A mockup drawn in a foreign style argues with the panel instead of about the design, and
the author then iterates on style for hours. Every board here wears the panel's real
stylesheet, so a reader compares the design and nothing else.

Nothing in this skill is a copy of the panel. The stylesheet is generated from `panel.css`
and the theme lives in `extension/src/panelfixture.ts`, so the panel can change and the
mockups follow.

## Prove the tools before you design

Two failures cost a whole design pass, and both stay silent until the end. Run both checks
first. If either fails, say so before you design anything.

- **Prove the renderer runs.** Write one board holding one word and render it with
  `node .claude/skills/panel-mockup/render-boards.cjs <html> <outDir>`. A sandbox that
  refuses to launch a browser produces a design nobody can look at, and every step below
  needs one. A design that reaches its reader as prose has failed, however good the prose is.
- **Prove you can read the real text.** The lengths a board must hold come from the record,
  not from a guess. Read the source the design needs and confirm it. If a permission rule
  blocks the transcript store, ask for a sample file. Never invent the text, and never carry
  it forward from an older board without saying that is what you did.

## Steps

1. **Screenshot the real page first.** Run `npm --prefix extension run shots`. It renders the page the extension serves, in both of the editor's theme kinds, and retains lossless WebPs for its main states under `extension/shots/`. The light files carry a `-light` suffix. The states and the widths are the `SHOTS` array at the top of `extension/scripts/panel-shots.ts`. Look at every WebP, in both kinds. The temporary PNGs are deleted after conversion. Write down what is wrong in words, and name the screenshot. A review that starts from the source instead of the page misses every wrapped label.
2. **Generate the stylesheet.** From `extension/`, run
   `npx tsx ../.claude/skills/panel-mockup/snapshot-css.ts <dir>`. It writes
   `panel-snapshot.css`, which is both theme tables plus `panel.css` filled with the values
   the webview receives, and copies `mock.css`, the artboard scaffolding, and
   `theme-switch.js` beside it. Never edit `panel-snapshot.css`. It is output. The script
   fails if `mock.css` names a panel class that `panel.css` no longer has.

   Then write the tone sheet beside it with
   `npx tsx ../.claude/skills/panel-mockup/tone-sheet.ts <dir>`. It lists every measured
   `panel.css` tone, including excluded lower-priority text and nontext marks, the value each
   theme kind resolves it to, WCAG ratios for text tones against their worst ground, and the
   selectors that paint with them. Each exclusion states why it has no marked failure. Read it
   before picking a colour.
   `npm --prefix extension run tones` writes the same page into
   `extension/shots/` when no mockup is in hand.

   The tone sheet and contrast guard share calculations in `extension/src/tones.ts`, but they cover different themes, exclusions, and known-failure rules. [UI design](../../../docs/ui-design.md#review-and-enforcement) owns their boundary. Never edit the sheet. Regenerate it.
3. **Write one HTML file** that links both stylesheets and holds one
   `<section class="board" data-shot="name">` per state. Each board has an uppercase `h2`
   and one paragraph that says what the board changes and why. Put the frames of a board
   side by side in a `<div class="mockrow">`. That class belongs to the scaffold alone, so
   the panel's own type and spacing never reach the artboards around a frame. Rules for the
   pieces the proposal invents go in a `<style>` block in that file, with an `m` prefix on
   every class, so nothing in the skill accumulates proposal leftovers.

   The page carries no script of its own. It carries exactly one, the shared switcher:

   ```html
   <body class="vscode-dark">
     <div class="mocktheme"></div>
     ...
     <script src="theme-switch.js"></script>
   </body>
   ```

   The switcher builds the picker, and it reads `?theme=<id>` so the renderer can capture
   every theme. A page without it renders the same in all of them, and step 7 fails.

   The themes are `MOCK_THEMES` in `themes.ts`: the editor's two defaults, then the themes a
   reader on this machine actually runs. Add one by giving the names its theme file
   overrides. A tone that reads well on Dark Modern can be unreadable on an installed
   theme, and the only way to see that is to draw the panel in that theme's own variables.
Actions use existing regional button markup and styles. Links serve navigation. Do not turn an action into a link to reduce emphasis.

4. **Use the panel's own class names** for everything that exists. Read the `extension/src/webview/*.ts` files
   for the element shape the panel builds. This lists some of the classes; modules such as `card.ts` build
   elements a different way, so check those files directly for their class names:
   ```
   grep -o "el('[a-z]*', '[a-z ]*'" extension/src/webview/*.ts | sort -u
   ```

   **Copy the markup of every region the design leaves alone. Never write the panel's markup
   by hand.** The session heading row, the composer, the status bar, the rail top and a card
   head are regions a board draws to hold its subject, not the subject itself. Print each one
   from the real page and paste what it prints:

   ```bash
   npx tsx ../.claude/skills/panel-mockup/region-markup.ts '#composer'
   ```

   Run it from `extension/`. It prints the first match one element per line, indented two
   spaces, or every match with `--all`. `--state <name>` drives the page to a state from the
   `SHOTS` array first, so a region only an open card or a pinned popover holds can be printed
   too. A hand-drawn region shows the panel as it was when the author last looked. The shots
   driver marks every card read before it captures, so drop `is-read` from a copied card head.
5. **Draw at the panel's real widths.** The rail's default and minimum are
   `RAIL_WIDTH_DEFAULT` and `RAIL_WIDTH_MIN` in `extension/src/turnrail.ts`. The panel
   widths worth drawing are the ones the `SHOTS` array uses. Draw the narrow state. That is
   where a label wraps.
   Below `RAIL_MIN_WIDTH` the panel draws no rail at all. It replaces the column with a
   native option list, which can carry no glyph and no hover, so a rail board at the
   narrow width draws the picker instead.
6. **Draw the real data distribution, not only the best case.** Include missing, recorded zero, positive, partial or lower-bound, longest, and narrow cases. Measure which case is common in the source when the design depends on how often a value is empty or zero. Draw that common case. Measure a candidate string's width in the browser before choosing a layout. A guess is wrong by the width of one word.
7. **Render and look, in every theme.** Run
   `node .claude/skills/panel-mockup/render-boards.cjs <html> <outDir>`. It writes one
   lossless WebP per board at two times scale plus the whole page, once per theme, then
   verifies each image against its temporary PNG pixel for pixel. A page too tall for WebP
   at two times scale is written at one times scale instead. The first theme's files
   carry no suffix and the rest carry `-<id>`. It requires ImageMagick on `PATH`. Open every
   WebP in every theme and fix what is wrong before anyone else sees it. For a colour, tint, or border change, state the tone-sheet measurement in each rendered theme.
8. **File it beside the plan.** Copy the HTML, both stylesheets, `theme-switch.js`, tone sheet, board WebPs named `<author>-<board>.webp` and `<author>-<board>-<theme>.webp`, and retained before WebPs from `extension/shots/` directly as `current-<state>.webp` and `current-<state>-<theme>.webp`. The plan text names each board file where it discusses it. These stay as working evidence. The report link in step 11 points at a different file.

   **List the folder before you write, and take a prefix of your own if boards are already
   there.** One plan draws more than one review, and the author name repeats. A second
   session writing `<author>-<board>.webp` and `mockup-<author>.html` overwrites the first
   review's boards, with nothing to recover them from where plans are not version
   controlled. Where a `mockup-*.html` or any board WebP already exists, name for the subject
   instead of the author: `mockup-<subject>.html`, and `<subject>-<board>.webp` for every
   WebP. `panel-snapshot.css` and `mock.css` are generated output and may be rewritten in
   place.
9. **Assemble the report file.** Hold every candidate and every theme in it, each under a
   heading that names it.
   Inline `panel-snapshot.css`, `mock.css` and `theme-switch.js` so the file needs no sibling.
   Embed each theme's board in its own `<iframe srcdoc="...">`, under its heading. One
   document shows only one theme's classes at a time, since `theme-switch.js` sets them on
   `<html>`.
   Never link a WebP or a PNG in it.
10. **Verify before you report.** Open the report file in a browser. Confirm every heading
    shows a styled board. A page that fails to load looks the same as no work.
11. **Report the file as a link.** Save it in the plan's own folder. Write a Markdown link
    whose target is the file's full path, starting with the drive letter and never with a slash.
    Never put the path in a fenced code block. Never link an image.
12. **Freeze the approved candidate and write the build spec before implementation.** Record the author's accepted candidate and rejected alternatives in the plan. An implementer cannot infer the choice from a comparison board or replace it without another author decision. Write `<subject>-spec.md` beside the plan. It maps every invented `m` class to its production element and classifies every board rule as already present, an exact production edit, or board-only scaffolding. Include the markup, full CSS edits, copy, states, placement, payload fields, computation path, accessibility behavior, and runtime cost. Add a fixture matrix with missing, recorded-zero, positive, partial, longest, narrow, and common real-data cases. A board shows the result and hides these contracts, so implementation cannot start from the picture alone.

## Handoff fidelity

The build spec is an acceptance contract. Every required visual property must appear in its production mapping. Check appearance through rendered comparison. Add automated guards only for structural or behavioral regressions permitted by the project test rules. Do not leave a required gap, type size, overflow rule, wrapper, or data-state rule only in board CSS or prose.

The fidelity gate runs after the production build and before landing. Put the fixture shots and screenshots from the isolated editor in `docs/development.md` beside the approved board, in every available theme. List every difference. The model that drew the board reviews the built product. An intentional difference needs the author's approval and a spec update.

Use browser geometry when appearance depends on layout. Read visible spacing with `innerText` and element rectangles, not `textContent`. Compare computed type size, alignment, wrapping, clipping, and peer geometry. A DOM string that contains whitespace does not prove the browser drew it.

## Comparing candidates

Use this mode when the request compares alternatives from different authors, models,
generators, or design approaches. A single mockup does not need a comparison shell.

- Keep every candidate in its own sibling directory with its own HTML and rendered boards.
  Finish and inspect each candidate before assembling the comparison. Do not redraw or
  normalize one candidate through another candidate's interpretation.
- Create one neutral comparison page above the candidate directories. Its tabs switch
  between the original candidate pages in titled `iframe` elements, so each page keeps its
  theme switcher, layout, and annotations unchanged.
- Use the accessible tabs pattern: a `tablist`, button elements with `role="tab"`,
  `aria-selected`, `aria-controls`, and a roving `tabindex`, plus matching
  `role="tabpanel"` regions with `aria-labelledby`. Support click, Left and Right Arrow,
  Home, and End. Move focus with keyboard selection and hide inactive panels.
- Candidate pages still carry only `theme-switch.js`. The outer comparison page may carry
  one small local script for tab behavior. It must not reach into or alter a candidate
  frame.
- Use stable, neutral labels. For a blind comparison, show candidate letters and keep the
  identity map outside the page until judging is complete.
- Verify that every frame loads, only the selected panel is exposed, and click and keyboard
  navigation select the same candidate. Open the comparison page at its intended viewport
  and inspect every tab before handing it over.
- The report link is still the self-contained file from step 9. Give it one heading per
  candidate, and one heading per theme within it.

## Rules

- **Delete a review round's raw captures once its branch lands or drops. Keep the plan
  text.** The disposable source captures from step 1, a `visual/` or `baseline-shots/`
  folder, a `generated-extension-backup/` or other build copy, and any worktree checkout
  left beside them are reproducible evidence. The plan history's own rule against
  committing reproducible evidence applies to the working tree too: nobody reads a
  finished round's screenshots again, and a plan folder that keeps every round grows into
  hundreds of megabytes of dead weight. Cut only that bulk scratch. Every prompt, review,
  log and other text file beside it is the plan's record and stays.
- **Read the production component before a board says what a control can hold or when a
  figure is computed.** A board that claims a detail holds no press, or that the host
  computes a total on open, is a claim about code. Open the renderer and the payload
  builder first, and cite the file and line in the board text or the spec.
- A before is the real page, never a drawing. Put before and after side by side when
  replacing something.
- Never a picture from an image model. It cannot use the stylesheet, so every one of them
  is redrawn.
- A popover in a mockup is `class="pop flow"` so it sits in the page flow, or
  `class="pop inplace"` with `left` and `top` when it must overlap what it is anchored to.
  Give the frame a `min-height` that holds the whole popover, or the board screenshot cuts
  it off.
