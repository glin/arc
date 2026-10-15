import { discoverWindows } from '../../extension/src/sessionrequests.ts';

export async function runWindows(args: string[]): Promise<string> {
  if (args.some((arg) => arg !== '--json') || args.length > 1) {
    throw new Error('Usage: arc windows [--json]');
  }
  const { windows, complete, diagnostics } = await discoverWindows();
  if (args.includes('--json'))
    return JSON.stringify({ version: 1, windows, complete, ...(diagnostics ? { diagnostics } : {}) });
  const coverage = complete ? '' : 'Arc window discovery is incomplete. Some windows are unavailable.';
  const failures =
    diagnostics
      ?.map(({ code, stage, hostId }) => {
        const target = hostId ? ` ${hostId}` : '';
        return `${stage === 'registry' ? 'Window details' : 'Local connection'}${target}: ${code}.`;
      })
      .join('\n') ?? '';
  const status = [coverage, failures].filter(Boolean).join('\n');
  if (!windows.length) return status || 'No Arc windows are open.';
  const listing = windows
    .map((window) => {
      const panel = window.panelReady ? (window.panelVisible ? 'visible' : 'hidden') : 'not ready';
      const scope = window.scopeReady ? 'ready' : 'loading';
      const folders = window.folders.length
        ? window.folders.map((folder) => JSON.stringify(folder)).join(', ')
        : '(no folders)';
      return `${window.hostId}  scope ${scope}  panel ${panel}  ${folders}`;
    })
    .join('\n');
  return status ? `${listing}\n${status}` : listing;
}
