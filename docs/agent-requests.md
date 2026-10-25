# Agent requests

## Agent requests

A live Claude or Codex child can stop on a permission request or a question. The host keeps the normalized request until the reader answers it or the turn ends. A Codex async question stays after its turn ends and closes as the `delivery: async` paragraph in `docs/agent-protocols.md` describes. The selected session draws those requests above its prompt text field. The reader answers a request from that session's prompt box.

A request card uses the turn card's frame, background, and corners. Its left border uses the session list's Needs input tone. The heading shows the title and `needs you`. After submission, controls disable and the state reads `sending your answer` until the host removes the card.

The request heading controls disclosure and names its action. A collapsed request shows only that heading. Question headings also show answered-question counts. Permission headings omit counts. The collapsed body is `hidden`, so its controls leave the Tab order. Requests start expanded and retain independent folds only for the browser lifetime.

Permission cards offer immediate Allow and Deny actions. A shell command is shown in a code block, while other request details remain prose.

A question card displays one question at a time. Each tab uses the agent's short label or the question number. Answered tabs show the chosen answer. A single-choice answer advances to the next unanswered question and announces the move in a polite region. Multi-select answers never advance automatically. Pressing a tab selects its question. Arrow keys move between tabs. Home and End reach the strip boundaries. The strip has one Tab stop.

The strip wraps and never scrolls sideways, because a horizontal scroller inside a scrolling panel hides what it holds. Past two rows every tab drops its value and marks only whether its question is answered. The mark never carries the meaning alone: the tab's accessible name still reads the whole answer, including a value the strip cut short or dropped.

The action button says `Next` until every question has an answer, and `Answer` after that. The line beside it says which question the reader is on. The reason the button is off is written beside it in the same words its accessible name carries.

Every question offers `Other` last. Taking it opens a multiline field under the row, and the action button stays off until the reader types. Shift+Enter inserts a line break. Enter activates the visible primary action, which advances to the next unanswered question or sends the completed answer. A question takes offered labels or a written answer, never both, so taking `Other` clears the checked boxes and checking a box clears `Other`. A written answer reaches the agent as the reader typed it. Claude joins it to the labels in one string, and Codex sends it in the same list. Codex asks the client to add the choice: its own tool schema tells the model to leave `Other` out, because the client adds it.

A question that asks for a secret takes its answer in a single-line password box, and its tab reports that it is answered without reporting what it says. Enter sends a complete secret answer.

Question text renders block Markdown in the fieldset's named content area. Reference links use the timeline's navigation routes. Choice labels and descriptions render inline Markdown without links, images, or buttons. Answers retain the agent's original choice labels. Raw HTML stays escaped except for validated disclosures, whose rules belong to [Timeline rendering](turn-cards.md#markdown-disclosures). Permission explanations retain their text or command treatment.

The agent's short question label also appears before the question when the card has no tabs. A line below the question says whether the reader can take one choice or several. A taken choice row keeps a ground of its own. Question cards also offer Decline, so an unreadable request does not leave the child blocked. The browser retains unfinished selections, written answers, the question on screen, the fold, and nested scroll position across unrelated updates. A changed session or ordered request identity resets only the nested scroll position. The browser sends nothing until the reader presses an action. The extension validates every submitted label against the current request and refuses a label nobody offered.

Send answers the open requests before it delivers the prompt. A reader who wants none of the offered choices types their own answer and presses Send. Without this the request stays open, the child stays blocked on it, and the prompt waits behind a question that nobody answered. The requests are told that the reader took none of the choices and answered in their next message, which is a different thing from a refusal. A sentence beside Send says so before the press, it joins the send control's own name, and its arrival is announced in a polite region of its own.

Radios and checkboxes are the browser's own controls. The panel keys their colour scheme off the theme class the editor puts on the body, because the editor publishes no colour for them. Only a panel inside VS Code carries that class, so these colours can be confirmed only there. An agent confirms them in the [isolated editor](development.md#isolated-extension-host).

An arriving request is announced in a polite region and does not take focus or scroll the page. Three polite regions stay apart, one for an arriving request, one for the move to the next question, and one for the sentence beside Send, because a region that mixed two subjects would read as one. The controls disable after submission while the host resolves the answer. A successful answer, an agent-side resolution, a stopped turn, or a child exit removes the card from live state. Captured unanswered questions remain available through recovery.

Saved question cards retain their complete questions and choices after a restored panel replaces the original host. Their detail explains continuation, unavailable delivery, or secret re-entry. Answer remains disabled for unknown delivery, unavailable ownership or session source, and an unmatched current request. A secret also keeps Answer disabled without a fresh native request. Decline dismisses an ended saved question locally and starts no provider.
