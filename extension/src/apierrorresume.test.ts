import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  ApiErrorResumer,
  RESUME_LIMIT,
  classifyApiError,
  resumePrompt,
  type ResumeCandidate,
} from './apierrorresume.ts';
import { tempDir } from './temproot.ts';

const MINUTE = 60_000;
const BASE = Date.parse('2026-11-11T18:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * MINUTE).toISOString();
const SESSION = 'f39e1018-7945-4b3a-8aad-120853f3bcd1';

const prompt = (minutes: number, id: string, text = `prompt ${id}`) =>
  JSON.stringify({
    type: 'user',
    uuid: `u-${id}`,
    sessionId: SESSION,
    timestamp: at(minutes),
    message: { role: 'user', content: text },
  });

const answer = (minutes: number, id: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}`,
    sessionId: SESSION,
    timestamp: at(minutes),
    message: {
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'Working.' }],
      stop_reason: 'tool_use',
    },
  });

// The record Claude Code 2.1.322 wrote when a request failed on an expired certificate.
const sslError = (minutes: number, id: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `e-${id}`,
    sessionId: SESSION,
    timestamp: at(minutes),
    isSidechain: false,
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: 'API Error: Unable to connect to API: SSL certificate has expired' }],
    },
    isApiErrorMessage: true,
    error: 'server_error',
    failedResponseHadNoToolCall: true,
  });

const authError = (minutes: number, id: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `e-${id}`,
    sessionId: SESSION,
    timestamp: at(minutes),
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }],
    },
    isApiErrorMessage: true,
    error: 'authentication_failed',
  });

const minutesOf = (time: number) => (time - BASE) / MINUTE;

// A transcript on disk, a fake clock, and a delivery that appends the resume prompt as Claude records it.
// A new resumer stands for a reloaded or second editor window, because a resumer keeps nothing outside memory.
function harness(lines: string[], options: { records?: boolean } = {}) {
  const folder = tempDir('api-error-resume-');
  const file = path.join(folder, `${SESSION}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const state = {
    now: BASE,
    delivered: [] as string[],
    notices: [] as string[],
    timers: [] as number[],
    append: (...more: string[]) => fs.appendFileSync(file, `${more.join('\n')}\n`),
  };
  const candidate: ResumeCandidate = { session: SESSION, cwd: folder, file, name: 'Review branch' };
  const resumer = () =>
    new ApiErrorResumer({
      candidates: () => [candidate],
      deliver: async (_candidate, text) => {
        state.delivered.push(text);
        if (options.records !== false)
          state.append(prompt(minutesOf(state.now), `resume-${state.delivered.length}`, text));
        return { delivered: true, reason: '' };
      },
      notify: (_candidate, message) => state.notices.push(message),
      now: () => state.now,
      schedule: (_callback, delayMs) => {
        state.timers.push(delayMs);
        return { dispose: () => {} };
      },
    });
  return { file, state, resumer };
}

test('Claude API error records classify from their error type, status, and text', () => {
  const record = (error: string | null, text: string, status?: number) => ({
    isApiErrorMessage: true,
    ...(error ? { error } : {}),
    ...(status ? { apiErrorStatus: status } : {}),
    message: { content: [{ type: 'text', text }] },
  });
  const transient = [
    record('server_error', 'API Error: Unable to connect to API: SSL certificate has expired'),
    record('server_error', 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.', 529),
    record('server_error', 'API Error: 500 Internal server error.', 500),
    record('server_error', 'API Error: Connection lost mid-response. The response above may be incomplete.'),
    record('server_error', 'API Error: Response stalled mid-stream. The response above may be incomplete.'),
    record('overloaded', 'API Error: Overloaded'),
    record('unknown', 'API Error: The socket connection was closed unexpectedly.'),
    record(null, 'API Error: Request timed out.'),
    record(null, 'API Error: TLS handshake failed'),
    record(null, 'API Error: 502 Bad gateway'),
  ];
  const permanent = [
    record('authentication_failed', 'Failed to authenticate: OAuth session expired and could not be refreshed'),
    record('authentication_failed', 'Failed to authenticate. API Error: 401 Invalid authentication credentials', 401),
    record('billing_error', 'Credit balance is too low', 400),
    record('invalid_request', "API Error: Haiku 5.5 can't help with this. Start a new session to continue."),
    record('rate_limit', "You've hit your session limit · resets 7:30pm (America/Chicago)", 429),
    record('rate_limit', 'Usage credits are required for this model.'),
    record('model_not_found', "There's an issue with the selected model. It may not exist.", 404),
    record('server_error', 'API Error: 503 Service unavailable. Your credit balance is too low.', 503),
  ];
  for (const entry of transient) assert.equal(classifyApiError(entry), 'transient', JSON.stringify(entry));
  for (const entry of permanent) assert.equal(classifyApiError(entry), 'permanent', JSON.stringify(entry));
  assert.equal(classifyApiError(record('unknown', 'API Error: something new')), null);
  assert.equal(classifyApiError(record('unknown', 'API Error: a request may carry at most 512 images')), null);
  assert.equal(classifyApiError({ type: 'assistant', message: { content: 'Unable to connect' } }), null);
});

test('a session that stopped on the expired certificate error is resumed once, in the same session', async () => {
  const { state, resumer } = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')]);
  const owner = resumer();

  state.now = BASE + 3.5 * MINUTE;
  await owner.check();
  assert.deepEqual(state.delivered, [], 'the first resume waits two minutes after the error');
  assert.deepEqual(state.timers, [0.5 * MINUTE]);

  state.now = BASE + 4 * MINUTE;
  await owner.check();
  await owner.check();
  await resumer().check();
  assert.deepEqual(state.delivered, [resumePrompt(1)]);
  assert.deepEqual(state.notices, []);
});

test('an authentication error is never resumed', async () => {
  const { state, resumer } = harness([prompt(0, 'p1'), answer(1, 'a1'), authError(2, 'x1')]);
  const owner = resumer();
  for (const minutes of [3, 10, 40, 120]) {
    state.now = BASE + minutes * MINUTE;
    await owner.check();
  }
  assert.deepEqual(state.delivered, []);
  assert.deepEqual(state.notices, []);
  assert.deepEqual(state.timers, []);
});

test('resumes stop at the limit with backoff, and each window warns once that the session stopped', async () => {
  const { state, resumer } = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')]);
  const owner = resumer();
  // Each resume fails again on the same error. The waits are 2, 8, and 32 minutes after each error.
  const errorAt = [2, 5, 14];
  const resumeAt = [4, 13, 46];
  for (let index = 0; index < RESUME_LIMIT; index++) {
    state.now = BASE + (resumeAt[index] - 0.5) * MINUTE;
    await owner.check();
    assert.equal(state.delivered.length, index, `attempt ${index + 1} waits for its backoff`);
    state.now = BASE + resumeAt[index] * MINUTE;
    await owner.check();
    assert.equal(state.delivered.at(-1), resumePrompt(index + 1));
    if (index + 1 < RESUME_LIMIT) state.append(sslError(errorAt[index + 1], `x${index + 2}`));
  }
  state.append(sslError(47, 'x4'));
  for (const minutes of [48, 90, 120]) {
    state.now = BASE + minutes * MINUTE;
    await owner.check();
  }
  await resumer().check();
  assert.equal(state.delivered.length, RESUME_LIMIT, 'a reloaded window counts the resumes in the transcript');
  assert.deepEqual(state.notices.slice(0, 1), [
    '"Review branch" stopped on an API error after 3 automatic resumes: API Error: Unable to connect to API: SSL certificate has expired',
  ]);
  assert.equal(state.notices.filter((notice) => notice.startsWith('"Review branch" stopped')).length, 2);
});

test('a model answer after a resume starts a new run of failures with its own limit', async () => {
  const { state, resumer } = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')]);
  const owner = resumer();
  state.now = BASE + 4 * MINUTE;
  await owner.check();
  state.append(answer(5, 'a2'), sslError(6, 'x2'));
  state.now = BASE + 8 * MINUTE;
  await owner.check();
  assert.deepEqual(state.delivered, [resumePrompt(1), resumePrompt(1)]);
});

test('a session that already resumed and runs again is not resumed a second time', async () => {
  const { state, resumer } = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')]);
  const owner = resumer();
  state.now = BASE + 4 * MINUTE;
  await owner.check();
  state.append(answer(4.5, 'a2'));
  state.now = BASE + 60 * MINUTE;
  await owner.check();
  await resumer().check();
  assert.equal(state.delivered.length, 1);

  // The resume prompt has not reached the transcript yet, so the error is still the final record.
  const pending = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')], { records: false });
  const waiting = pending.resumer();
  pending.state.now = BASE + 4 * MINUTE;
  await waiting.check();
  await waiting.check();
  assert.equal(pending.state.delivered.length, 1);
});

test('a resume the session refuses is reported once with its reason', async () => {
  const { state, file } = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')]);
  const candidate = { session: SESSION, cwd: null, file, name: 'Review branch' };
  let tries = 0;
  const owner = new ApiErrorResumer({
    candidates: () => [candidate],
    deliver: async () => {
      tries++;
      return { delivered: false, reason: 'The session is running in the background.' };
    },
    notify: (_candidate, message) => state.notices.push(message),
    now: () => BASE + 4 * MINUTE,
    schedule: () => ({ dispose: () => {} }),
  });
  await owner.check();
  await owner.check();
  assert.equal(tries, 1);
  assert.deepEqual(state.notices, [
    '"Review branch" stopped on an API error, and Arc could not resume it: The session is running in the background.',
  ]);
});

test('an error older than six hours, or a prompt after the error, leaves the session alone', async () => {
  const old = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')]);
  old.state.now = BASE + 7 * 60 * MINUTE;
  await old.resumer().check();
  assert.deepEqual(old.state.delivered, []);

  const typed = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1'), prompt(2.5, 'p2')]);
  typed.state.now = BASE + 5 * MINUTE;
  await typed.resumer().check();
  assert.deepEqual(typed.state.delivered, []);

  const titled = harness([
    prompt(0, 'p1'),
    answer(1, 'a1'),
    sslError(2, 'x1'),
    JSON.stringify({ type: 'custom-title', customTitle: 'Review branch', sessionId: SESSION }),
  ]);
  titled.state.now = BASE + 5 * MINUTE;
  await titled.resumer().check();
  assert.deepEqual(titled.state.delivered, [resumePrompt(1)]);
});

test('a tail cut before the newest model answer does not resume, because it cannot count every resume', async () => {
  const progress = JSON.stringify({ type: 'progress', sessionId: SESSION, data: 'x'.repeat(300 * 1024) });
  const lines = [prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')];
  for (const [index, errorAt] of [4, 13, 46].entries()) {
    lines.push(prompt(errorAt, `resume-${index + 1}`, resumePrompt(index + 1)), sslError(errorAt + 1, `x${index + 2}`));
  }
  const whole = harness(lines);
  whole.state.now = BASE + 50 * MINUTE;
  await whole.resumer().check();
  assert.equal(whole.state.notices.length, 1, 'the whole transcript shows three resumes');

  const cut = harness([...lines.slice(0, -1), progress, lines.at(-1)!]);
  cut.state.now = BASE + 50 * MINUTE;
  await cut.resumer().check();
  assert.deepEqual(cut.state.delivered, []);
});

test('a final record still being written holds the resume until it is complete', async () => {
  const { state, resumer } = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')]);
  state.append(prompt(3, 'p2').slice(0, 40));
  state.now = BASE + 5 * MINUTE;
  await resumer().check();
  assert.deepEqual(state.delivered, []);
});

test('a resume prompt written twice counts as one resume', async () => {
  const resume = prompt(4, 'resume-1', resumePrompt(1));
  const { state, resumer } = harness([
    prompt(0, 'p1'),
    answer(1, 'a1'),
    sslError(2, 'x1'),
    resume,
    resume,
    resume,
    sslError(5, 'x2'),
  ]);
  state.now = BASE + 13 * MINUTE;
  await resumer().check();
  assert.deepEqual(state.delivered, [resumePrompt(2)]);
  assert.deepEqual(state.notices, []);
});

test('a session that stops qualifying while another resume is delivered is not resumed', async () => {
  const first = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'x1')]);
  const second = harness([prompt(0, 'p1'), answer(1, 'a1'), sslError(2, 'y1')]);
  const one: ResumeCandidate = { session: 'one', cwd: null, file: first.file, name: 'One' };
  const two: ResumeCandidate = { session: 'two', cwd: null, file: second.file, name: 'Two' };
  let listed = [one, two];
  const delivered: string[] = [];
  const owner = new ApiErrorResumer({
    candidates: () => listed,
    deliver: async (candidate) => {
      delivered.push(candidate.session);
      // The reader archives the second session while the first resume is on its way.
      listed = [one];
      return { delivered: true, reason: '' };
    },
    notify: () => {},
    now: () => BASE + 4 * MINUTE,
    schedule: () => ({ dispose: () => {} }),
  });
  await owner.check();
  assert.deepEqual(delivered, ['one']);
});
