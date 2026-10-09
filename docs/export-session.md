# Saved-session HTML

The export uses Arc's web demo shell and production panel renderer. The session list filters captured names with Arc's session query rules. Timeline layout changes Card layout and Prompt position locally. Linked work opens from its parent turn when launch evidence identifies that turn. The parent link returns to that turn. Missing linked work shows its qualification beside the corresponding entry.

Open the three-dot menu on a saved session heading. Export session as HTML... appears last. Drafts and sessions without saved records have no export action.

Choose Export session as HTML..., read the privacy confirmation, then choose Export. Select a destination folder in the editor's folder picker. Arc creates a separate export directory there. Cancel in the progress notification to stop an export. After completion, choose Open to inspect the local page before sharing.

The export targets the session whose heading opened the menu. Selecting another session does not change that target.

Open `index.html` in a browser. The page embeds scripts and captured data and loads its adjacent stylesheet through a relative path. Local files, an HTTP root, and nested HTTP directories use the same two files. Upload the whole `site` directory when publishing through a static host.

The capture includes every admitted recorded prompt, assignment, answer and commentary body. Turn cards retain complete text beneath their normal disclosures. Messages marked as non-responses do not replace the last response. Unfinished work remains marked unfinished. Embedded data also preserves literal bodies and their source order.

Turn figures include usage, context, output rate, activity counts, subagent facts, relative change paths and commit facts. Session figures include combined cost with main-agent and delegated amounts in its detail. Embedded data includes source digests, coverage and omitted links. Estimates and incomplete figures retain their qualifications.

The capture time fixes relative ages. It does not establish that a captured process remains active. Missing or ambiguous linked evidence leaves relationship coverage partial.

The export starts no agent and exposes no prompt, comment, label, saved-view, editor, resume, diff or recursive export actions. File and commit rows remain readable. Markdown links and images remain inert. Recorded text can contain private information, including paths and addresses written in prompts or responses. Review the complete directory before sharing it.

The capture excludes raw tools, hidden reasoning, command payloads, patches, attachments, comments, drafts, queues, resume data and absolute metadata paths. It reads only verified reachable sessions from the configured provider roots and saved reader-started links. Linked work includes nested subagents, Codex background reviews, dispatched sessions and reader-started sessions. A reader-started relationship adds navigation without adding delegated cost.

Admission limits bound a capture to 128 sessions, 20,000 turns, 4,096 relationships and 1 GiB of source records. One source admits at most 256 MiB. A record admits at most 8 MiB and a turn admits at most 16 MiB. An overflow stops publication without shortening recorded text.

The stylesheet admits at most 2 MiB. The HTML document streams admitted cards into inert encoded data blocks. The browser decodes only the selected session's bounded page range. Initial selection and each Older turns request admit at most 20 cards. Loaded cards remain while their combined decoded data fits the 32 MiB target. A single admitted card that exceeds this target occupies a page alone and retains its complete text. Selecting another session releases the preceding cards. Older turns replaces them when combined data exceeds the target. Browser Back and Forward restore the selected session and bounded page position. Keyboard navigation follows the [web demo platform shortcuts](development.md#static-web-demo). Encoded HTML nodes remain in the document, so total file size and browser memory still grow with the capture. The raw turn limit does not bound Markdown expansion, DOM storage or browser heap use.
