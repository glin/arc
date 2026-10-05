import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(join(process.argv[2], 'src/sessioncost.mjs')).href);
const directory = fs.mkdtempSync(join(os.tmpdir(), 'arc-billing-qualification-'));
const at = (n) => new Date(Date.UTC(2026, 8, 26, 0, 0, 0, n)).toISOString();
const usage = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12 };
function read(records, name, report = false) {
  const file = join(directory, `rollout-2026-09-26T00-00-00-${name}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { requests: mod.readSessionRequests(file), report: report ? mod.sessionCostReport(file, { roots: { codexSessions: directory } }) : null };
}
const opening = [{ type: 'session_meta', timestamp: at(0), payload: { id: 'parent', source: 'cli', model_provider: 'openai' } }];
try {
  const ordinary = read([
    ...opening,
    { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'ordinary' } },
    { type: 'turn_context', timestamp: at(2), payload: { turn_id: 'ordinary', model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(3), payload: { response_id: 'ordinary-bill', turn_id: 'ordinary', usage } },
  ], 'ordinary', true);
  const pending = [...opening, { type: 'event_msg', timestamp: at(1), payload: { type: 'task_started', turn_id: 'first' } }];
  for (let index = 0; index < 64; index++) pending.push({
    type: 'event_msg', timestamp: at(index + 2), payload: {
      type: 'token_count', info: { last_token_usage: usage, total_token_usage: { ...usage, input_tokens: (index + 1) * 10 } },
    },
  });
  pending.push(
    { type: 'token_usage_record', timestamp: at(67), payload: { response_id: 'bill', turn_id: 'first', usage } },
    { type: 'event_msg', timestamp: at(68), payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { ...usage, input_tokens: 650 } } } },
    { type: 'turn_context', timestamp: at(69), payload: { turn_id: 'first', model: 'gpt-6-sol' } },
  );
  const last = read(pending, 'pending').requests;
  const copied = [...opening];
  for (const id of ['original', 'copied']) copied.push(
    { type: 'event_msg', timestamp: at(copied.length), payload: { type: 'task_started', turn_id: id } },
    { type: 'turn_context', timestamp: at(copied.length + 1), payload: { turn_id: id, model: 'gpt-6-sol' } },
    { type: 'token_usage_record', timestamp: at(copied.length + 2), payload: { response_id: id, turn_id: id, usage } },
    { type: 'event_msg', timestamp: at(copied.length + 3), payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } },
  );
  for (let index = 0; index < 65; index++) copied.push({ type: 'event_msg', timestamp: at(copied.length), payload: { type: 'task_started', turn_id: `later-${index}` } });
  copied.push(
    { type: 'turn_context', timestamp: at(500), payload: { turn_id: 'copied', model: 'gpt-6-sol', current_date: '2026-08-24' } },
    { type: 'event_msg', timestamp: at(501), payload: { type: 'task_started', turn_id: 'original' } },
    { type: 'turn_context', timestamp: at(501), payload: { turn_id: 'original', model: 'gpt-5.6-terra' } },
    { type: 'token_usage_record', timestamp: at(502), payload: { response_id: 'replay', turn_id: 'original', usage } },
    { type: 'event_msg', timestamp: at(503), payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } } },
  );
  const later = read(copied, 'copied', true);
  console.log(JSON.stringify({ checks: [
    { id: 'ordinary-bill', role: 'normal', pass: ordinary.report.parent.requests === 1 },
    { id: 'pending-position', role: 'symptom', pass: last.length === 65 && !last.some((request) => request.requestKey === `codex:first:${Date.parse(at(68))}:65`) },
    { id: 'copied-snapshot', role: 'symptom', pass: later.requests.filter((request) => !request.evidenceOnly).map((request) => request.requestKey).join(',') === 'codex-billing:original' && later.report.parent.requests === 1 },
  ] }));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
