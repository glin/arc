# Session queries

Use this guide when changing query grammar, identity selection, or matching. [Saved filters and views](rail-and-navigation.md#saved-filters) apply these queries to session list sections. [Content search](session-history.md#search) owns timeline search results.

## Session query syntax

`domain/session-query.ts` owns parsing, caret tokens, and matching. `view/session-query.ts` owns notes and label suggestions.

Enter queries in the session list's filter box. Outside content search, bare words match title substrings.

| Term             | Matches                                        |
| ---------------- | ---------------------------------------------- |
| `agent:codex`    | Sessions whose agent name contains `codex`     |
| `title:timeline` | Sessions whose title contains `timeline`       |
| `label:release`  | Sessions carrying the complete label `release` |

Title and agent matching ignore case. Label matching ignores case using the reader's locale. Labels match the complete stored list, including names folded out of a card. Empty `agent:`, `title:`, and `label:` values add no term.

Combine ordinary terms with spaces to require every term. Prefix a term with `-` to exclude its matches. This query keeps Codex sessions containing `timeline` in their title without the `release` label:

```text
agent:codex timeline -label:release
```

Enclose values containing spaces in double quotes. Double a quote inside a quoted value to match a literal quote:

```text
label:"release 0.4"
title:"say ""hi"""
```

A quote before a leading `-`, `id:`, or `session:` keeps it literal. Quoting only an identity value retains selection, as in `session:"one"`. Other recognized prefixes still apply inside quotes. Lone `-` and unquoted words starting `--` add no term.

### Status

`IS_VALUES` and `plainTermHolds` in `domain/session-query.ts` own status terms and matching. Unknown or incomplete values add no term.

| Term         | Matches                                                              |
| ------------ | -------------------------------------------------------------------- |
| `is:input`   | Sessions that need input. `is:waiting` and `is:blocked` are aliases. |
| `is:unread`  | Sessions with unread activity                                        |
| `is:read`    | Sessions marked read                                                 |
| `is:running` | Sessions running main agent work, subagents, or a background command |

Unknown read state matches neither `is:read` nor `is:unread`, including negations.

`is:archived` selects archived sessions. `is:agentrun` selects agent runs. Both read their underlying facts independently of visible buckets. In the panel, `is:agentrun` excludes a non-archived session that is pinned or labelled, as [the session list](rail-and-navigation.md#session-list) files it. CLI listings and export read the classification alone, so a pinned or labelled agent run stays one there. `is:warm` uses prompt-cache lifetime against the browser clock, including archived sessions and agent runs. `is:active` matches a warm cache or activity within the last hour. `is:needsyou` requires Active and either unread or Needs input. [Status projection](rail-and-navigation.md#read-and-status-state) owns how rows obtain these facts.

### Session identity

`id:<ID>` and `session:<ID>` select native Claude or Codex identities. Qualify with `claude:` or `codex:` before the ID. Provider names ignore case. IDs preserve case. Paths provide no aliases.

Exact IDs win, including short IDs. Canonical 36-character UUIDs match exactly. Otherwise, values of at least eight characters expand across the complete scoped catalog. Shorter values match exactly. Unknown IDs match nothing. Duplicate source files retain rows but count as one provider identity.

Repeated positive `id:` terms select their union, even with intervening axes. Adjacent positive OR chains containing `id:` join that union. Standalone `session:` terms and session-only OR groups retain AND semantics. Negative selectors exclude globally. Resolve prefixes across archived and hidden sessions before other filters narrow results. Ambiguous-prefix notes give distinct session counts.

Incomplete or unavailable discovery suspends unresolved prefixes, including negative selectors, without rewriting the query. Matching resumes after discovery completes. Exact-only queries retain ordinary matching and coverage.

Uppercase unquoted `OR` joins adjacent positive identity selectors. `label:arc session:claude:one OR session:codex:two` requires the label and either identity. Separate groups and other terms retain AND semantics. Duplicate alternatives never multiply rows. Bare `OR` without adjacent selectors, quoted `OR`, and lowercase `or` remain text. Content search shares identity selection.

Empty or malformed selectors empty results, including negated selectors. Dangling, doubled, mixed-axis, and negated-selector OR chains also empty results. The box displays correction guidance. Identity queries preserve Show settings, so archived sessions and agent runs remain subject to visibility choices.

### Numeric comparisons

Use `cost:>5.43` or `cost:<5.43` to compare recorded USD cost. Use `cache-expiry:>0` or `cache-expiry:<3` to compare lifetime primary-session cache-expiry counts.

Write `>` or `<` immediately before a non-negative whole or decimal number, without spaces. Comparisons exclude equality. Currency symbols, signed numbers, exponents, and quoted comparisons are invalid. `NUMERIC_COMPARISON_VALUE` in `domain/session-query.ts` owns this grammar.

This query keeps sessions labelled `release` with cost above $5.43 and fewer than three cache expiries:

```text
label:release cost:>5.43 cache-expiry:<3
```

Exact values match their strict comparison. Missing cost and unavailable or unindexed cache facts match neither. Lower bounds match `>` only when their known amount exceeds the threshold. They never match `<`, because unknown amounts or unclassified request pairs can increase the value. Negation keeps everything the positive comparison drops, including missing values and lower bounds. Invalid numeric terms remain visible, empty results, and receive correction guidance.

`sessionCacheFactsBySession` in `projectspend.ts` supplies indexed cache facts. Matching reads the session row without scanning requests. Cards display no cache-expiry figure.
