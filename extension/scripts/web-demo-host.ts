import { normalizeContext, validContextDetail } from '../src/domain/context-detail.ts';
import { parseHostToPanel, parsePanelToHost } from '../src/webview/protocol.ts';
import type { PanelToHost } from '../src/webview/protocol.ts';
import type { Turn } from '../src/transcript.ts';

// Every protocol message needs an explicit demo behavior.
export const DEMO_HOST_POLICY = {
  contextDetail: 'handled',
  ready: 'handled',
  painted: 'noop',
  initialize: 'noop',
  developmentReload: 'noop',
  refresh: 'noop',
  perf: 'noop',
  goBack: 'noop',
  goForward: 'noop',
  newSession: 'noop',
  pinSetup: 'noop',
  unpinSetup: 'noop',
  refreshUsage: 'noop',
  openControl: 'noop',
  requestDefaults: 'noop',
  pick: 'noop',
  draft: 'noop',
  pathCompletion: 'handled',
  answerAsk: 'noop',
  beginFileStaging: 'noop',
  attachFiles: 'noop',
  fileReadError: 'noop',
  fileRejected: 'noop',
  removeFile: 'noop',
  sendPrompt: 'noop',
  importPromptRecovery: 'handled',
  compact: 'noop',
  dismissLive: 'noop',
  restoreLive: 'noop',
  stopTurn: 'noop',
  dequeue: 'noop',
  editQueued: 'noop',
  acceptQueuedEdit: 'noop',
  copy: 'handled',
  note: 'handled',
  armSelectedText: 'noop',
  selectedTextHandoff: 'noop',
  armSessionDetails: 'noop',
  armComposer: 'noop',
  showReaderParent: 'handled',
  showSession: 'handled',
  labelEditor: 'handled',
  setLabels: 'handled',
  setViews: 'handled',
  renameSession: 'noop',
  setRailFilters: 'handled',
  sessionMembership: 'handled',
  setLayout: 'handled',
  saveState: 'handled',
  search: 'noop',
  loadOlder: 'noop',
  openLink: 'noop',
  openVisualization: 'noop',
  openImage: 'noop',
  openTurnDiff: 'noop',
  openCommit: 'noop',
  openFile: 'noop',
  openSkill: 'noop',
} satisfies Record<PanelToHost['type'], 'handled' | 'noop'>;

export function demoContextReply(
  message: Extract<PanelToHost, { type: 'contextDetail' }>,
  sample: Pick<Turn, 'agent' | 'model' | 'contextTokens' | 'contextWindow'>,
  capturedAt: number,
) {
  const provider = sample.agent === 'codex' ? 'codex' : 'claude';
  const used = sample.contextTokens;
  const capacity = sample.contextWindow ?? 200_000;
  const model = sample.model ?? '';
  const instructions = Math.floor(used * 0.12);
  const messages = Math.floor(used * 0.35);
  const tools = Math.floor(used * 0.38);
  const categories = [
    { key: 'instructions', name: 'Instructions', tokens: instructions, relationship: 'used' as const },
    { key: 'messages', name: 'Messages', tokens: messages, relationship: 'used' as const },
    { key: 'tools', name: 'Tool results', tokens: tools, relationship: 'used' as const },
    {
      key: 'other',
      name: provider === 'codex' ? 'Unattributed context' : 'Tool definitions',
      tokens: used - instructions - messages - tools,
      relationship: 'used' as const,
    },
  ];
  const raw =
    provider === 'codex'
      ? {
          kind: 'codex-retained-context',
          basis: 'request',
          session: message.session,
          model,
          used,
          capacity,
          categories,
        }
      : {
          model,
          totalTokens: used,
          rawMaxTokens: capacity,
          categories: [
            ...categories.map((row) => ({ name: row.name, tokens: row.tokens, kind: 'used' })),
            { name: 'Free space', tokens: Math.max(0, capacity - used - Math.floor(capacity * 0.1)), kind: 'free' },
            { name: 'Compaction buffer', tokens: Math.floor(capacity * 0.1), kind: 'buffer' },
          ],
        };
  const detail = normalizeContext(raw, { ...message, provider, model, source: 'demo' }, capturedAt);
  if (!validContextDetail(detail) || detail.status !== 'available') throw new Error('Invalid demo context detail');
  return { type: 'contextDetail' as const, detail };
}

export const demoHost = {
  policy: DEMO_HOST_POLICY,
  parsePanelToHost,
  parseHostToPanel,
  contextReply: demoContextReply,
};
