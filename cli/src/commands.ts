type Flag = readonly [syntax: string, description: string];
type Section = 'Reading' | 'Starting and sending' | 'Curating' | 'Compaction' | 'Cost' | 'Setup' | 'Dispatch';
type Route =
  | 'collect'
  | 'statusline'
  | 'windows'
  | 'sessions'
  | 'management'
  | 'compact'
  | 'label'
  | 'cost'
  | 'skills'
  | 'run'
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

const windowFlag: Flag = ['--window ID', 'Select this window before ARC_WINDOW or automatic terminal ownership.'];
const jsonFlag: Flag = ['--json', 'Print JSON. This command already prints JSON by default.'];
const readJsonFlag: Flag = ['--json', 'Print structured fields instead of readable text.'];
const requestFlag: Flag = [
  '--request-id ID',
  'Use a fresh selected-window hostId:ID, or retry the identical payload with its retained ID.',
];
const dryRunFlag: Flag = ['--dry-run', 'Check admission without changing session metadata.'];
const curationDryRunFlag: Flag = [
  dryRunFlag[0],
  `${dryRunFlag[1]} Arc retains no dry-run result, so a retry checks again and the ID stays free for a later write.`,
];
const windowRefusal = 'Window selection, unavailable capabilities, or repository readiness can refuse the request.';
const curationOutput = [
  'JSON status is applied, dry-run, refused, or unknown. Keep requestId and window after unknown delivery.',
  'Applied replies include labels, pinned, and archived. Refusals include reason.',
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
      flags: [curationDryRunFlag, windowFlag, requestFlag, jsonFlag, ...flags],
      output:
        name === 'archive'
          ? [
              ...curationOutput,
              'Forced host replies also include evaluatedRunStatus, captured before membership changes, or null when no listing row exists.',
            ]
          : curationOutput,
      refusals: ['One unique scoped session ID is required.', windowRefusal, refusal],
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
        curationDryRunFlag,
        windowFlag,
        requestFlag,
        jsonFlag,
      ],
      output: curationOutput,
      refusals: ['One unique scoped session ID and at least one label are required.', windowRefusal],
      example: `arc label ${action} SESSION_ID --label Review --dry-run --window WINDOW_ID`,
    },
  };
}

function compact(action: 'request' | 'status' | 'cancel'): Command {
  const request = action === 'request';
  const cancel = action === 'cancel';
  if (cancel)
    return {
      name: 'compact cancel',
      section: 'Compaction',
      route: 'compact',
      help: {
        summary: 'Cancel a compaction request this session made before Arc sends it.',
        synopsis: 'arc compact cancel --self --request-id WINDOW:UUID --window WINDOW --json',
        flags: [
          ['--self', 'Cancel only a request of the session that runs this command.'],
          ['--request-id WINDOW:UUID', 'Required. Use the ID of the admitted request.'],
          ['--window WINDOW', 'Required. Must match the request ID window activation.'],
          ['--json', 'Required. Print the cancel outcome.'],
        ],
        output: [
          'JSON: the request record with state cancelled and its reason, or state refused with code and reason.',
          'A request that already stopped returns its record unchanged.',
          'A lost reply reports unavailable. Read compact status for the request then.',
        ],
        refusals: [
          'All synopsis flags are required. Window and UUID syntax must match.',
          'Arc must see this command run as a live native tool call in the requesting session.',
          'A request of another session, a request Arc already sent, and an unknown ID refuse.',
        ],
        example:
          'arc compact cancel --self --request-id WINDOW_ID:aaaaaaaa-1111-2222-3333-444444444444 --window WINDOW_ID --json',
      },
    };
  return {
    name: `compact ${action}`,
    section: 'Compaction',
    route: 'compact',
    help: {
      summary: request
        ? 'Request compaction of this session after its current turn.'
        : 'Observe a compaction request without submitting work.',
      synopsis: request
        ? "arc compact request --self --after-turn [--continuation-file 'ABSOLUTE_PATH' --continuation-sha256 SHA256] --request-id WINDOW:UUID --window WINDOW --json"
        : 'arc compact status --request-id ORIGINAL_WINDOW:UUID --window CURRENT_WINDOW --json',
      flags: [
        ...(request
          ? ([
              ['--self', 'Compact only the session that runs this command.'],
              ['--after-turn', 'Wait for this turn to end and the session to go idle.'],
              [
                '--continuation-file ABSOLUTE_PATH',
                'Optional exact UTF-8 next-turn prompt, at most 8192 bytes. Use forward slashes and single quotes.',
              ],
              ['--continuation-sha256 SHA256', 'Required with --continuation-file. Supply its lowercase SHA-256.'],
            ] as Flag[])
          : []),
        [
          '--request-id WINDOW:UUID',
          request
            ? 'Required. Use this window hostId and a lowercase UUID.'
            : 'Required. Keep the original admitting window and request UUID.',
        ],
        [
          '--window WINDOW',
          request
            ? 'Required. Must match the request ID window activation.'
            : 'Required. Select the current window serving the original request.',
        ],
        ['--json', 'Required. Print the compaction outcome.'],
      ],
      output: [
        'JSON: requestId, state, and reason when available. Admitted outcomes include admission, sequence, provider, sessionId, childGeneration, turn, toolId, submissionId, readerRevision. Local outcomes also include version and window.',
        'State is queued, started, completed, cancelled, refused, failed, uncertain, or unavailable.',
        'A continuation has separate state and sequence, exact text, sha256, write outcome, nativeTurnId, and reason. Completed compaction does not establish continuation acceptance.',
        ...(request ? ['After uncertain admission, observe this ID. Never retry or switch transports.'] : []),
      ],
      refusals: [
        'All synopsis flags are required. Window and UUID syntax must match.',
        ...(request
          ? [
              'Admission requires the launch token of a live session this window holds, or this live native tool call in a hosted session.',
              'Each turn holds one pending request. Repeated requests use fresh IDs and preserve existing task limits.',
              'Without a token, missing readiness after 30 seconds refuses compaction. A reader prompt carries an admitted request to the turn that answers it. Queue changes keep it. Stop and other cancelling reader actions cancel it.',
              'compact cancel drops an admitted request.',
            ]
          : ['A missing request or unavailable window reports unavailable.']),
      ],
      example: `arc compact ${action}${request ? ' --self --after-turn' : ''} --request-id WINDOW_ID:aaaaaaaa-1111-2222-3333-444444444444 --window WINDOW_ID --json`,
    },
  };
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'collect',
    section: 'Reading',
    route: 'collect',
    help: {
      summary: 'Collect scoped listing pages and optional recent turns without changing session state.',
      synopsis: 'arc collect --window ID [--query QUERY] [--turns 1-20] [OPTIONS]',
      flags: [
        ['--window ID', 'Required unless ARC_WINDOW supplies the selected activation. No automatic window discovery.'],
        ['--query QUERY', 'Use the production sessions query, unchanged on every page.'],
        ['--turns 1-20', 'Read recent turns for eligible rows. Omission reads listing pages only.'],
        ['--limit 1-128', 'Maximum rows per listing page. Default: 128.'],
        ['--max-pages 1-64', 'Maximum listing requests, including retries and restarts. Default: 64.'],
        ['--max-reads 0-32', 'Maximum turn requests, including retries. Requires --turns. Default: 32.'],
        ['--deadline-ms 1-60000', 'Stop admitting new requests after this interval. Default: 60000.'],
        jsonFlag,
      ],
      output: [
        'Version 1 JSON preserves raw pages and reads, usable row references, outcomes, selection, limits, and listing status.',
        'Traversal end, discovery coverage, freshness, and turn outcomes remain separate. Source order establishes no priority.',
        'Two concurrent turn requests and eight MiB of output bound collection. Admission expiry permits started requests to settle.',
        'Turn replies cannot establish physical source continuity with listing rows. Costs and report policy stay with the caller.',
      ],
      refusals: [
        'Missing explicit selection fails before requests. No window switching occurs.',
        'Unknown failures preserve prior observations and stop the affected collection path.',
      ],
      example: 'arc collect --window WINDOW_ID --query "-is:archived" --turns 2 --max-reads 2 --json',
    },
  },
  {
    name: 'run',
    section: 'Starting and sending',
    route: 'run',
    help: {
      summary: 'Start one standalone session without an Arc window.',
      synopsis: 'arc run --provider claude|codex --cwd DIR --model MODEL --effort EFFORT --prompt-file FILE [OPTIONS]',
      flags: [
        ['--provider claude|codex', 'Select the provider explicitly.'],
        ['--cwd DIR', 'Use an existing directory. Arc creates no worktree.'],
        ['--model MODEL', 'Required. Select the provider model.'],
        ['--effort EFFORT', 'Required. Select low, medium, high, xhigh, max, or ultra.'],
        ['--prompt-file FILE', 'Read a regular UTF-8 prompt file up to 48 KiB.'],
        [
          '--read-only',
          'Use shared provider restrictions. Claude auto mode does not guarantee filesystem immutability.',
        ],
        ['--read-tool TOOL', 'Allow one exact Claude MCP read tool. Repeat for more tools.'],
        ['--permissions MODE', 'Choose writable provider permissions. Refuses with --read-only.'],
        ['--add-dir DIR', 'Add an existing read directory. Repeat for more directories.'],
        ['--name NAME', 'Name the standalone launch and Claude background session.'],
        ['--arc-dispatch', 'Print a native session receipt after launch JSON when accepted identity is available.'],
        [
          '--agent-run[=true|false]',
          'Retain explicit launch classification. Delegated Claude defaults its cache TTL to 5m.',
        ],
        [
          '--service-tier default|fast|priority|ultrafast',
          'Select a Codex service tier. Omission inherits. Unavailable tiers refuse.',
        ],
        [
          '--cache-lifetime 5m|1h',
          'Set the Claude prompt cache lifetime. Overrides the caller environment. Default: 5m for Run by agents, provider default otherwise.',
        ],
        [
          '--completion manual|wait',
          'Select one completion route. Default: manual. Wait ends after 110000 milliseconds.',
        ],
        ['--report-file FILE', 'Copy the frozen report to this alias. --output is an alternative spelling.'],
        ['--output FILE', 'Alternative to --report-file. Never combine both.'],
        [
          '--log FILE',
          'Watch print output or Claude native logs. Codex defaults to the log file stem plus .last.md beside this path.',
        ],
        [
          '--attach',
          'Open a reader-owned session in a supported terminal. Refuses Claude read-only, waited completion, and Codex --log, --output, or --report-file.',
        ],
        jsonFlag,
      ],
      output: [
        'JSON identifies the launch receipt. Result and status remain readable after editor shutdown.',
        'Claude read-only uses print mode. Writable Claude uses --bg. Codex uses exec or an attended interactive session.',
        'Claude refuses a --bg launch in a directory it does not trust. Trust in a directory does not cover a repository nested inside it.',
        'CLAUDE_BIN and CODEX_BIN override executable selection. Without --cache-lifetime, a caller cache TTL remains intact.',
      ],
      refusals: [
        'Missing explicit settings, worktree flags, invalid prompts, and unavailable launch directories refuse before spawning.',
        '--cache-lifetime refuses other values and Codex launches.',
        'Callback delivery requires proven original parent authority on a supported daemon and is unavailable. Manual and waited completion remain available.',
      ],
      example:
        'arc run --provider codex --cwd . --model gpt-6.1-sol --effort high --read-only --prompt-file review.md --completion wait --json',
    },
  },
  ...(['logs', 'attach', 'stop', 'rm'] as const).map((action): Command => ({
    name: `dispatch ${action}`,
    section: 'Dispatch',
    route: 'management',
    action: `standalone-${action}`,
    help: {
      summary:
        action === 'logs'
          ? 'Read live Claude background output.'
          : action === 'attach'
            ? 'Attach to an owned Claude background session.'
            : action === 'stop'
              ? 'Stop an owned Claude background session through Claude.'
              : 'Request removal of an owned Claude background record.',
      synopsis: `arc dispatch ${action} LAUNCH_ID`,
      flags: [],
      output:
        action === 'rm'
          ? ['Record removal is unavailable. The command changes no stored files.']
          : [
              'Native Claude output streams to this terminal. JSON confirms command completion.',
              'Worker exit remains unknown until native session evidence establishes it.',
            ],
      refusals: [
        'Requires one standalone writable Claude launch with its accepted background identity.',
        'Unowned targets, missing or ambiguous launch acknowledgments, and extra arguments refuse before starting Claude.',
        ...(action === 'rm'
          ? ['Record removal refuses until native conversation and directory preservation is established.']
          : []),
      ],
      example: `arc dispatch ${action} LAUNCH_ID`,
    },
  })),
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
          recover: 'Read the retained event and its recorded completion route.',
          monitor: 'Resume standalone observation without restarting the worker.',
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
        'Saved reports remain readable without a host or known cost. Recover sends no input. Hosted monitoring uses lifecycle observation.',
      ],
      refusals: [
        'Malformed or replaced identities and conflicting claims or acknowledgments refuse.',
        'Hosted wait requires --completion wait. Standalone wait also accepts manual completion. Disconnect reports uncertain without replacing its worker.',
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
        'JSON uses schemaVersion 1. Unavailable figures are null.',
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
          'Filter by session:, agent:, title:, label:, is:archived, or is:agentrun. Rows include archived sessions unless the query adds -is:archived. Repeat the query on every page.',
        ],
        ['--limit 1-128', 'Maximum rows on this page. Default: 128.'],
        ['--cursor CURSOR', 'Pass the previous page next value unchanged. A reload or changed query expires it.'],
        windowFlag,
        readJsonFlag,
      ],
      output: [
        'Text shows full IDs, names, state, and uncertainty. JSON includes source, path, ambiguous, truncated, and targeting fields.',
        'Follow next until null. Preserve coverage and freshness independently of pagination.',
      ],
      refusals: [
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
      flags: [['--turns 1-20', 'Read this many newest turns. Default: 5.'], windowFlag, readJsonFlag],
      output: [
        'Text shows delivered prompts and responses. JSON preserves state, partial, notes, and turn fields.',
        'An eligible owning requester receives observation for send. Eligible current replies include readObservation for delivered completed turns. Stale reads return no turns.',
      ],
      refusals: ['One unique scoped session ID is required. File paths do not select a source.', windowRefusal],
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
      flags: [windowFlag, readJsonFlag],
      output: [
        'Text lists the project, reusable setup keys, models with their efforts, and permissions.',
        'JSON provides setup keys and supported launch values. missingValue explains unavailable setups. modelsPending means discovery is loading.',
      ],
      refusals: ['Positional arguments refuse.', windowRefusal],
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
        [
          '--service-tier default|fast|priority|ultrafast',
          'Select a Codex service tier. Omission inherits. Unavailable tiers refuse.',
        ],
        [
          '--cache-lifetime 5m|1h',
          'Set the Claude prompt cache lifetime. Default: 5m for Run by agents, provider default otherwise.',
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
        'JSON includes status, requestId, and accepted sessionId. Save launchId for dispatch retrieval. Metadata reports saved labels, pin state, and pending or completed naming.',
        'An accepted start with a session ID also includes link, a Markdown session link labeled with the requested name, or null. The link is null unless four things hold. The selected window is ARC_WINDOW. The name shows visible text on one line. The name state is not failed, uncertain, or cancelled, and carries no error. The session ID is a valid link target.',
        'Host status is accepted, accepted-with-errors, or refused. Requested settings do not establish observed execution.',
        'Unknown delivery retains requestId, window, and reason. Preserve them without launching a replacement.',
        '--arc-dispatch adds ARC_DISPATCH_SESSION after an accepted result with a session ID. Reader-owned receipts include owned: true.',
      ],
      refusals: [
        'Classification accepts only literal true or false and cannot repeat across bare and equals forms.',
        '--setup cannot combine with explicit provider, model, effort, or permissions.',
        'Empty prompts, slash commands, oversized files or encoded requests, and unsupported setups refuse launch.',
        'A guarded start refuses ambiguous native requester identity.',
        'Read-only starts refuse permission overrides. MCP read tools require Claude read-only and exact names.',
        '--cache-lifetime refuses other values and Codex setups.',
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
      summary: 'Deliver a requested message or an observed follow-up.',
      synopsis:
        'arc send ID --prompt-file PATH [--queue | --observation OBSERVATION] --request-id ID [--window ID] [--json]',
      flags: [
        ['--prompt-file PATH', 'Required. Read a regular UTF-8 file up to 48 KiB.'],
        ['--queue, -q', 'Queue the message for idle delivery. Cannot combine with --observation.'],
        ['--observation OBSERVATION', 'Select parent-only continuation. Omit for ordinary reader-requested delivery.'],
        requestFlag,
        windowFlag,
        ['--json', 'Print delivery fields instead of the reason and request ID.'],
      ],
      output: [
        'JSON: version, status, requestId, payloadSha256, nativeTurnId, reason. Ordinary receipts include delivery. Queue results include queuedSubmissionId.',
        'Queued confirms durable admission. Accepted confirms prompt receipt. Unknown blocks further agent input until accepted reader direction.',
      ],
      refusals: [
        'One session ID, prompt file, and explicit request ID are required.',
        'Missing or ambiguous native requester identity refuses input. With --observation, stale observations, unavailable ownership, or a busy session refuses input.',
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
      summary: 'Request, observe or cancel self-compaction.',
      synopsis: 'arc compact request|status|cancel [OPTIONS]',
      flags: [],
      output: [
        'Use compact request --help, compact status --help or compact cancel --help for required flags and JSON fields.',
      ],
      refusals: ['A compaction action must be request, status or cancel.'],
      example: 'arc compact status --help',
    },
  },
  compact('request'),
  compact('status'),
  compact('cancel'),
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
        ['--by-tool', 'Add parent request costs attributed to tool-result kinds, with each kind split by tool.'],
        ['--until-text REGEX', 'With --by-tool, add a separate result before the first matching parent request.'],
        ['--window-agent ID', 'Add a separate parent interval from the named Agent launch.'],
        readJsonFlag,
      ],
      output: [
        'Text shows parent, children, combined, and requested breakdowns. JSON retains tokens, cache, context, and pricing evidence.',
        'Unknown full costs remain null. Priced subtotals and coverage retain available evidence. TARGET is one session ID or transcript path. Existing paths take precedence over ID discovery. Stdin is unused.',
      ],
      refusals: [
        'Unknown options, missing values, missing or multiple targets, invalid times or regex syntax, and unresolved launches fail.',
        '--source-only rejects missing paths and session IDs. --until-text requires --by-tool.',
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
    'Window selection: --window, then ARC_WINDOW, then the owning integrated terminal window. External shells require exactly one live window. Discovery must be complete. collect requires --window or ARC_WINDOW.',
  ].join('\n');
}
