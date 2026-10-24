import {
  findSessionTranscript,
  sessionCostReport,
  type SessionRoots,
  type SessionCostReport,
  type SessionCostSummary,
} from '../../extension/src/sessioncost.ts';

declare const ARC_BUILD_COMMIT: string;

function costJSON(report: SessionCostReport) {
  const { cacheExpiryNote: _cacheExpiryNote, ...output } = report;
  const tools = (detail: NonNullable<SessionCostReport['byTool']>) => {
    const { requestsNote: _requestsNote, ...values } = detail;
    return values;
  };
  return {
    schemaVersion: 3,
    buildCommit: typeof ARC_BUILD_COMMIT === 'string' ? ARC_BUILD_COMMIT : 'unknown',
    ...output,
    ...(report.byTool && { byTool: tools(report.byTool) }),
    ...(report.untilText && { untilText: { ...report.untilText, byTool: tools(report.untilText.byTool) } }),
    ...(report.parentWindow && {
      parentWindow: {
        ...report.parentWindow,
        ...(report.parentWindow.byTool && { byTool: tools(report.parentWindow.byTool) }),
      },
    }),
  };
}

function costText(report: SessionCostReport): string {
  const money = (value: number | null | undefined) => (typeof value === 'number' ? `$${value.toFixed(4)}` : 'unknown');
  const label = (value: string) => JSON.stringify(value).slice(1, -1);
  const lines = [
    `Cost: ${label(report.source.kind)} ${label(report.source.sessionId)}`,
    `Source: ${label(report.source.file)}`,
  ];
  if (report.window)
    lines.push(
      `Interval: ${report.window.since ?? '(unbounded)'} to ${report.window.until ?? '(unbounded)'} (end excluded)`,
    );
  lines.push('Scope  Requests  Full cost  Priced subtotal  Coverage');
  const summary = (name: string, value: SessionCostSummary) => {
    lines.push(
      `${label(name)}  ${value.requests}${value.requestCountExact === false ? ' (not exact)' : ''}  ${money(value.costUsd)}  ${money(value.pricedCostUsd)}  ${value.coverage ?? 'complete'}`,
    );
    if (value.estimatedCostUsd !== undefined) lines.push(`  Legacy estimate: ${money(value.estimatedCostUsd)}`);
    if (value.unpricedModels?.length) lines.push(`  Unpriced models: ${value.unpricedModels.map(label).join(', ')}`);
    if (value.coverageDefect)
      lines.push(
        `  Coverage defect: ${value.coverageDefect.kind}, ${value.coverageDefect.cause}, since ${value.coverageDefect.since ?? 'unknown'}`,
      );
    if (value.fastModeUnpricedRequests)
      lines.push(`  Fast-mode requests without prices: ${value.fastModeUnpricedRequests}`);
    if (value.failedToolCalls || value.failedToolCallRequests)
      lines.push(
        `  Failed tools: ${value.failedToolCalls ?? 'unknown'}. Requests: ${value.failedToolCallRequests ?? 'unknown'}. Attributed cost: ${money(value.failedToolCallCostUsd)}`,
      );
  };
  summary('Parent', report.parent);
  for (const child of report.children) summary(`Child ${child.kind} ${child.sessionId} (${child.file})`, child);
  summary('Combined', report.combined);
  lines.push(report.rateNote);
  for (const [name, value] of [
    ['Parent', report.parent],
    ...report.children.map((child) => [`Child ${child.sessionId}`, child] as const),
  ] as const) {
    if (value.modelCosts) {
      lines.push('', `By model: ${label(name)}`);
      for (const model of value.modelCosts) summary(model.model ?? '(model unavailable)', model);
    }
  }
  // Kind rows start at column one with their tools indented below. Numeric columns align right.
  const tools = (name: string, detail: NonNullable<SessionCostReport['byTool']>) => {
    const share = (value: number | null) => (value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`);
    const cells = [
      ['Tool', 'Requests', 'Attributed cost', 'Share'],
      ...detail.rows.flatMap((row) => [
        [label(row.kind), String(row.requests), money(row.costUsd), share(row.shareOfCost)],
        ...row.tools.map((tool) => [
          `  ${label(tool.tool)}`,
          String(tool.requests),
          money(tool.costUsd),
          share(tool.shareOfCost),
        ]),
      ]),
    ];
    const widths = cells[0].map((_, column) => Math.max(...cells.map((cell) => cell[column].length)));
    lines.push('', name);
    for (const cell of cells)
      lines.push(
        cell
          .map((value, column) => (column === 0 ? value.padEnd(widths[0]) : value.padStart(widths[column])))
          .join('  ')
          .trimEnd(),
      );
    lines.push(`Unpriced requests: ${detail.unpricedRequests}`);
  };
  if (report.byTool) tools('By tool', report.byTool);
  if (report.untilText) {
    lines.push('', `Until text: ${label(report.untilText.pattern)}. Matched: ${report.untilText.matched}`);
    if (report.untilText.note) lines.push(report.untilText.note);
    tools('Until text tools', report.untilText.byTool);
  }
  if (report.parentWindow) {
    const window = report.parentWindow;
    lines.push(
      '',
      `Agent window: ${label(window.agentIdStartRequest)}`,
      `Until: ${window.until ?? '(unbounded)'}. Requests: ${window.requests}. Full cost: ${money(window.costUsd)}`,
      `Context at start: ${window.contextAtStart ?? 'unknown'}. Peak: ${window.contextAtPeak ?? 'unknown'}`,
    );
    if (window.byTool) tools('Agent window tools', window.byTool);
  }
  return lines.join('\n');
}

export function runCost(args: string[]): string {
  const roots: SessionRoots = {};
  let target: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let byTool = false;
  let byModel = false;
  let sourceOnly = false;
  let untilText: string | undefined;
  let windowAgent: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--by-model') {
      byModel = true;
      continue;
    }
    if (arg === '--source-only') {
      sourceOnly = true;
      continue;
    }
    // `--by-tool-kind` is the former name of `--by-tool`.
    if (arg === '--by-tool' || arg === '--by-tool-kind') {
      byTool = true;
      continue;
    }
    if (['--since', '--until', '--projects', '--codex-sessions', '--until-text', '--window-agent'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--since') since = value;
      if (arg === '--until') until = value;
      if (arg === '--projects') roots.projects = value;
      if (arg === '--codex-sessions') roots.codexSessions = value;
      if (arg === '--until-text') untilText = value;
      if (arg === '--window-agent') windowAgent = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown cost option: ${arg}`);
    if (target !== undefined) throw new Error('Cost accepts one transcript target.');
    target = arg;
  }
  if (!target) throw new Error('Cost needs a session id or transcript path.');
  if (untilText && !byTool) throw new Error('--until-text requires --by-tool.');
  const file = findSessionTranscript(target, roots, sourceOnly);
  const report = sessionCostReport(file, {
    since,
    until,
    roots,
    byTool,
    untilText,
    windowAgent,
    byModel,
    sourceOnly,
  });
  return json ? JSON.stringify(costJSON(report)) : costText(report);
}
