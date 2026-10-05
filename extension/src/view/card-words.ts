import { COMMENT_ACTIONS } from './comments.ts';

// Every word the panel spells out for itself: the name of a control that has nothing on
// screen to name it, the text on one that does, and the line it writes when a control has
// left it with nothing to draw. Held here rather than in the panel because the panel is the
// one file with no tests: a word written there can go missing in silence, while a word
// missing from this table fails a test. `panelhost.ts` hands the whole table to its webview
// as JSON and reads every label out of it.
//
// A name built out of what a card holds is not in here. It is built in this module and
// arrives on the card, so the wording and the pieces it is made of are tested together.
export const CARD_ACTIONS = {
  // The words for a reader's comments, folded in whole. They are declared above rather than
  // here because a const spread into one declared below it is read before it exists.
  ...COMMENT_ACTIONS,
  session: 'Session',
  composerCollapse: 'Collapse prompt box',
  composerCollapseDetail: 'Hide the prompt box and its requests, attachments, and controls. Keep its saved height.',
  composerRestore: 'Restore prompt box',
  composerRestoreDetail: 'Show the prompt box at its saved height, limited to the available space.',
  composerHeight: 'Prompt box height',
  composerHeightCollapsed: 'Prompt box height. Prompt box collapsed.',
  turnDiff: 'Open the changes',
  // What the Files section's own cap offers in place of the rows it cut. The label reads "Show
  // N more files", so the button's own text already says how many rows a press adds back. The
  // toggle's other state names what a second press does instead of repeating what the first
  // one did.
  filesMoreOne: 'more file',
  filesMoreMany: 'more files',
  filesLess: 'Show fewer files',
  openSubagentSession: "Open this subagent's session",
  openDispatchedSession: 'Open this dispatched session',
  dispatchedRecord: "This dispatched session's record",
  // The row of a subagent whose session Arc cannot open. It names no action, because the row
  // performs none. It is there so the row's record has a heading when the reader opens it.
  subagentRecord: "This subagent's record",
  activityBreakdown: 'Show tool breakdown',
  activityBreakdownTable: 'Recorded tool invocations',
  activityBreakdownRunning: 'Recorded tool invocations so far',
  activityBreakdownDifference: 'Activity groups can differ.',
  activityRecorded: 'recorded',
  activityRecordedSoFar: 'recorded so far',
  // The skills a turn loaded, which the Activity heading opens beside the tool counts. A
  // skill is instructions the agent took on, not a tool it ran, so it is counted and drawn
  // apart from the tool mix.
  activitySkillsHeading: 'Skills this turn loaded',
  activitySkillsOpen: 'Open this skill',
  activitySkillsMissing: 'The recorded file is no longer there.',
  // Said once under the list, and only when it holds a Codex skill. Codex proves only that it
  // read the file, never why it chose the skill, so the list says that once for every row it
  // covers rather than naming it on each row.
  activitySkillsBestEffort: 'Codex skills are a best-effort match from the SKILL.md files that Codex read.',
  activitySkillsPopover: 'Show the skills this turn loaded',
  openCommit: 'Open this commit',
  // The label over a prompt sent after the turn had started. Said in words rather than left
  // to a rule or an indent, because the section holds two or more blocks of the reader's own
  // text and nothing else on the card says which of them the turn began with.
  askedMidTurn: 'Asked while this was running',
  // A prompt the panel has sent and the transcript does not hold yet. Claude Code writes a
  // queued prompt when the agent picks it up, which is when the call it is on comes back, and
  // that was measured at 76 seconds on one real turn. Said apart from the label above,
  // because the panel knows it sent this one and does not know the agent has it.
  askedJustSent: 'Just sent',
  // What the head row puts in front of the turn's duration. The row already draws when the
  // turn started, as `2 hours ago`, and a bare figure beside it reads as a second clock
  // time rather than as how long the turn ran. The word is drawn as a text node beside the
  // figure, never inside it, so the ticker keeps rewriting only the figure.
  //
  // The wording follows what the figure means. A finished turn's figure is
  // how long it took; a running turn's is how long it has taken so far, and the ticker
  // grows it once a second. A past-tense label on a turn still running says it is over.
  ranFor: 'ran in',
  runningFor: 'running for',
  // The section holding everything the agent said on its way to its answer: the narration
  // it wrote as it worked, and every answer it closed other than its response. The response
  // is drawn above this and never in it.
  // Retained so a replies-only Said section can be restored.
  saidSection: 'Said while working',
  logRunning: 'running',
  logRunShow: 'Show the tool calls',
  logRunHide: 'Hide the tool calls',
  logLineShow: 'Show the whole line',
  logLineHide: 'Hide the whole line',
  logRowsDetail: 'Up and Down move between rows. Escape shuts an open row.',
  logRepliesOnly: 'Show the replies only',
  logMessagesOnly: 'Show the messages only',
  logEverything: 'Show everything again',
  logFilterDetail: 'The other rows are hidden until pressed again',
  logShowingReplies: 'showing replies only',
  logShowingMessages: 'showing messages only',
  logAllActivity: 'All activity',
  logMessagesView: 'Messages only',
  logRepliesView: 'Replies only',
  logShowAllActivity: 'Show all activity',
  logShowMessagesOnly: 'Show messages only',
  logNoMessages: 'No messages were recorded for this turn.',
  // The word that distinguishes a reply from narration in its accessible text.
  saidReplied: 'Replied',
  // A single message can run to thousands of characters, so a long one opens bounded and
  // says so. Two forms, because a name that stays the same while the state moves leaves a
  // reader who cannot see the block with no way to tell which way the next press goes.
  saidMore: 'Show all',
  saidLess: 'Show less',
  // What a plain press on the section head does. It is the last clause of the head's spoken
  // name, the way a session heading's name ends on its own action.
  saidCollapse: 'Collapse this section',
  saidExpand: 'Expand this section',
  // What a press with Shift held does, which is the head's second job and the section's only
  // bulk control. One form per state of the messages under it, and the head carries none of
  // them where a Shift press would do nothing.
  saidWholeDetail: 'Shift+click or Shift+Enter shows every message whole',
  saidLessDetail: 'Shift+click or Shift+Enter shows less on every message',
  saidOpenWholeDetail: 'Shift+click or Shift+Enter opens it with every message whole',
  codeCopy: 'Copy',
  codeCopied: 'Copied',
  promptMore: 'Show the whole prompt',
  promptLess: 'Show less',
  // The press under a prompt drawn before the response. It shows what the reader typed while
  // the turn ran, which the prompt lead folds to one line. The count leads the words.
  laterAsksShow: 'more asked while it ran',
  laterAsksHide: 'Hide what was asked while it ran',
  picker: 'Session to show',
  // What a press on a session heading does. It is the whole of what the heading does,
  // so it is the last clause of the heading's accessible name as well as its hover.
  //
  // Two forms, one for each state. A name that stays the same while the state moves leaves
  // a reader who cannot see the twist with no way to tell which way the next press goes.
  expandAllTurns: 'Expand every shown turn',
  // Leads the heading hint's second line with the full local time of the session's last
  // activity, since the heading draws no age.
  lastActive: 'Last active',
  collapseAllTurns: 'Collapse every shown turn',
  // The button beside the heading that opens the session's own menu: pin, archive,
  // labels, rename, and details. Named the way a rail action is, action then title, and its hint
  // carries the same words since the button binds no key of its own.
  sessionActions: 'Session actions',
  sessionActionsDetail: 'Pin, archive, labels, rename, and details',
  // What a search found nothing in, by the scope it actually ran over. Three claims, and
  // only one of them is ever true: "no turn says that" over a workspace, over a whole
  // session, and over the window search reads of one are different answers.
  //
  // Search keeps its own read window, which is neither the ordinary tail nor the older pages
  // the reader has loaded. A scoped search that did not reach the first turn must say so, or
  // the reader takes silence about a window for silence about the session.
  searchEmptyByScope: {
    workspace: 'No turn says that. Search reads every session in this workspace.',
    session: 'No turn in this session says that. Only the session on screen was searched.',
    sessionPart: 'No turn says that in the part of this session that search reads.',
  },
  searchWorking: 'Reading every session in this workspace...',
  // While one session is pinned the search reads it alone, and the busy line must
  // not promise the whole workspace.
  searchWorkingScoped: 'Reading this session...',
  // Appended to the result count, so a short list is read as the answer of the scope that
  // produced it rather than the workspace's. The workspace has no entry, because a plain
  // count already means the workspace.
  searchCountByScope: {
    session: 'in this session',
    sessionPart: 'in the part of this session that search reads',
  },
  searchPrompt: 'you asked',
  searchSummary: 'it answered',
  // One word for the whole panel. The control has always drawn an archive box, and the
  // reader calls it archiving, so the words say archive too. What it means has not
  // changed: the session keeps its turns, its pending changes and its baselines, and
  // the rail's Archived bucket brings it back.
  hideSession: 'Archive this session',
  unarchiveSession: 'Unarchive this session',
  hideSessionHint: 'Archive',
  hideSessionDetail: 'Moves it to Archived. Nothing is deleted.',
  unarchiveSessionHint: 'Unarchive',
  unarchiveSessionDetail: 'Returns it to the list',
  // Pinning here keeps a session at the top of the rail, parsed however old it
  // gets. A different thing from showing one session alone, which a card press
  // does; the two live side by side and the words must not blur them.
  railPin: 'Pin this session to the top',
  railUnpin: 'Unpin this session from the top',
  railPinHint: 'Pin',
  railPinDetail: 'Keeps it at the top of the list',
  railUnpinHint: 'Unpin',
  railUnpinDetail: 'Returns it to its place by activity',
  // Said of a session another agent started rather than the reader. It names what
  // happened and not who was absent: a panel that told the reader a session was not
  // theirs would be wrong about their own work roughly once in twenty short ones, and
  // wrong in the worse direction.
  //
  // Drawn in the slot the agent name has, never beside it. Both together take the meta
  // line to two lines at the rail's default width, measured at 30px against 15px, and the
  // line breaks in the middle of the phrase and again in the middle of the time. The
  // agent's name is still said in full by the card's accessible name.
  agentRun: 'run by an agent',
  // The word the meta line of the card a compact rail row opens on hover puts before a running
  // session's duration. `hoverMore` follows the count of labels the card folds, as in `+2 more`.
  hoverFor: 'for',
  hoverMore: 'more',
  // The way back to the top of a long session, drawn over the foot of the panel once
  // the reader has scrolled a screen past it. Its word is the whole of its name: what the
  // button shows and what it is announced by are the same string, so a reader who cannot
  // see it asks for it by exactly what a reader who can would call it. An arrow would say
  // neither, being read out by its Unicode name.
  toTop: 'Back to the top',
  hiddenEmpty: 'Every session is archived.',
  // Appended to the status word on a head row's hover while the turn is still to be read,
  // because the tint that says so is drawn by the stylesheet and cannot carry a hover of
  // its own.
  statusUnread: 'unread',
  // The session rail's own name, for the landmark that holds its cards at wide widths.
  // Nothing on screen names the rail, so it carries this itself.
  railLabel: 'Sessions',
  // The rail's own filter box. It narrows the rail alone and leaves the timeline and picker
  // on the session already chosen.
  railFilter: 'Filter sessions',
  railFilterHint: 'Filter sessions',
  railFilterClear: 'Clear the filter and show every session',
  // The same cross over an empty box. The press gives the row back to the count, and the
  // name says so rather than offering to clear a query that has already gone.
  railFilterClose: 'Close the text filter',
  // The button that hands the rail head row to the text box.
  railSearch: 'Filter sessions by text',
  railSearchHint: 'Filter by text',
  // The lens counts on the rail head row. Each narrows the rail to the sessions it names, so its
  // name carries the figure the reader sees and its hint says what a press leaves on screen.
  railCountActive: 'Active',
  railCountSession: 'session',
  railCountSessions: 'sessions',
  railCountRunningHint: 'Show only the sessions whose agent is working now',
  railCountActiveHint: 'Show only the sessions with a live cache or activity in the last hour',
  railCountUnreadHint: 'Show only the unread sessions',
  railCountInputHint: 'Show only the sessions where an agent needs your input',
  railCountPressedHint: 'Show every session again',
  // What the Active count's bolt says about the prompt caches of the sessions it counts. Each
  // sentence says whether any cache is warm or about to go, never how many, and never that
  // every session the count holds shares that state.
  railCountCacheWarm: 'Some active sessions have a warm cache.',
  railCountCacheExpiring: 'Some active sessions have a cache that is expiring.',
  railCountCacheNone: 'No active session has a warm cache.',
  // Drawn in the rail when its filter leaves nothing, so the box that caused it stays on
  // screen with the way back beside it.
  railFilterEmpty: 'No session matches.',
  // The list under the filter box, which offers the axes the grammar reads and the labels the
  // workspace has. It names itself because nothing on screen heads it: the box above it is a
  // box, and the rows arrive under it while the reader is part way through a word.
  railFilterOffers: 'Filter suggestions',
  // Opens the spoken name of a row in that list. Every row draws an axis word and a colon,
  // and a colon is read out as punctuation or skipped, so the name says what the press does
  // rather than leaving the reader to work the grammar out from a fragment.
  railFilterTake: 'Filter by',
  // The same row read out when the word under the caret opens on the negation mark, where a
  // press writes a term that drops the sessions it names instead of keeping them.
  railFilterWithout: 'Filter out',
  railFilters: 'View',
  railFiltersHint: 'Change the view',
  railFilterAll: 'All sessions',
  railFilterCustom: 'Custom',
  railFilterFind: 'Find a label or saved filter',
  railSortBy: 'Sort by',
  railGroupBy: 'Group by',
  railGroupByValues: { time: 'Time', label: 'Label', agent: 'Agent', status: 'Status', none: 'None' },
  // The View menu's first row, which sets one lens in the query or none. The funnel names the rail
  // with the same word while the query holds that lens and nothing else.
  railNarrowTo: 'Filter',
  railNarrowToValues: { all: 'All', running: 'Running', active: 'Active', unread: 'Unread', input: 'Needs input' },
  // The line under the Filter row that chooses which lenses draw as quick filters, the counts
  // above the list.
  railHeadLensesName: 'Quick filters',
  railRowsName: 'Rows',
  railRowsComfortable: 'Full',
  railRowsCompact: 'Compact',
  railRowsComfortableHint: 'Draw each session with its figures and labels',
  railRowsCompactHint: 'Draw each session on one line',
  railFilterPresets: 'Saved filters',
  railFilterShow: 'Show',
  railShowArchived: 'Show archived',
  railShowRuns: 'Show run by agents',
  railFilterLabels: 'Labels',
  railFilterLabelsMore: 'more',
  railMoreShow: 'Show',
  railMoreIn: 'in',
  railFilterLabelsFewer: 'Fewer labels',
  railFilterLabelsNone: "No labels yet. Add one from a session's Labels line.",
  railFilterSaveChanges: 'Save changes',
  railFilterSaveAsNew: 'Save as new',
  railFilterRename: 'Rename',
  railFilterDelete: 'Delete',
  railFilterDeleteConfirm: 'Delete it',
  railFilterName: 'Name',
  railFilterNameTaken: 'That filter name is already in use.',
  railFilterSave: 'Save',
  railFilterCancel: 'Cancel',
  // Opens the clause of a rail card's accessible name that carries the reader's own labels.
  // The chips are bare words. Dropped into the middle of a name they read as more of the
  // session's own title, and this word is what says they are not.
  //
  // The clause names every label the session carries, folded ones included. The fold
  // limits what the card draws and never what it holds.
  railLabelled: 'labelled',
  // The way into the label editor from a rail card's hover row. One word, because the row
  // draws two controls beside it and the name the button is announced by carries the
  // session.
  //
  // The session heading's own line reads the same word, so one press is called one thing
  // wherever the reader meets it.
  labelOpen: 'Labels',
  labelOpenDetail: 'Add or remove labels',
  // What a chip on the session heading does when it is pressed. The chip draws the label and
  // nothing else, so a reader who meets a word in a box cannot tell a control from an
  // ornament, and this is the line that says which it is.
  //
  // The name the chip is announced by is built from `railFilterTake` and the axis word, the
  // way a row of the rail's own suggestions is, so one press is called one thing wherever the
  // reader meets it.
  sessionLabelFilterDetail: 'Show only the sessions with this label',
  // What that same button says on a session carrying no label. The line is drawn on
  // every session, because the button on it is the only way into the editor the main
  // view shows, and `Labels` over an empty run of chips claims the session has some.
  // So the word names the press rather than what is beside it.
  sessionLabelsAdd: 'Add a label',
  // The press at the end of the figures of a session another session started. The row draws
  // `from` and the name of the session that started it. The hint and the name it is
  // announced by name the relation. A dispatched session says `Dispatched`, the title of the
  // section the starting session's card files it under. A subagent says `Subagent`, one of
  // what that card files under `Subagents`, and the word UI copy uses for one. Both hints
  // end in `from`, the word the row draws.
  sessionParentWord: 'from',
  sessionParentHint: { dispatched: 'Dispatched from', subagent: 'Subagent from', reader: 'Started by you from' },
  sessionParentDetail: 'Opens the session that started this one',
  sessionParentAction: 'opens that session',
  // What the editor calls itself over the session it edits. The popover is drawn clear
  // of the card it was opened from, so it names the session rather than leaving the
  // reader to read it off whatever the popover covers.
  labelHeading: 'Labels for',
  // The box at the top of the editor. It says both of the things the box does, because a
  // reader who types a name nothing matches is making one.
  labelFind: 'Find or create a label',
  // The row under the box that makes the typed name. A verb, since the row is a button and
  // the name joined to it is what the press produces.
  labelCreate: 'Create',
  // What making one also does. A label no session carries does not exist here, so the
  // press files this session under it in the same move, and the row says so rather
  // than leaving the reader to find it out from the card afterwards.
  labelCreateWhy: 'And apply it to this session',
  // The key that does the same from inside the box, drawn at the row's right-hand end.
  // Named as a word, because a glyph is read out by its Unicode name.
  labelCreateKey: 'Enter',
  // Drawn where the list would be in a workspace nobody has filed yet. It says what to do
  // rather than only that there is nothing, because the box above it is the whole way in
  // and an empty list says nothing about what that box is for.
  labelNone: 'No label yet. Type a name and press Enter to make one.',
  // Said in a heading's and a rail card's accessible name when a session's unread count is
  // known and zero. Only then: a session never parsed has no count, and zero would be a
  // claim nothing recorded.
  sessionNothingNew: 'nothing new',
  // The row under the rail's filter box, which turns what the reader typed into a section of
  // the rail under a name. Drawn only while the box holds a query, because a view over an
  // empty query is the whole rail under a second name.
  railViewSave: 'Save this filter as a view',
  // What that same box asks for once the row is pressed. The reader names the view in the box
  // they typed the filter into, so no second box opens over the one they are looking at.
  railViewName: 'Name this view',
  // How the name is filed, under the box the reader is typing it into. The row that named the
  // job is gone by then, so this line carries both the job and the key. Named as a word,
  // because a glyph is read out by its Unicode name.
  railViewNameKey: 'Name the view, then press Enter.',
  // The way back out of naming, on the control that clears the query the rest of the time. The
  // name says what the press keeps, because the box holds a name and the reader's query is the
  // thing they would be afraid of losing.
  railViewNameCancel: 'Keep the filter and save no view',
  // Drawn under a view's own heading when its query reaches no session. The heading stays
  // whatever the query finds, because it is where the view is renamed and deleted, so this line
  // says why nothing is under it.
  railViewEmpty: 'No session matches this view.',
  // The editor the rename and delete commands open. It carries those two jobs and nothing else:
  // a view's query is whatever the reader had typed when they saved it.
  railViewEdit: 'Edit view',
  railViewNameField: 'Name',
  railViewCancel: 'Cancel',
  railViewSaveAction: 'Save view',
  // Deleting takes two presses on one button. The first arms it and the word changes, so the
  // reader reads what the next press does instead of answering a dialog drawn over the view.
  railViewDelete: 'Delete this view',
  railViewDeleteConfirm: 'Delete it',
  // The editor Rename session opens on a saved rail row. The empty note matches the answer
  // the extension gives an empty name, so the reader reads one sentence for one problem.
  sessionRename: 'Rename session',
  sessionRenameField: 'Name',
  sessionRenameCancel: 'Cancel',
  sessionRenameSave: 'Save name',
  sessionRenameEmpty: 'Enter a name.',
  sessionRenamePending: 'Renaming session...',
} as const;

// A mark on a card: one character the reader can pick out of a folded list, and the word
// that says the same thing to a reader who cannot see it.

// The part of a cache-write warning its wording reads. The host's warning record carries more,
// and the panel reads the warning off the wire, so both take the wording from here.
export interface CacheWriteWarningWords {
  scope: 'main' | 'delegated';
}

// The head names the outcome and the payload names the money. `Low cache reuse` is
// cause-agnostic, so it claims less than the trigger measures. That is a deliberate trade: it
// stays true at a 3% cached share and at the boundary alike, and it needs no strict bar of its
// own, so the trigger can stay where its sample put it.
export function cacheWriteWarningCondition(warning: CacheWriteWarningWords): string {
  return warning.scope === 'main' ? 'Low cache reuse in this session' : 'Low cache reuse in delegated work';
}
