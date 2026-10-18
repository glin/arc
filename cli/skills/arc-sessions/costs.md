# Report costs

Arc supplies raw data. Assemble any report yourself. Arc has no report dashboard, label accounting, or report schedule.

1. List every page. Read each row once by its exact path: `arc cost PATH --since START --until END --by-model --json`. Cost takes no `--window`. It reads transcripts from disk and searches every project, not the window scope.
2. Take each row's `parent` subtotal. Add each `children[]` entry whose `file` is not a listed `path`, once across the whole report. A child transcript that is also a listed row counts only through its own row.
3. Report a row whose `path` is `null`, or whose cost read fails, as an explicit unknown cost. Preserve null full totals, known priced subtotals, legacy estimates, model gaps, and request coverage.
4. Use a half-open interval of request times. Pass `START` and `END` as ISO 8601 times with an explicit offset, for example `2026-10-01T00:00:00-07:00`. Include sessions with requests in the interval, even when they started earlier. Do not select sessions by last activity or creation date alone.
5. Treat labels as the reader's current labels, not historical labels. Keep unlabelled work visible. Choose a rule for sessions with more than one label, and choose whether a child's cost joins its parent's labels. State both rules in the report. List-price estimates are not subscription charges.
