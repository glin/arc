---
name: isolated-editor
description: Check Arc in a real VS Code window without computer use. Drives the Arc panel in a separate VS Code window through Playwright, with test data. Use when: check a change in a real VS Code window, the real panel, an installed or Extension Development Host check, end-to-end test. Replaces computer use for this job.
---

# Isolated editor

The commands, options, and cleanup rules live in [Isolated extension host](../../../docs/development.md#isolated-extension-host). Read that section before the first run.

1. Confirm that no cheaper check answers the question. The order is the testing ladder in `CLAUDE.md`, under Development workflow. Its rules for the owner's window and for computer use apply here.
2. Build the checkout under test.
3. Write a check script outside the checkout. Return the values the check needs.
4. Run it with a screenshot. Read the JSON line, then look at the screenshot.
5. When the JSON line reports a cleanup error, run the cleanup command with the `run` directory from that line, and confirm that its report shows no remaining process.
