import { findSessionTranscript, sessionCostReport, type SessionRoots } from '../../extension/src/sessioncost.ts';

declare const ARC_BUILD_COMMIT: string;

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
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') continue;
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
  return JSON.stringify({
    schemaVersion: 2,
    buildCommit: typeof ARC_BUILD_COMMIT === 'string' ? ARC_BUILD_COMMIT : 'unknown',
    ...report,
  });
}
