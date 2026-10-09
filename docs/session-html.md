# Saved-session HTML

The static viewer presents captured sessions through Arc's turn cards and compaction figures. Its session list filters captured names with Arc's session query rules. Card layout and Prompt position change the local reading layout. Back and Forward navigate captured sessions. Linked work opens from its parent turn when launch evidence identifies that turn. The parent link returns to that turn. Missing linked work shows its qualification beside the corresponding entry.

Open the gear on a saved session heading. Timeline options keeps Card layout and Prompt, followed by the Export session as HTML... action. Drafts and sessions without saved records have no export action.

Choose Export session as HTML..., read the privacy confirmation, then choose Export. Select a destination folder in the editor's folder picker. Arc creates a separate export directory there. Cancel in the progress notification to stop an export. After completion, choose Open to inspect the local page before sharing.

The export targets the session whose heading opened Timeline options. Selecting another session does not change that target.

Open `index.html` in a browser. The page loads its adjacent scripts and stylesheet through relative paths. Local files, an HTTP root, and nested HTTP directories use the same assets. Upload the whole `site` directory when publishing through a static host. Publishing only `index.html` leaves session text unavailable.

The capture includes every admitted recorded prompt, assignment, answer and commentary body. Unfinished work remains marked unfinished. Read recorded text opens complete bodies beyond card previews. Long bodies have Previous text and Next text controls. Recorded text preserves the literal source text beside the Markdown view.

Recorded figures and changes includes usage, context, output rate, activity counts, subagent facts, relative change paths and commit facts. Capture details includes main-agent, delegated and combined session costs, source digests, coverage and omitted links. Estimates and incomplete figures retain their qualifications.

The capture time fixes relative ages. It does not establish that a captured process remains active. Missing or ambiguous linked evidence leaves relationship coverage partial.

The viewer starts no agent and exposes no editor, prompt, comment, file, diff or commit actions. Markdown links and images remain inert. Recorded text can contain private information, including paths and addresses written in prompts or responses. Review the complete directory before sharing it.

The capture excludes raw tools, hidden reasoning, command payloads, patches, attachments, comments, drafts, queues, resume data and absolute metadata paths. It reads only verified reachable sessions from the configured provider roots and saved reader-started links. Linked work includes nested subagents, dispatched sessions and reader-started sessions. A reader-started relationship adds navigation without adding delegated cost.

Admission limits bound a capture to 128 sessions, 20,000 turns, 4,096 relationships and 1 GiB of source records. One source admits at most 256 MiB. A record admits at most 8 MiB and a turn admits at most 16 MiB. An overflow stops publication without shortening recorded text.

Each generated asset admits at most 2 MiB. Text chunks admit at most 64 KiB. The initial timeline admits at most 20 cards and 2 MiB of decoded recorded text. Retained viewer payload admits at most 32 MiB. Older turns, text blocks and full text load on demand. Opening another turn's text releases the previous turn's loaded detail.
