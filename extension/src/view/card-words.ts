import { COMMENT_ACTIONS } from './comments.ts';

// Shared panel control labels, accessible names and empty-state text.
// Names that depend on card contents are assembled from the corresponding card data.
export const CARD_ACTIONS = {
  // Include the comment labels imported from view/comments.
  ...COMMENT_ACTIONS,
  session: 'Session',
  composerCollapse: 'Collapse prompt box',
  composerCollapseDetail: 'Hide the prompt box and its requests, attachments, and controls. Keep its saved height.',
  composerRestore: 'Restore prompt box',
  composerRestoreDetail: 'Show the prompt box at its saved height, limited to the available space.',
  composerHeight: 'Prompt box height',
  composerHeightCollapsed: 'Prompt box height. Prompt box collapsed.',
  turnDiff: 'Open the changes',
  // The Files expansion action names the remaining file count. Its collapse action names the next press.
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
  // Codex skill entries identify files read, without establishing why the agent read them. Show this explanation once beneath the list.
  activitySkillsBestEffort: 'Codex skills are a best-effort match from the SKILL.md files that Codex read.',
  activitySkillsPopover: 'Show the skills this turn loaded',
  openCommit: 'Open this commit',
  // Distinguish prompts received while the turn ran from its opening prompt.
  askedMidTurn: 'Asked while this was running',
  // A sent prompt absent from the transcript has no confirmed pickup time. Label it separately from prompts received during the turn.
  askedJustSent: 'Just sent',
  // Keep the duration label outside the clock-updated figure. Finished turns use past tense. Running turns use present tense.
  ranFor: 'ran in',
  runningFor: 'running for',
  // Heading text that saidName combines with message and reply counts.
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
  // Long messages have separate expansion and collapse labels. Each state names the action that the next press performs.
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
  // Session heading actions name whether the next press expands or collapses the shown turns.
  expandAllTurns: 'Expand every shown turn',
  // Leads the heading hint's second line with the full local time of the session's last
  // activity, since the heading draws no age.
  lastActive: 'Last active',
  collapseAllTurns: 'Collapse every shown turn',
  // The session heading's menu offers pin, archive, labels, rename and details actions.
  sessionActions: 'Session actions',
  sessionActionsDetail: 'Pin, archive, labels, rename, and details',
  // Empty search results distinguish workspace, whole-session and partial-session searches.
  // Search reads its own window, independently of the timeline tail and loaded history pages.
  searchEmptyByScope: {
    workspace: 'No turn says that. Search reads every session in this workspace.',
    session: 'No turn in this session says that. Only the session on screen was searched.',
    sessionPart: 'No turn says that in the part of this session that search reads.',
  },
  searchWorking: 'Reading every session in this workspace...',
  // A scoped search names the selected session while it runs.
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
  // Archiving keeps the session data and moves its presentation to the Archived section.
  hideSession: 'Archive this session',
  unarchiveSession: 'Unarchive this session',
  hideSessionHint: 'Archive',
  hideSessionDetail: 'Moves it to Archived. Nothing is deleted.',
  unarchiveSessionHint: 'Unarchive',
  unarchiveSessionDetail: 'Returns it to the list',
  // Pinning keeps a session at the top of the session list. Selecting a session changes the session view.
  railPin: 'Pin this session to the top',
  railUnpin: 'Unpin this session from the top',
  railPinHint: 'Pin',
  railPinDetail: 'Keeps it at the top of the list',
  railUnpinHint: 'Unpin',
  railUnpinDetail: 'Returns it to its place by activity',
  // Identify a session started by an agent. Use the agent-name slot, with the agent included in the accessible name.
  agentRun: 'run by an agent',
  // Prefix the running duration in a compact row hover. hoverMore follows the folded-label count, as in +2 more.
  hoverFor: 'for',
  hoverMore: 'more',
  // The back-to-top control uses the same visible text and accessible name.
  toTop: 'Back to the top',
  hiddenEmpty: 'Every session is archived.',
  // Append unread to the status tooltip while the turn remains unread. The visual unread tint has no separate tooltip.
  statusUnread: 'unread',
  // Accessible name for the session list landmark. The header also draws this name when space permits.
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
  // Each filter button names its session count and the sessions its next press will show.
  railCountActive: 'Active',
  railCountSession: 'session',
  railCountSessions: 'sessions',
  railCountRunningHint: 'Show only the sessions whose agent is working now',
  railCountActiveHint: 'Show only the sessions with a live cache or activity in the last hour',
  railCountUnreadHint: 'Show only the unread sessions',
  railCountInputHint: 'Show only the sessions where an agent needs your input',
  railCountPressedHint: 'Show every session again',
  // Describe whether any Active session has a warm or expiring cache. The description states neither a cache count nor a shared state.
  railCountCacheWarm: 'Some active sessions have a warm cache.',
  railCountCacheExpiring: 'Some active sessions have a cache that is expiring.',
  railCountCacheNone: 'No active session has a warm cache.',
  // Drawn in the rail when its filter leaves nothing, so the box that caused it stays on
  // screen with the way back beside it.
  railFilterEmpty: 'No session matches.',
  // Name the filter suggestions list beneath the session list filter box.
  railFilterOffers: 'Filter suggestions',
  // Name the filter action before the suggested query term in each option.
  railFilterTake: 'Filter by',
  // A negated suggestion names the sessions its completed term excludes.
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
  // Introduce the session labels in its accessible name. Include folded labels because folding limits only the visible list.
  railLabelled: 'labelled',
  // The session list and session heading use the same label-editor action name. Accessible names also identify the session.
  labelOpen: 'Labels',
  labelOpenDetail: 'Add or remove labels',
  // A session heading label filters the session list. Its accessible name uses railFilterTake and the label query term.
  sessionLabelFilterDetail: 'Show only the sessions with this label',
  // A session with no labels names the action to add one.
  sessionLabelsAdd: 'Add a label',
  // Parent-session links identify the relationship and open the starting session. The hint ends with the visible word from.
  sessionParentWord: 'from',
  sessionParentHint: { dispatched: 'Dispatched from', subagent: 'Subagent from', reader: 'Started by you from' },
  sessionParentDetail: 'Opens the session that started this one',
  sessionParentAction: 'opens that session',
  // The label editor heading names the edited session because the popover sits outside its session card.
  labelHeading: 'Labels for',
  // The box at the top of the editor. It says both of the things the box does, because a
  // reader who types a name nothing matches is making one.
  labelFind: 'Find or create a label',
  // The cross inside a find or name box. It empties the box and keeps focus there.
  labelFindClear: 'Clear the find box',
  railFilterFindClear: 'Clear the find box',
  railFilterNameClear: 'Clear the name',
  viewNameClear: 'Clear the name',
  // The row under the box that makes the typed name. A verb, since the row is a button and
  // the name joined to it is what the press produces.
  labelCreate: 'Create',
  // Creating a label also applies it to the edited session. Unused labels have no separate stored entry.
  labelCreateWhy: 'And apply it to this session',
  // The key that does the same from inside the box, drawn at the row's right-hand end.
  // Named as a word, because a glyph is read out by its Unicode name.
  labelCreateKey: 'Enter',
  // An empty label list explains how to create the first label.
  labelNone: 'No label yet. Type a name and press Enter to make one.',
  // Use this clause only when the unread count is known and zero. An unavailable count establishes neither state.
  sessionNothingNew: 'nothing new',
  // The row under the rail's filter box, which turns what the reader typed into a section of
  // the rail under a name. Drawn only while the box holds a query, because a view over an
  // empty query is the whole rail under a second name.
  railViewSave: 'Save this filter as a view',
  // What that same box asks for once the row is pressed. The reader names the view in the box
  // they typed the filter into, so no second box opens over the one they are looking at.
  railViewName: 'Name this view',
  // The view-naming instruction supplies the action and the Enter key name beneath the field.
  railViewNameKey: 'Name the view, then press Enter.',
  // Cancel view naming without changing the captured filter.
  railViewNameCancel: 'Keep the filter and save no view',
  // Keep an empty saved view reachable for rename and deletion, with this explanation beneath its heading.
  railViewEmpty: 'No session matches this view.',
  // The editor the rename and delete commands open. It carries those two jobs and nothing else:
  // a view's query is whatever the reader had typed when they saved it.
  railViewEdit: 'Edit view',
  railViewNameField: 'Name',
  railViewCancel: 'Cancel',
  railViewSaveAction: 'Save view',
  // The first delete press arms the button and changes its label. The second press deletes the view.
  railViewDelete: 'Delete this view',
  railViewDeleteConfirm: 'Delete it',
  // The editor Rename session opens on a saved rail row. The empty note matches the answer
  // the extension gives an empty name, so the reader reads one sentence for one problem.
  sessionRename: 'Rename session',
  sessionRenameField: 'Name',
  sessionRenameCancel: 'Cancel',
  sessionRenameClear: 'Clear the name',
  sessionRenameSave: 'Save name',
  sessionRenameEmpty: 'Enter a name.',
  sessionRenamePending: 'Renaming session...',
} as const;

// The part of a cache-write warning its wording reads. The host's warning record carries more,
// and the panel reads the warning off the wire, so both take the wording from here.
export interface CacheWriteWarningWords {
  scope: 'main' | 'delegated';
}

// The cache warning identifies its scope without assigning a cause to low cache reuse.
export function cacheWriteWarningCondition(warning: CacheWriteWarningWords): string {
  return warning.scope === 'main' ? 'Low cache reuse in this session' : 'Low cache reuse in delegated work';
}
