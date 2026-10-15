type Flag = readonly [syntax: string, description: string];
type Section = 'Reading' | 'Starting and sending' | 'Curating' | 'Compaction' | 'Cost' | 'Setup' | 'Dispatch';
type Route =
  | 'statusline'
  | 'windows'
  | 'sessions'
  | 'management'
  | 'compact'
  | 'label'
  | 'cost'
  | 'skills'
  | 'dispatch';

export interface Command {
  name: string;
  section: Section;
  route: Route;
  action?: string;
  help: {
    summary: string;
    synopsis: string;
    flags: readonly Flag[];
    output: readonly string[];
    refusals: readonly string[];
    example: string;
  };
}

const windowFlag: Flag = ['--window ID', 'Select this window before ARC_WINDOW or unambiguous live discovery.'];
const jsonFlag: Flag = ['--json', 'Print JSON. This command already prints JSON by default.'];
const requestFlag: Flag = [
  '--request-id ID',
  'Use a fresh selected-window hostId:ID, or retry the identical payload with its retained ID.',
];
const dryRunFlag: Flag = ['--dry-run', 'Check admission without changing session metadata.'];
const windowRefusal = 'Window selection, unavailable capabilities, or repository readiness can refuse the request.';
const argumentRefusal =
  'Unknown flags, repeated scalar flags, and missing flag values refuse before sending. Host validation can refuse request values after sending.';
const curationOutput = [
  'Host JSON: version, requestId, status, sessionId, action, requester. Refusals include reason.',
  'Applied results also include labels, pinned, archived. Host status is applied, dry-run, or refused.',
  'Unknown delivery JSON: version, status, requestId, window, reason. It omits requester and curation details.',
];

function curation(name: string, summary: string, refusal: string, flags: readonly Flag[] = []): Command {
  return {
    name,
    section: 'Curating',
    route: 'management',
    action: name,
    help: {
      summary,
      synopsis: `arc ${name} ID [--dry-run] [--window ID] [--request-id ID] [--json]${flags.length ? ' [--force]' : ''}`,
      flags: [dryRunFlag, windowFlag, requestFlag, jsonFlag, ...flags],
      output:
        name === 'archive'
          ? [
              ...curationOutput,
              'Forced host replies also include evaluatedRunStatus, captured before membership changes, or null when no listing row exists.',
            ]
          : curationOutput,
      refusals: [argumentRefusal, 'One unique scoped session ID is required.', windowRefusal, refusal],
      example: `arc ${name} SESSION_ID --dry-run --window WINDOW_ID`,
    },
  };
}

function label(action: 'add' | 'remove'): Command {
  return {
    name: `label ${action}`,
    section: 'Curating',
    route: 'management',
    action: `label-${action}`,
    help: {
      summary: action === 'add' ? 'Apply reader labels to one session.' : 'Remove reader labels from one session.',
      synopsis: `arc label ${action} ID --label NAME [--dry-run] [--window ID] [--request-id ID] [--json]`,
      flags: [
        ['--label NAME', 'Apply or remove this label. Repeat for more labels.'],
        dryRunFlag,
        windowFlag,
        requestFlag,
        jsonFlag,
      ],
      output: curationOutput,
      refusals: [argumentRefusal, 'One unique scoped session ID and at least one label are required.', windowRefusal],
      example: `arc label ${action} SESSION_ID --label Review --dry-run --window WINDOW_ID`,
    },
  };
}

function compact(action: 'request' | 'status'): Command {
  const request = action === 'request';
  return {
    name: `compact ${action}`,
    section: 'Compaction',
    route: 'compact',
    help: {
      summary: request
        ? 'Request compaction of this session after its current turn.'
        : 'Observe a compaction request without submitting work.',
      synopsis: `arc compact ${action}${request ? ' --self --after-turn' : ''} --request-id WINDOW:UUID --window WINDOW --json`,
      flags: [
        ...(request
          ? ([
              ['--self', 'Compact only the requesting main agent session.'],
              ['--after-turn', 'Wait for this turn to succeed and its final response to be saved.'],
            ] as Flag[])
          : []),
        ['--request-id WINDOW:UUID', 'Required. Use this window hostId and a lowercase UUID.'],
        ['--window WINDOW', 'Required. Must match the request ID window activation.'],
        ['--json', 'Required. Print the compaction outcome.'],
      ],
      output: [
        'JSON: requestId, state, and reason when available. Admitted outcomes include admission, sequence, provider, sessionId, childGeneration, turn, toolId, submissionId, readerRevision. Local outcomes also include version and window.',
        'State is queued, started, completed, cancelled, refused, failed, uncertain, or unavailable.',
        ...(request ? ['After uncertain admission, observe this ID. Never retry or switch transports.'] : []),
      ],
      refusals: [
        argumentRefusal,
        'All synopsis flags are required. Window and UUID syntax must match.',
        ...(request
          ? [
              'Admission requires this live foreground tool call in the hosted main session, with no open asks or queued reader input.',
              'Missing readiness or reader intervention refuses or cancels compaction.',
            ]
          : ['A missing request or unavailable window reports unavailable.']),
      ],
      example: `arc compact ${action}${request ? ' --self --after-turn' : ''} --request-id WINDOW_ID:aaaaaaaa-1111-2222-3333-444444444444 --window WINDOW_ID --json`,
    },
  };
}

export const COMMANDS: readonly Command[] = [
  ...(['install', 'update', 'remove'] as const).map((action): Command => ({
    name: `skills ${action}`,
    section: 'Setup',
    route: 'skills',
    action,
    help: {
      summary: `${action === 'install' ? 'Install' : action === 'update' ? 'Update' : 'Remove'} the personal Arc session skill.`,
      synopsis: `arc skills ${action} --agent claude|codex [--agent claude|codex]`,
      flags: [['--agent claude|codex', 'Select a default personal skill directory. Repeat for both agents.']],
      output: [
        'JSON reports each destination independently. Exit 1 means incomplete work. Exit 2 means invalid arguments.',
      ],
      refusals: [
        'Foreign, linked, edited, added, or uncertain owned files remain unchanged. Custom Claude roots are unsupported.',
      ],
      example: `arc skills ${action} --agent claude --agent codex`,
    },
  })),
  ...['result', 'status', 'wait', 'claim', 'ack', 'refresh', 'recover', 'monitor'].map((action): Command => ({
    name: `dispatch ${action}`,
    section: 'Dispatch',
    route: 'dispatch',
    action,
    help: {
      summary: (
        {
          result: 'Read one frozen dispatch report and its saved disposition.',
          status: 'List one bounded page of dispatch events.',
          wait: 'Wait for a dispatch observation until the deadline or disconnect.',
          claim: 'Claim one dispatch event or recover the same owner token.',
          ack: 'Save the disposition for one claimed dispatch event.',
          refresh: 'Publish changed private report observations without sending input.',
          recover: 'Observe retained hosted delivery without sending input.',
          monitor: 'Report unavailable standalone monitoring.',
        } as Record<string, string>
      )[action],
      synopsis: `arc dispatch ${action} LAUNCH_ID${['result', 'claim', 'ack', 'recover'].includes(action) ? ' --event EVENT_ID' : ''}${['claim', 'ack'].includes(action) ? ' --origin ORIGIN_ID --owner OWNER_ID' : ''}${action === 'ack' ? ' --token TOKEN --outcome-file FILE' : ''} [--json]`,
      flags: [
        ...(['status', 'refresh'].includes(action)
          ? ([
              ['--cursor CURSOR', 'Continue with the previous page next value.'],
              ['--limit 1-128', 'Maximum events on this page. Default: 32.'],
            ] as Flag[])
          : []),
        ...(action === 'wait'
          ? ([
              ['--deadline-ms MILLISECONDS', 'Wait 1 through 110000 milliseconds. The default is 110000.'],
              windowFlag,
            ] as Flag[])
          : []),
        ...(['result', 'claim', 'ack', 'recover'].includes(action)
          ? ([['--event EVENT_ID', 'Select this exact immutable event.']] as Flag[])
          : []),
        ...(['claim', 'ack'].includes(action)
          ? ([
              ['--origin ORIGIN_ID', 'Match the launch activation.'],
              ['--owner OWNER_ID', 'Retain one processing owner and its claim token.'],
            ] as Flag[])
          : []),
        ...(action === 'ack'
          ? ([
              ['--token TOKEN', 'Use the token for this owner and exact event.'],
              ['--outcome-file FILE', 'Save a UTF-8 disposition from a regular file up to 16 KiB.'],
            ] as Flag[])
          : []),
        jsonFlag,
      ],
      output: [
        'JSON stays below 48 KiB. Result text above 16000 characters returns its private path, digest, and byte size.',
        'Saved reports remain readable without a host or known cost. Recover sends no input. Hosted monitor and standalone recovery are unavailable.',
      ],
      refusals: [
        'Malformed or replaced identities and conflicting claims or acknowledgments refuse.',
        'Wait requires a launch created with --completion wait. Disconnect reports uncertain without replacing its worker.',
      ],
      example: `arc dispatch ${action} LAUNCH_ID${['result', 'claim', 'ack', 'recover'].includes(action) ? ' --event EVENT_ID' : ''}${['claim', 'ack'].includes(action) ? ' --origin ORIGIN_ID --owner OWNER_ID' : ''}${action === 'ack' ? ' --token TOKEN --outcome-file disposition.md' : ''} --json`,
    },
  })),
  {
    name: 'statusline',
    section: 'Reading',
    route: 'statusline',
    help: {
      summary: 'Render one Claude Code status-line JSON object from stdin.',
      synopsis: 'arc statusline [--json | --next-turn] [--width COLUMNS]',
      flags: [
        ['--json', 'Print a schema version 1 status snapshot.'],
        ['--next-turn', 'Print only the next-turn starting-price segment.'],
        [
          '--width COLUMNS',
          'Use a positive column count rounded down, before COLUMNS. Invalid values mean unlimited width.',
        ],
      ],
      output: [
        'Default: text with context, cache, next-turn price, and available model, workspace, session, and account limits.',
        'JSON: schemaVersion, source, model, workspace, session, context, cache, nextTurn, limits. Unavailable figures are null.',
      ],
      refusals: [
        'Empty stdin, malformed JSON, or a value other than an object fails.',
        '--json and --next-turn cannot combine. Other unknown arguments are ignored.',
      ],
      example: 'arc statusline --json < claude-status.json',
    },
  },
  {
    name: 'windows',
    section: 'Reading',
    route: 'windows',
    help: {
      summary: 'List running Arc windows and readiness.',
      synopsis: 'arc windows [--json]',
      flags: [['--json', 'Print JSON instead of a human-readable window listing.']],
      output: [
        'JSON: version, windows, complete, optional diagnostics. Each window contains hostId, pid, version, folders, scopeReady, panelReady, panelVisible, optional capabilities.',
        'Diagnostics contain observed ENOENT, EACCES, or EPERM, a registry or connection stage, and an optional hostId.',
        'Incomplete discovery leaves complete false. Output excludes channel addresses and tokens.',
      ],
      refusals: ['Unknown arguments or more than one --json fail.'],
      example: 'arc windows --json',
    },
  },
  {
    name: 'sessions',
    section: 'Reading',
    route: 'sessions',
    help: {
      summary: 'List one bounded page of repository sessions without marking turns read.',
      synopsis: 'arc sessions [--query QUERY] [--limit 1-128] [--cursor CURSOR] [--window ID] [--json]',
      flags: [
        [
          '--query QUERY',
          'Filter by session:, agent:, title:, label:, is:archived, or is:agentrun. Repeat the query on every page.',
        ],
        ['--limit 1-128', 'Maximum rows on this page. Default: 128.'],
        ['--cursor CURSOR', 'Pass the previous page next value unchanged. A reload or changed query expires it.'],
        windowFlag,
        jsonFlag,
      ],
      output: [
        'JSON: version, requester, sessions, complete, notes, next, coverage, freshness.',
        'Rows include source, id, provider, path, ambiguous, name, setup, labels, pinned, archived, runStatus, attention, lastActivity, parent, agentRun, facts, truncated.',
        'Follow next until null. Preserve coverage and freshness independently of pagination.',
      ],
      refusals: [
        argumentRefusal,
        'Queries accept at most 200 characters. Use filter for live statuses and other search areas.',
        'Modified or expired cursors refuse. Restart without --cursor.',
        windowRefusal,
      ],
      example: 'arc sessions --query "session:claude:one OR session:codex:two" --window WINDOW_ID --json',
    },
  },
  {
    name: 'session',
    section: 'Reading',
    route: 'sessions',
    help: {
      summary: 'Read bounded recent turns without marking them read.',
      synopsis: 'arc session ID [--turns 1-20] [--window ID] [--json]',
      flags: [['--turns 1-20', 'Read this many newest turns. Default: 5.'], windowFlag, jsonFlag],
      output: [
        'JSON: version, requester, id, provider, state, turns, partial, readByteLimit, notes.',
        'Turns contain promptId, startedAt, endedAt, prompt, summary, model, effort, finished, interrupted, error.',
        'An eligible owning requester receives observation for send. Eligible current replies include readObservation for delivered completed turns. Stale reads return no turns.',
      ],
      refusals: [
        argumentRefusal,
        'One unique scoped session ID is required. File paths do not select a source.',
        windowRefusal,
      ],
      example: 'arc session SESSION_ID --turns 5 --window WINDOW_ID --json',
    },
  },
  {
    name: 'read',
    section: 'Reading',
    route: 'management',
    action: 'read',
    help: {
      summary: "Acknowledge delivered completed turns at the reader's request.",
      synopsis: 'arc read ID --observation TOKEN --request-id WINDOW:REQUEST [--dry-run] [--window ID] [--json]',
      flags: [
        ['--observation TOKEN', 'Copy readObservation from the bounded session reply.'],
        requestFlag,
        dryRunFlag,
        windowFlag,
        jsonFlag,
      ],
      output: [
        'JSON: version, requestId, status, sessionId, requester, marked, reason.',
        'Status is applied, dry-run, refused, or unknown. Completed delivered identities alone are acknowledged.',
      ],
      refusals: [
        argumentRefusal,
        windowRefusal,
        'An explicit request ID, sessionRead capability, native requester identity, and current receipt are required.',
      ],
      example:
        'arc read SESSION_ID --observation READ_OBSERVATION --request-id WINDOW_ID:read --window WINDOW_ID --json',
    },
  },
  {
    name: 'setups',
    section: 'Starting and sending',
    route: 'management',
    action: 'setups',
    help: {
      summary: 'List runtime settings and reusable setup keys.',
      synopsis: 'arc setups [--window ID] [--json]',
      flags: [windowFlag, jsonFlag],
      output: [
        'JSON: version, project, primary, inherited, pinned, recent, agents, words. project identifies the project.',
        'Optional owner is a setup selection generation token.',
        'Rows supply a key and profile. Agents supply offered model, effort, and permission values.',
      ],
      refusals: [argumentRefusal, 'Positional arguments refuse.', windowRefusal],
      example: 'arc setups --window WINDOW_ID --json',
    },
  },
  {
    name: 'start',
    section: 'Starting and sending',
    route: 'management',
    action: 'start',
    help: {
      summary: 'Start requested work with reader ownership by default.',
      synopsis: 'arc start --prompt-file PATH (--setup KEY | --provider claude|codex) [OPTIONS]',
      flags: [
        ['--prompt-file PATH', 'Required. Read a regular UTF-8 file up to 48 KiB.'],
        ['--setup KEY', 'Use a reusable setup key returned by setups.'],
        ['--provider claude|codex', 'Choose a provider instead of --setup.'],
        ['--model MODEL', 'Choose a supported model with --provider. Omission retains the provider default.'],
        ['--effort EFFORT', 'Choose supported effort with --provider. Omission retains the provider default.'],
        ['--permissions MODE', 'Choose supported permissions with --provider. Omission retains the provider default.'],
        [
          '--read-only',
          'Keep immutable launch restrictions. Codex denies filesystem writes. Claude restricts tools and git commands but can approve shell writes. See docs/agent-protocols.md#hosted-read-only-launches.',
        ],
        [
          '--cwd DIR',
          'Use an existing folder in the selected window\u2019s open project or registered worktrees. Default: first window folder.',
        ],
        [
          '--read-tool EXACT_MCP_TOOL',
          'Allow this exact MCP tool with Claude --read-only. Repeat for more tools. Both shells stay denied.',
        ],
        [
          '--agent-run[=true|false]',
          'Omitted or false keeps reader ownership and Prompt box continuation. Bare or true files delegated work under Run by agents.',
        ],
        ['--name NAME', 'Name the new session.'],
        ['--label NAME', 'Apply an initial reader label. Repeat for more labels.'],
        ['--pinned', 'Pin the new session.'],
        ['--arc-dispatch', 'Record the requesting session for guarded follow-ups and print its dispatch receipt.'],
        [
          '--completion manual|wait',
          'With --arc-dispatch, select retained retrieval or waited completion. The default is manual.',
        ],
        [
          '--report-file PATH',
          'With --arc-dispatch, copy reports to this alias. Private reports remain authoritative.',
        ],
        windowFlag,
        requestFlag,
        jsonFlag,
      ],
      output: [
        'Host JSON: version, requestId, status, requester. Accepted results include sessionId, provider, requestedSetup, agentRun, errors, and launchId for dispatch. Refusals include reason.',
        'Host status is accepted, accepted-with-errors, or refused. Requested settings do not establish observed execution.',
        'Unknown delivery JSON: version, status, requestId, window, reason. It omits requester and accepted-result details.',
        '--arc-dispatch adds ARC_DISPATCH_SESSION after an accepted result with a session ID. Reader-owned receipts include owned: true.',
      ],
      refusals: [
        argumentRefusal,
        'Classification accepts only literal true or false and cannot repeat across bare and equals forms.',
        '--setup cannot combine with explicit provider, model, effort, or permissions.',
        'Empty prompts, slash commands, oversized files or encoded requests, and unsupported setups refuse launch.',
        'A guarded start refuses ambiguous native requester identity.',
        'Read-only starts refuse permission overrides. MCP read tools require Claude read-only and exact names.',
        windowRefusal,
      ],
      example: 'arc start --setup SETUP_KEY --prompt-file prompt.txt --name Review --arc-dispatch --window WINDOW_ID',
    },
  },
  {
    name: 'send',
    section: 'Starting and sending',
    route: 'management',
    action: 'send',
    help: {
      summary: 'Deliver one follow-up to an idle session this requester started with --arc-dispatch.',
      synopsis: 'arc send ID --prompt-file PATH --observation OBSERVATION --request-id ID [--window ID] [--json]',
      flags: [
        ['--prompt-file PATH', 'Required. Read a regular UTF-8 file up to 48 KiB.'],
        [
          '--observation OBSERVATION',
          'Required. Copy from the newest eligible session --json reply to this requester.',
        ],
        requestFlag,
        windowFlag,
        ['--json', 'Print delivery fields instead of the reason and request ID.'],
      ],
      output: [
        'JSON: version when supplied by the host, status, requestId, payloadSha256, nativeTurnId, reason.',
        'Accepted confirms prompt receipt. Refused means no input. Unknown blocks further sends until reader intervention.',
      ],
      refusals: [
        argumentRefusal,
        'One session ID, prompt file, observation, and explicit request ID are required.',
        'Missing or ambiguous native requester identity, stale observations, unavailable ownership, or a busy session refuses input.',
        'Empty prompts, slash commands, oversized files or encoded requests refuse.',
        windowRefusal,
      ],
      example:
        'arc send SESSION_ID --prompt-file followup.txt --observation OBSERVATION --request-id WINDOW_ID:followup --window WINDOW_ID --json',
    },
  },
  {
    name: 'filter',
    section: 'Curating',
    route: 'sessions',
    help: {
      summary: 'Reveal Arc and replace its session list query.',
      synopsis: 'arc filter QUERY | arc filter --query QUERY | arc filter --clear [--window ID] [--json]',
      flags: [
        ['--query QUERY', 'Use this query instead of a positional query. Cannot combine with QUERY or --clear.'],
        ['--clear', 'Clear the query and restore All sessions. Cannot combine with QUERY.'],
        windowFlag,
        jsonFlag,
      ],
      output: [
        'JSON: version, status, and reason when available. Status is applied, failed, or unknown.',
        'Applied confirms browser application and persistent save. Read the panel before retrying unknown.',
        'Queries support session:ID, provider-qualified identities, OR groups, title:, label:, agent:, is:, find:, in:, cost:, and cache-expiry:.',
      ],
      refusals: [
        argumentRefusal,
        'Supply one nonempty positional query, one --query QUERY, or --clear. Queries accept at most 200 characters and must use valid session list syntax.',
        windowRefusal,
      ],
      example: 'arc filter "session:claude:one OR session:codex:two" --window WINDOW_ID --json',
    },
  },
  {
    name: 'label',
    section: 'Curating',
    route: 'label',
    help: {
      summary: 'Apply or remove reader labels.',
      synopsis: 'arc label add|remove ID --label NAME [OPTIONS]',
      flags: [],
      output: ['Use label add --help or label remove --help for flags and JSON fields.'],
      refusals: ['A label action must be add or remove.'],
      example: 'arc label add SESSION_ID --label Review --dry-run',
    },
  },
  label('add'),
  label('remove'),
  curation('pin', 'Pin one session.', 'Archived sessions refuse pin. Unarchive the session first.'),
  curation('unpin', 'Unpin one session.', 'Unavailable session metadata or saving refuses the change.'),
  curation(
    'archive',
    'Archive one session and remove its pin.',
    'Running, Needs input, completed unread, hidden, or unavailable state requires --force. Known subagents or background work refuses even with force.',
    [['--force', 'Admit the listed attention and running-state refusals only with explicit reader authority.']],
  ),
  curation(
    'unarchive',
    'Return one session to the active session list without pinning it.',
    'Unavailable session metadata or saving refuses the change.',
  ),
  {
    name: 'compact',
    section: 'Compaction',
    route: 'compact',
    help: {
      summary: 'Request or observe self-compaction.',
      synopsis: 'arc compact request|status [OPTIONS]',
      flags: [],
      output: ['Use compact request --help or compact status --help for required flags and JSON fields.'],
      refusals: ['A compaction action must be request or status.'],
      example: 'arc compact status --help',
    },
  },
  compact('request'),
  compact('status'),
  {
    name: 'cost',
    section: 'Cost',
    route: 'cost',
    help: {
      summary: 'Estimate saved Claude or Codex session costs from disk without a running window.',
      synopsis: 'arc cost TARGET [OPTIONS]',
      flags: [
        ['--since TIME', 'Include requests at or after an ISO 8601 instant with Z or an explicit offset.'],
        ['--until TIME', 'Exclude requests at or after this instant. Must be at or after --since.'],
        ['--projects PATH', 'Select the Claude projects root before ARC_PROJECTS_ROOT.'],
        ['--codex-sessions PATH', 'Select the Codex sessions root before ARC_CODEX_ROOT.'],
        ['--by-model', 'Add modelCosts to each parent and child summary.'],
        ['--source-only', 'Require an exact existing transcript path and skip child discovery.'],
        ['--by-tool-kind', 'Add parent request costs attributed to tool-result kinds.'],
        ['--until-text REGEX', 'With --by-tool-kind, add a separate result before the first matching parent request.'],
        ['--window-agent ID', 'Add a separate parent interval from the named Agent launch.'],
        jsonFlag,
      ],
      output: [
        'JSON: schemaVersion, buildCommit, source, window when bounded, parent, children, combined, rateNote, cacheExpiryNote.',
        'Optional fields: modelCosts within source summaries, byToolKind, untilText, parentWindow.',
        'Unknown full costs remain null. Priced subtotals and coverage retain available evidence. TARGET is one session ID or transcript path. Existing paths take precedence over ID discovery. Stdin is unused.',
      ],
      refusals: [
        'Unknown options, missing values, missing or multiple targets, invalid times or regex syntax, and unresolved launches fail.',
        '--source-only rejects missing paths and session IDs. --until-text requires --by-tool-kind.',
        'Unreadable files, empty files, JSON arrays, Claude stream logs, and files without native transcript records fail. Repeated options use their last value.',
      ],
      example: 'arc cost ./session.jsonl --source-only --by-model',
    },
  },
];

export function checkCommandHelp(commands: readonly Command[]): void {
  for (const command of commands) {
    const help = command.help;
    if (
      !help?.summary ||
      !help.synopsis ||
      !Array.isArray(help.flags) ||
      !help.output?.length ||
      !help.refusals?.length ||
      !help.example
    )
      throw new Error(`Missing command help: ${command.name}`);
  }
}

checkCommandHelp(COMMANDS);

export function findCommand(args: readonly string[]): Command | undefined {
  return (
    COMMANDS.find((command) => command.name === args.slice(0, 2).join(' ')) ??
    COMMANDS.find((command) => command.name === args[0])
  );
}

export function renderCommandHelp(command: Command): string {
  const help = command.help;
  return [
    `Usage: ${help.synopsis}`,
    '',
    help.summary,
    '',
    'Options:',
    ...help.flags.map(([syntax, description]) => `  ${syntax}  ${description}`),
    '  --help  Print this command help without reading stdin or contacting a window.',
    '  --version  Print the CLI version before processing any other argument.',
    '',
    'Output:',
    ...help.output.map((line) => `  ${line}`),
    '',
    'Refusals:',
    ...help.refusals.map((line) => `  ${line}`),
    '',
    'Example:',
    `  ${help.example}`,
  ].join('\n');
}

export function renderOverviewHelp(): string {
  const sections: Section[] = [
    'Reading',
    'Starting and sending',
    'Curating',
    'Compaction',
    'Cost',
    'Dispatch',
    'Setup',
  ];
  return [
    'Usage: arc COMMAND [OPTIONS]',
    '',
    'No arguments, help, or --help prints this overview. Run arc COMMAND --help for flags, output fields, refusals, and an example.',
    '--version prints the CLI version before every other argument.',
    ...sections.flatMap((section) => [
      '',
      `${section}:`,
      ...COMMANDS.filter((command) => command.section === section).map(
        (command) => `  ${command.name}  ${command.help.summary}`,
      ),
    ]),
    '',
    'Session IDs come from arc sessions. Query shorthand session:ID matches either provider. session:claude:ID and session:codex:ID select one provider.',
    'Window selection: --window, then ARC_WINDOW, then exactly one live window with complete discovery.',
  ].join('\n');
}
