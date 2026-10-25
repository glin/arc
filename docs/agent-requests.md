# Agent requests

Read this guide for permission and question cards, answer validation, or saved-question presentation. [`requests.ts`](../extension/src/webview/requests.ts) renders cards. [`composerview.ts`](../extension/src/composerview.ts) validates answers. [Question recovery](question-recovery.md#question-recovery-contracts) owns durable question recovery.

## Live requests

Permission requests and questions belong to their session’s prompt box. Live requests remain until answered or the turn ends. Codex async questions follow [async delivery](question-recovery.md#codex-asynchronous-questions), including survival after turn completion.

Submitted controls disable and show `sending your answer` until the host resolves them.

Requests start expanded. Browser-lifetime folds remain independent. Collapsed bodies use `hidden` so their controls leave Tab order. Question headings retain answered counts. Permission headings omit them.

Permissions offer immediate Allow and Deny. Shell commands use code blocks. Other details remain prose.

## Question answers

Single-choice answers advance to the next unanswered question and announce the move. Multi-select answers never advance automatically. The [keyboard contract](panel-accessibility.md#keyboard-and-screen-reader-contract) owns tab-strip navigation.

Question tabs wrap without horizontal scrolling. Beyond two rows, tabs omit answer values visually but retain complete answers in accessible names.

Next advances through unanswered questions. Answer sends only a complete answer. Incomplete action names explain what remains unanswered.

Other is always last and requires nonblank written text. Written answers and offered labels exclude each other. Shift+Enter inserts a line break. Enter advances or sends the completed answer. Preserve written text exactly. Claude joins it to labels in one string. Codex sends it in the same list.

Secrets use single-line password inputs. Their tabs expose completion without exposing values. Enter sends a complete answer.

Question bodies render block Markdown and use timeline navigation for links. Choices render inline Markdown without interactive content or images. Preserve original choice labels in answers. HTML remains escaped except for [validated disclosures](turn-cards.md#markdown-disclosures).

Decline prevents unreadable questions from blocking the child. Unrelated updates retain unfinished answers, selection, folds, and nested scrolling. Session or ordered request-identity changes reset only nested scrolling. The browser submits only on an action. The host validates labels against the current request.

Sending a prompt answers live open requests first, so the prompt does not wait behind them. It reports that the reader answered in the next message, separately from refusal. Saved recovered questions are excluded. Send’s visible explanation, accessible name, and announcement disclose this behavior.

Native radio and checkbox colors depend on VS Code’s body theme class. Check them in the [isolated editor](development.md#isolated-extension-host). A standalone browser lacks that class.

Arriving requests never take focus or scroll the page. Successful answers, agent-side resolution, stopped turns, or child exit remove live cards. Captured unanswered questions remain recoverable.

## Saved questions

Saved questions retain complete text and choices across host replacement. Unknown delivery, unavailable ownership or source, and unmatched current requests disable Answer. Secrets also require a fresh native request. Decline dismisses ended saved questions locally without starting a provider.
