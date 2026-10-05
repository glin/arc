# Manual test checklist

Exercises the full UI in a real Claude Code session. For a fast, no-VS-Code sanity check of the hook pipeline, run `./test/hooks-smoke.sh` instead.

## Setup

```bash
./test/setup-test-repo.sh           # creates /tmp/arc-test (a generic git repo)
code /tmp/arc-test                  # open it in VS Code
```

Open **Arc: Open Arc in Editor** from the Command Palette, or press Ctrl+K A on Windows and Linux or Cmd+K A on macOS.

Then start a **new** Claude Code session **inside that folder**. Any permission mode works; acceptEdits keeps the walkthrough free of approval prompts.

Paste each prompt below as its own turn and check the expected result. Prompts are written so the agent uses the stated tool path.

---

## 1. A turn reaches the panel

Prompt:

> Using only your Edit/Write tools (no shell), add a comment line `# reviewed` to the top of alpha.txt and beta.txt, and create a new file gamma.txt containing `hello`.

Expect:

- Nothing opens on its own and nothing takes focus, so you can keep typing.
- Within a second or two the Timeline gains a card for the turn, saying 3 files. That speed is the trigger file waking the panel; the panel also polls, so a slower arrival is a lost trigger rather than a lost turn.
- The card lists alpha.txt, beta.txt and gamma.txt.

## 2. The turn diff is drawn against the real pre-edit file

On the card from step 1, press **Open the changes**.

Expect:

- One multi-file diff with all three files, alpha.txt and beta.txt modified and gamma.txt new.
- The title reads `3 may include earlier edits` and says nothing about hunks. The snapshot the hook took just before the edit is the left-hand side, so the diff is the exact before-and-after rather than a reconstruction from the transcript.

## 3. Shell changes are not captured

Prompt:

> Run a bash command that appends `appended via shell` to beta.txt (use `printf ... >>`). Do not use the Edit/Write tools.

Expect:

- The new turn's card lists no files. Only changes made through the agent's file-edit tools (Edit/Write/MultiEdit/NotebookEdit) are snapshotted; shell writes, formatters and codegen are outside what the hook sees, by design.

## 4. Parallel-agent isolation

Open a second VS Code window on a separate git worktree or clone and run a second Claude session there.

Expect:

- Each window's rail lists only the sessions whose folder matches that window's workspace. Neither window shows the other's turns.
- A file opened from a card in one window opens in that window, against that session's own snapshot.

## 5. Other editor themes

Open **Preferences: Color Theme** from the Command Palette and switch through a light theme, a dark theme, and a high-contrast theme.

Expect:

- Every element in the panel stays readable against its background in each theme.
- No color is hardcoded against the panel's own dark colors. The panel reads the editor's theme variables.

## 6. Positron

Open the panel inside Positron instead of VS Code, following the same setup steps above.

Expect:

- The panel opens, renders, and behaves the same as it does in VS Code.
- Note any difference from VS Code for follow-up.
