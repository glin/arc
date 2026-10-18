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
  const toolKinds = (detail: NonNullable<SessionCostReport['byToolKind']>) => {
    const { requestsNote: _requestsNote, ...values } = detail;
    return values;
  };
  return {
    schemaVersion: 2,
    buildCommit: typeof ARC_BUILD_COMMIT === 'string' ? ARC_BUILD_COMMIT : 'unknown',
    ...output,
    ...(report.byToolKind && { byToolKind: toolKinds(report.byToolKind) }),
    ...(report.untilText && { untilText: { ...report.untilText, byToolKind: toolKinds(report.untilText.byToolKind) } }),
    ...(report.parentWindow && {
      parentWindow: {
        ...report.parentWindow,
        ...(report.parentWindow.byToolKind && { byToolKind: toolKinds(report.parentWindow.byToolKind) }),
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
  const tools = (name: string, detail: NonNullable<SessionCostReport['byToolKind']>) => {
    lines.push('', name, 'Tool kind  Requests  Attributed cost  Share');
    for (const row of detail.rows)
      lines.push(
        `${label(row.kind)}  ${row.requests}  ${money(row.costUsd)}  ${row.shareOfCost === null ? 'unknown' : `${(row.shareOfCost * 100).toFixed(1)}%`}`,
      );
    lines.push(`Unpriced requests: ${detail.unpricedRequests}`);
  };
  if (report.byToolKind) tools('By tool kind', report.byToolKind);
  if (report.untilText) {
    lines.push('', `Until text: ${label(report.untilText.pattern)}. Matched: ${report.untilText.matched}`);
    if (report.untilText.note) lines.push(report.untilText.note);
    tools('Until text tool kinds', report.untilText.byToolKind);
  }
  if (report.parentWindow) {
    const window = report.parentWindow;
    lines.push(
      '',
      `Agent window: ${label(window.agentIdStartRequest)}`,
      `Until: ${window.until ?? '(unbounded)'}. Requests: ${window.requests}. Full cost: ${money(window.costUsd)}`,
      `Context at start: ${window.contextAtStart ?? 'unknown'}. Peak: ${window.contextAtPeak ?? 'unknown'}`,
    );
    if (window.byToolKind) tools('Agent window tool kinds', window.byToolKind);
  }
  return lines.join('\n');
}

export function runCost(args: string[]): string {
  const roots: SessionRoots = {};
  let target: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let byToolKind = false;
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
    if (arg === '--by-tool-kind') {
      byToolKind = true;
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
  if (untilText && !byToolKind) throw new Error('--until-text requires --by-tool-kind.');
  const file = findSessionTranscript(target, roots, sourceOnly);
  const report = sessionCostReport(file, {
    since,
    until,
    roots,
    byToolKind,
    untilText,
    windowAgent,
    byModel,
    sourceOnly,
  });
  return json ? JSON.stringify(costJSON(report)) : costText(report);
}
