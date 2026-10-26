# Panel rendering

Use this guide when changing retained rows, timeline publication, row transport, visibility, or session list loading. [Panel accessibility](panel-accessibility.md) owns keyboard and screen-reader behavior.

## Retained rendering contracts

### Rows, headings, and Activity

The startup shell has no saved-filter catalog. Preserve restored view folds until the host supplies saved filters and views.

`RetainedRailRow` in `webview/rail.ts` owns row reuse. Every draw still compares every mounted row. Less row construction alone establishes no CPU or latency improvement.

Metadata, membership, and label-editor changes update mounted headings without full timeline draws or card fingerprints. The session list owns the responsive boundary. Report filterability separately from payload-dependent visibility, including before payload adoption and heading construction. Boundary changes update heading Labels.

[Timeline navigation](panel-accessibility.md#timeline-navigation) owns heading keyboard stops and focus after control removal.

Held replacements preserve drawn figures until release, while native context and editor state remain current. History footers reuse nodes only while their complete control state matches. Prefetch observes the drawn footer, including during held replacements.

Headings subscribe to read changes and reconcile immediately, including marks received before mounting. Read-key eviction preserves saved disclosures. Cards subscribe before marking restored expanded cards read. Styling, tooltips, and native menu context then agree.

Single-card Activity publishes through the affected keyed mount, fingerprinting only that card. Each mount compares full-render content with its last published fingerprint. Body-availability changes update the mounted heading's card reference, bulk turn actions, menu entries, and accessibility.

Selection holds the newest card snapshot until release. Retrying held cards must permit publication to mounted, unheld cards. Replacement views supersede outgoing queued updates. Activity for the replacement waits and updates its matching card on release. Full timeline draws own structural and layout changes.

### Row deltas and recovery

`webview/row-deltas.ts` owns row encoding and reconstruction. Each panel's sender holds 64-bit prints for `sessions`, `rail`, and `stats`. The host still builds and prints every row. Other fields travel complete.

The query context travels in its own `queryContext` message. It carries the scoped catalog identities, discovery coverage, and scope roots that session queries resolve against. Its revision is a SHA-256 digest of the membership that discovery proved and the catalog membership, so a change to either membership changes the revision. The host posts it to a ready panel when the context that panel last accepted differs. Page readiness and a failed post clear what the panel accepted, so the next publication posts the context again. Each render, selection, session list, and loading post publishes the context first and never carries it. The panel applies the last context it received to every later draw. A changed context redraws the session list and refreshes content search, and it draws nothing else.

Delta headers identify their revision and base. Snapshots extend no revision and carry complete lists. Renders also identify the last `sessions` revision because session list messages omit `sessions`. One host counter prevents reused revisions.

`RowDeltaReceiver` rejects invalid bases and orders before dispatching complete lists. A gap posts `rowsGap` once and preserves drawn rows. Further deltas fail until a snapshot. The host resets that panel's sender and renders its held catalog again.

Send snapshots on page readiness, gaps, failed or unready posts, and changes to local day, repository scope roots, or catalog folders. Repeated row IDs require snapshots for that message and the next. Unkeyed row lists or non-record `stats` post complete and force the next snapshot. Age wording changes resend affected rows.

Selection messages replace drawn rows without changing delta bases. The next render replaces all three drawn lists. The next session list message replaces drawn `rail` and `stats`.

### Visibility and catalog availability

Ready panels receive revisioned visibility, including initial visibility. `webview/retained-visibility.ts` owns paint and geometry checks. Hidden pages stay transparent until paint and a current full-intersection observation agree on a positive rectangle. Geometry changes invalidate prior observations and callbacks. Each generation uses a fresh observer. No larger minimum viewport applies. Without IntersectionObserver, paint alone releases the page.

Preserve the document, reading state, and original inline opacity. Restore eligible focus only while the document has focus and its active element remains the body or document root. Newer focus, pointer, click, or keyboard actions cancel restoration. Activity inside the focused control remembers it for the next host blur. Activity elsewhere clears it. Restore text-selection direction and input selection. Disposal disconnects observation and removes focus listeners and the inert viewport element.

Before workspace catalog publication, selection supplies only selected-session data and quick-filter counts remain unavailable. The first full render establishes catalog availability for subsequent updates. Forget State retains that availability because it retains the catalog.

## Session list loading contracts

### Completion and failures

The loading line follows session list discovery alone. Selected newest-turn loading belongs in the timeline. Read failures never appear in the line. Names, metadata, turn starts, recovery reads, Project cost hydration, and running agents do not keep it loading.

Completion requires a published catalog built from a complete discovery reply under current repository scope roots. A complete reply's follow-up pass does not delay completion. A reply received without catalog publication completes the next same-scope publication only when it answered every listed session. Unanswered sessions keep loading and trigger discovery again.

Reusing a catalog after incomplete discovery retains its prior completion. Scope changes clear completion, so returning roots require another complete reply. A row awaiting its name shows a short ID and can move when its name arrives.

Failed metadata, turn-start, enrichment, and recovery reads retain prior facts. A failed or rejected read of one session does not stop the reads of later sessions in the same pass. `sessionReadFailed` logs once per file and read kind until that kind succeeds or workspace folders change. Canceled refresh reads log nothing.

Only discovery or catalog-refresh failures fail work. Failure hides the line for that generation and clears the placeholder before first render. Every subsequent status in that generation remains failed. Before first completion, the next refresh generation can show loading again.

Render and progress share the refresh generation. Completion rejects delayed progress from the same generation. Progress uses the generation string as its lifecycle epoch, independently of discovery checkpoint epochs.

### Source counts

Pending renders and loading posts repeat the latest accepted discovery checkpoint's source count, including counts whose progress post was throttled. The count persists between generations until a newer checkpoint replaces it. Ignore counts from other repository scope roots. Session list completion ends the count across panels, and workspace folder changes drop it. One panel's pending newest turns never change it.

### Holding the line hidden

First completion holds the line hidden for its repository scope roots across refresh generations. Only completion under the authoritative catalog's listed roots starts this hold. Selection rendering an earlier scope's catalog cannot start it.

Held scopes publish no discovery progress. Pending render, selection, and loading posts retain their own state and carry `held`. The panel hides their line without treating them as complete. `completeRender` acknowledgement and startup history's `background-complete` still require a complete post. Live appends, new sessions, continuations, failures, and newest-turn reads continue without showing loading.

Workspace folder changes release the hold. Repository scope changes release it when roots add one outside the held scope. Removing roots preserves the hold. Completion under a smaller scope keeps the original held roots, so returning removed roots stay held. A new extension host starts without one. Other scope changes hold nothing until a catalog listed under those roots completes. Before first completion, each post retains its own pending state.
