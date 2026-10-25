# Session queries

Use this guide when changing query grammar, identity selection, or matching. [Saved filters and views](rail-and-navigation.md#saved-filters) apply these queries to session list sections. [Content search](session-history.md#search) owns timeline search results.

## Session query syntax

`domain/session-query.ts` owns parsing, caret tokens, and matching. `view/session-query.ts` owns notes and label suggestions.

The axes are `id:`, `session:`, `agent:`, `title:`, `label:`, `cost:`, `cache-expiry:`, and `is:`. Bare words match title substrings. Labels match complete names under shared case folding, including labels folded out of a card. Double quotes enclose values with spaces. Two quotes inside a quoted value represent one quote.

A leading `-` negates a supported term. Outside identity alternatives, all positive terms must match and negative terms exclude matches. For example, `label:ui label:bug is:active` requires both labels and Active. Lone `-` and unquoted words starting `--` add no term. A quote before `-` keeps it literal. `"-fix"` matches title text, and `find: "-name"` matches content. Quoting the start of `id:` or `session:` keeps it as title text, or content after `find:`. Quoting only the value retains identity selection, as in `session:"one"`. Other recognized prefixes still apply inside quotes.

### Status

`is:` completes input, unread, read, running, warm, active, needsyou, archived, and agentrun. Unknown or incomplete values add no term. No complete value prefixes another. `is:input` matches Needs input. `is:running` includes Running, Subagents, and Background. Read and unread match reader-owned attention state.

`is:archived` and `is:agentrun` read their underlying facts independently of visible buckets. `is:warm` uses prompt-cache lifetime against the browser clock, including archived sessions and agent runs. `is:active` matches a warm cache or activity within the last hour. `is:needsyou` requires Active and either unread or Needs input. [Status projection](rail-and-navigation.md#read-and-status-state) owns how rows obtain these facts.

### Session identity

`id:<ID>` and `session:<ID>` select native Claude or Codex identities. Qualify with `claude:` or `codex:` before the ID. Provider names ignore case. IDs preserve case. Paths provide no aliases.

Exact IDs win, including short IDs. Canonical 36-character UUIDs match exactly. Otherwise, values of at least eight characters expand across the complete scoped catalog. Shorter values match exactly. Unknown IDs match nothing. Duplicate source files retain rows but count as one provider identity.

Repeated positive `id:` terms select their union, even with intervening axes. Adjacent positive OR chains containing `id:` join that union. Standalone `session:` terms and session-only OR groups retain AND semantics. Negative selectors exclude globally. Resolve prefixes across archived and hidden sessions before other filters narrow results. Ambiguous-prefix notes give distinct session counts.

Incomplete or unavailable discovery suspends unresolved prefixes, including negative selectors, without rewriting the query. Matching resumes after discovery completes. Exact-only queries retain ordinary matching and coverage.

Uppercase unquoted `OR` joins adjacent positive identity selectors. `label:arc session:claude:one OR session:codex:two` requires the label and either identity. Separate groups and other terms retain AND semantics. Duplicate alternatives never multiply rows. Bare `OR` without adjacent selectors, quoted `OR`, and lowercase `or` remain text. Content search shares identity selection.

Empty or malformed selectors empty results, including negated selectors. Dangling, doubled, mixed-axis, and negated-selector OR chains also empty results. The box displays correction guidance. Identity queries preserve Show settings, so archived sessions and agent runs remain subject to visibility choices.

### Numeric comparisons

`cost:>5.43` keeps recorded USD costs above 5.43. `cost:<5.43` keeps exact recorded costs below it. `cache-expiry:>0` keeps lifetime primary-session cache-expiry counts above zero. `cache-expiry:<3` keeps exact counts below three. Both axes require one strict `<` or `>` followed by a non-negative whole or decimal number. Quoted comparisons are invalid.

Exact values match their strict comparison. Missing cost and unavailable or unindexed cache facts match neither. Lower bounds match `>` only when their known amount exceeds the threshold. They never match `<`, because unknown amounts or unclassified request pairs can increase the value. Negation keeps everything the positive comparison drops, including missing values and lower bounds. Invalid numeric terms remain visible, empty results, and receive correction guidance.

`sessionCacheFactsBySession` in `projectspend.ts` supplies indexed cache facts. Matching reads the session row without scanning requests. Cards display no cache-expiry figure.
