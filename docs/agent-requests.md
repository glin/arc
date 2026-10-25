# Agent requests

[`webview/requests.ts`](../extension/src/webview/requests.ts) owns cards, question tabs, and announcements. [`composerview.ts`](../extension/src/composerview.ts) validates answers. [Question recovery](question-recovery.md#question-recovery-contracts) owns durable recovery.

## Live requests

Live requests belong to their session's prompt box. Codex async questions can survive turn completion under the [async delivery contract](question-recovery.md#codex-asynchronous-questions).

Request arrival must not take focus or scroll the page. Unrelated updates retain unfinished answers, selection, folds, and nested scrolling. Session or ordered request-identity changes reset only nested scrolling.

## Question answers

[`domain/ask-answer.ts`](../extension/src/domain/ask-answer.ts) owns completeness and the exclusion between written text and offered labels. The browser submits only on an action. The host validates labels against the current request.

Preserve written text and original choice labels exactly. Claude joins answers into one string per question. Codex sends written text in the same list as labels.

Question bodies use block Markdown and timeline link navigation. Choices use inline Markdown without interactive content or images. Requests exceeding 64 KiB of combined question text, headers, option labels, and descriptions use escaped text instead. HTML remains escaped except for [validated disclosures](turn-cards.md#markdown-disclosures).

Secrets use password inputs. Question tabs expose completion without exposing values. Beyond two tab rows, tabs omit answer values visually but retain complete non-secret answers in accessible names.

Decline prevents unreadable questions from blocking the child. Sending a prompt answers live open requests first, so the prompt does not wait behind them. Saved recovered questions are excluded. Send's visible explanation, accessible name, and announcement disclose this behavior.

Native radio and checkbox colors depend on VS Code's body theme class. Check them in the [isolated editor](isolated-editor.md#isolated-extension-host). A standalone browser lacks that class. The [keyboard contract](panel-accessibility.md#keyboard-and-screen-reader-contract) owns tab-strip navigation.

## Saved questions

Saved questions retain complete text and choices across host replacement. Unknown delivery, unavailable ownership or source, and unmatched current requests disable Answer. Secrets also require a fresh native request. Decline dismisses ended saved questions locally without starting a provider.
