import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium, type Frame } from 'playwright-core';

export interface SelectionEvent {
  stage: string;
  click?: string;
  time: number;
  origin: number;
  clock: string;
  payload?: unknown;
}

export const SESSION_BUTTON = 'button.railcard[data-session]';
const REQUIRED = ['click', 'host-receive', 'worker-send', 'worker-start', 'browser-receive', 'draw', 'frame'];

function sameClock(left: SelectionEvent, right: SelectionEvent): boolean {
  return left.clock === right.clock && left.origin === right.origin;
}

interface RequestPayload {
  id?: number;
  generation?: number;
  progress?: boolean;
  status?: string;
  result?: { generation?: number };
  request?: { kind?: string; input?: { session?: { sessionId?: string } } };
}

function requestKey(event: SelectionEvent): string | null {
  const payload = event.payload as RequestPayload;
  const generation = payload?.generation ?? payload?.result?.generation;
  return Number.isSafeInteger(payload?.id) && Number.isSafeInteger(generation) ? `${payload.id}:${generation}` : null;
}

// Only the accepted selected content and its own frame finish an ordinary scenario.
export function selectionFinished(events: SelectionEvent[], click: string, session: string): boolean {
  const own = events.filter((event) => event.click === click);
  return own.some((accepted) => {
    const content = accepted.payload as { session?: string; complete?: boolean; generation?: number; draw?: number };
    if (accepted.stage !== 'selection-accepted' || content?.session !== session || content.complete !== true)
      return false;
    return own.some((draw) => {
      const painted = draw.payload as typeof content;
      return (
        draw.stage === 'draw' &&
        sameClock(accepted, draw) &&
        draw.time >= accepted.time &&
        painted?.session === session &&
        painted.complete === true &&
        painted.generation === content.generation &&
        own.some(
          (frame) =>
            frame.stage === 'frame' &&
            sameClock(draw, frame) &&
            frame.time >= draw.time &&
            (frame.payload as typeof content)?.draw === painted.draw,
        )
      );
    });
  });
}

// Missing work stays unavailable. An absent worker event never becomes a zero duration.
export function selectionCoverage(events: SelectionEvent[], click: string): { complete: boolean; missing: string[] } {
  const stages = new Set(events.filter((event) => event.click === click).map((event) => event.stage));
  const missing = REQUIRED.filter((stage) => !stages.has(stage));
  const own = events.filter((event) => event.click === click);
  if (own.some((event) => !Number.isFinite(event.time) || !Number.isFinite(event.origin) || !event.clock))
    missing.push('clock identity');
  const starts = own.filter((event) => event.stage === 'worker-start');
  const ends = own.filter((event) => event.stage === 'worker-end');
  const sends = own.filter((event) => event.stage === 'worker-send');
  const workerStages = ['worker-send', 'worker-start', 'worker-end', 'worker-post', 'worker-receive', 'abort'];
  const work = own.filter((event) => workerStages.includes(event.stage));
  if (work.some((event) => !requestKey(event))) missing.push('worker request identity');
  for (const key of new Set(work.map(requestKey).filter(Boolean))) {
    const chain = work.filter((event) => requestKey(event) === key);
    const sent = sends.filter((event) => requestKey(event) === key);
    const begun = starts.filter((event) => requestKey(event) === key);
    const ended = ends.filter((event) => requestKey(event) === key);
    const aborts = chain.filter(
      (event) => event.stage === 'abort' && (event.payload as RequestPayload).status === 'cancelled',
    );
    const posts = chain.filter((event) => event.stage === 'worker-post' && !(event.payload as RequestPayload).progress);
    const replies = chain.filter(
      (event) => event.stage === 'worker-receive' && !(event.payload as RequestPayload).progress,
    );
    const cancelled =
      aborts.length === 1 && sent.length === 1 && sameClock(sent[0], aborts[0]) && aborts[0].time >= sent[0].time;
    const terminal =
      ended.length === 1 &&
      begun.length === 1 &&
      sameClock(begun[0], ended[0]) &&
      ended[0].time >= begun[0].time &&
      ['completed', 'cancelled'].includes((ended[0].payload as RequestPayload).status ?? '');
    const replied =
      posts.length === 1 &&
      replies.length === 1 &&
      sent.length === 1 &&
      begun.length === 1 &&
      sameClock(begun[0], posts[0]) &&
      sameClock(sent[0], replies[0]) &&
      posts[0].time >= begun[0].time &&
      replies[0].time >= sent[0].time;
    if (
      sent.length !== 1 ||
      begun.length !== 1 ||
      (!cancelled && (!terminal || !replied)) ||
      (ended.length && !terminal) ||
      (terminal && (ended[0].payload as RequestPayload).status === 'cancelled' && !cancelled)
    )
      missing.push(`worker chain ${key}`);
  }
  const browser = own.filter((event) =>
    ['click', 'browser-receive', 'selection-accepted', 'draw', 'frame'].includes(event.stage),
  );
  const host = own.filter((event) => ['host-receive', 'worker-send', 'worker-receive', 'abort'].includes(event.stage));
  if (browser.some((event) => !sameClock(browser[0], event)) || host.some((event) => !sameClock(host[0], event)))
    missing.push('clock realm identity');
  const first = (stage: string) => browser.find((event) => event.stage === stage);
  const ordered = ['click', 'browser-receive', 'draw', 'frame'].map(first);
  if (ordered.every(Boolean) && ordered.some((event, index) => index > 0 && event!.time < ordered[index - 1]!.time))
    missing.push('browser stage order');
  return { complete: missing.length === 0, missing };
}

// Host transport bounds map the browser click conservatively onto B's host request interval.
export function pendingOverlap(
  events: SelectionEvent[],
  firstB: string,
  nextClick: string,
  session: string,
): { available: boolean; reason: string } {
  if (events.some((event) => !Number.isFinite(event.time) || !Number.isFinite(event.origin) || !event.clock))
    return { available: false, reason: 'native clock identity unavailable' };
  const start = events.find(
    (event) =>
      event.click === firstB &&
      event.stage === 'worker-send' &&
      (event.payload as RequestPayload)?.request?.kind === 'window' &&
      (event.payload as RequestPayload).request?.input?.session?.sessionId === session,
  );
  const click = events.find((event) => event.click === nextClick && event.stage === 'click');
  if (!start || !requestKey(start) || !click)
    return { available: false, reason: 'identified B window or click unavailable' };
  const begun = events.find(
    (event) => event.click === firstB && event.stage === 'worker-start' && requestKey(event) === requestKey(start),
  );
  const terminal =
    begun &&
    events.find(
      (event) =>
        event.click === firstB &&
        event.stage === 'worker-end' &&
        requestKey(event) === requestKey(start) &&
        sameClock(begun, event),
    );
  const bounds = events
    .filter((event) => event.stage === 'clock-send' && sameClock(click, event))
    .flatMap((send) => {
      const receive = events.find(
        (event) => event.stage === 'browser-receive' && event.click === send.click && sameClock(send, event),
      );
      const host = events.find(
        (event) => event.stage === 'clock-receive' && event.click === send.click && sameClock(start, event),
      );
      return receive && host && receive.time >= send.time
        ? [{ lower: host.time - receive.time, upper: host.time - send.time }]
        : [];
    });
  const workerBounds = begun
    ? events
        .filter((event) => event.stage === 'worker-start' && sameClock(begun, event))
        .flatMap((workerStart) => {
          const send = events.find(
            (event) =>
              event.stage === 'worker-send' &&
              requestKey(event) === requestKey(workerStart) &&
              event.click === workerStart.click &&
              sameClock(start, event),
          );
          const post = events.find(
            (event) =>
              event.stage === 'worker-post' &&
              requestKey(event) === requestKey(workerStart) &&
              event.click === workerStart.click &&
              sameClock(workerStart, event),
          );
          const receive = events.find(
            (event) =>
              event.stage === 'worker-receive' &&
              requestKey(event) === requestKey(workerStart) &&
              event.click === workerStart.click &&
              sameClock(start, event),
          );
          return send && post && receive
            ? [{ lower: send.time - workerStart.time, upper: receive.time - post.time }]
            : [];
        })
    : [];
  if (!begun || !terminal || !bounds.length || !workerBounds.length)
    return { available: false, reason: 'B terminal event or same-realm alignment unavailable' };
  if (terminal.time < begun.time) return { available: false, reason: 'B window event order unavailable' };
  const lower = click.time + Math.max(...bounds.map((bound) => bound.lower));
  const upper = click.time + Math.min(...bounds.map((bound) => bound.upper));
  if (upper < lower) return { available: false, reason: 'inconsistent clock alignment' };
  const workerLower = Math.max(...workerBounds.map((bound) => bound.lower));
  const workerUpper = Math.min(...workerBounds.map((bound) => bound.upper));
  if (workerUpper < workerLower) return { available: false, reason: 'inconsistent worker alignment' };
  if (terminal.time + workerUpper <= lower) return { available: false, reason: 'B completed before click' };
  if (lower < begun.time + workerUpper || upper >= terminal.time + workerLower)
    return { available: false, reason: 'click overlap ambiguous within clock uncertainty' };
  return { available: true, reason: 'browser click lies within identified B worker window interval' };
}

// The tracing module is written only into the disposable measurement build.
export const TRACE_SOURCE = `
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { threadId } from 'node:worker_threads';
export const selectionContext = new AsyncLocalStorage();
const file = process.env.ARC_MEASURE_TRACE + '-' + process.pid + '-' + threadId + '.jsonl';
const descriptor = fs.openSync(file, 'a');
const write = fs.writeSync.bind(fs);
export function selectionTrace(stage, payload, click) {
  if (arguments.length < 3) click = selectionContext.getStore();
  write(descriptor, JSON.stringify({stage, click, payload, time: performance.now(), origin: performance.timeOrigin, clock: 'node:' + process.pid + ':' + threadId}) + '\\n');
}
selectionTrace('clock', {pid: process.pid, threadId, wall: Date.now()});
const files = new Map();
for (const key of ['statSync','lstatSync','readdirSync','readFileSync','openSync','readSync','closeSync','writeFileSync','renameSync']) {
  const original = fs[key];
  fs[key] = function(...args) {
    const start = performance.now();
    const target = typeof args[0] === 'number' ? (files.get(args[0]) ?? null) : String(args[0]);
    try {
      const result = original.apply(this,args);
      if (key === 'openSync') files.set(result, String(args[0]));
      if (key === 'closeSync') files.delete(args[0]);
      const encoding = typeof args[1] === 'string' ? args[1] : args[1]?.encoding;
      const bytes = key === 'readSync' && typeof result === 'number' ? result : Buffer.isBuffer(result) ? result.length :
        key === 'readFileSync' && typeof result === 'string' && encoding ? Buffer.byteLength(result, encoding) : null;
      selectionTrace('file', {operation:key,target,duration:performance.now()-start,bytes}); return result;
    }
    catch(error) { selectionTrace('file', {operation:key,target,duration:performance.now()-start,bytes:null,error:String(error)}); throw error; }
  };
}
`;

export function instrumentSelection(tree: string): void {
  const source = path.join(tree, 'extension', 'src');
  fs.writeFileSync(path.join(source, 'selection-measure.ts'), TRACE_SOURCE);
  const patch = (name: string, needle: string, replacement: string) => {
    const file = path.join(source, name);
    const text = fs.readFileSync(file, 'utf8');
    if (text.split(needle).length !== 2) throw new Error(`Selection overlay boundary is ambiguous: ${name}: ${needle}`);
    fs.writeFileSync(file, text.replace(needle, replacement));
  };
  for (const name of ['panelhost.ts', 'progressiveworker.ts', 'progressiveworker-entry.ts']) {
    const file = path.join(source, name);
    fs.writeFileSync(
      file,
      "import { selectionTrace, selectionContext } from './selection-measure';\n" + fs.readFileSync(file, 'utf8'),
    );
  }
  patch(
    'panelhost.ts',
    '            ...payload,',
    `            ...payload,
            __arcSelection: {session:hostSession, generation, complete:!loadingNewest && !selectedFailure},`,
  );
  patch(
    'panelhost.ts',
    'private async onMessage(raw: unknown, host: PanelHost): Promise<void> {',
    `private async onMessage(raw: unknown, host: PanelHost): Promise<void> {
    const click = (raw as any)?.__arcMeasure;
    if ((raw as any)?.type === '__arcClock') { selectionTrace('clock-receive', raw, click); await host.webview.postMessage({type:'__arcClock', __arcMeasure:click, host:performance.now(), origin:performance.timeOrigin}); return; }
    return selectionContext.run(click, async () => { selectionTrace('host-receive', raw); await this.measuredOnMessage(raw, host); selectionTrace('host-handler-end', {type:(raw as any)?.type}); });
  }
  private async measuredOnMessage(raw: unknown, host: PanelHost): Promise<void> {`,
  );
  patch(
    'panelhost.ts',
    'const posted = host.webview.postMessage(message);',
    `const tagged = { ...(message as any), __arcMeasure: selectionContext.getStore() };
    selectionTrace('host-post', {message:tagged, bytes:Buffer.byteLength(JSON.stringify(tagged))});
    const posted = host.webview.postMessage(tagged);`,
  );
  patch(
    'panelhost.ts',
    'async refresh(force = false, reuseCatalog = false, metadataAfterRender = false, selectedOnly = false): Promise<void> {',
    `async refresh(force = false, reuseCatalog = false, metadataAfterRender = false, selectedOnly = false): Promise<void> {
    selectionTrace('refresh', {force,reuseCatalog,metadataAfterRender,selectedOnly});`,
  );
  patch(
    'progressiveworker.ts',
    'const message = { id, generation, request, repeated };',
    `const message = { id, generation, request, repeated, __arcMeasure: requestClick };
      selectionTrace('worker-send', message);`,
  );
  patch(
    'progressiveworker.ts',
    'const id = ++this.nextId;',
    'const id = ++this.nextId; const requestClick = selectionContext.getStore();',
  );
  patch(
    'progressiveworker.ts',
    'this.worker?.postMessage({ cancel: id });',
    `selectionTrace('abort', {id,generation,status:'cancelled'}, requestClick); this.worker?.postMessage({ cancel: id });`,
  );
  patch(
    'progressiveworker.ts',
    'const held = this.pending.get(message.id);',
    `selectionTrace('worker-receive', message, (message as any).__arcMeasure); const held = this.pending.get(message.id);`,
  );
  patch(
    'progressiveworker-entry.ts',
    "parentPort?.on(\n  'message',",
    `if (parentPort) {
      const post = parentPort.postMessage.bind(parentPort);
      parentPort.postMessage = (message) => {
        const tagged = {...message,__arcMeasure:selectionContext.getStore()};
        selectionTrace('worker-post',tagged);
        post(tagged);
      };
    }
    parentPort?.on(\n  'message',`,
  );
  patch(
    'progressiveworker-entry.ts',
    'void handleMessage(message);',
    `if (message.cancel !== undefined) { selectionTrace('worker-cancel-receive', message, undefined); void handleMessage(message); return; }
    void selectionContext.run((message as any).__arcMeasure, async () => {
      selectionTrace('worker-start', message);
      await handleMessage(message);
    });`,
  );
  patch(
    'progressiveworker-entry.ts',
    '    requests.delete(message.id);',
    `    selectionTrace('worker-end', {id:message.id,generation:message.generation,status:controller.signal.aborted?'cancelled':'completed'});
    requests.delete(message.id);`,
  );
  patch(
    'webview/panel.ts',
    'const vscode = Object.freeze({ postMessage: kernel.sendToHost });',
    `const trace = (stage, payload, click) => {
    const time = performance.now();
    ((window as any).__arcEvents ??= []).push({stage, payload:JSON.parse(JSON.stringify(payload)), click, time, origin:performance.timeOrigin, clock:'browser'});
  };
  let drawSerial = 0;
  let drawOwner: any = null;
  let clickSerial = 0;
  document.addEventListener('click', (event) => {
    const row = (event.target as Element)?.closest('${SESSION_BUTTON}');
    if (!row) return;
    (window as any).__arcClick = 'click-' + ++clickSerial;
    trace('click', {session:row.getAttribute('data-session'), trusted:event.isTrusted}, (window as any).__arcClick);
  }, true);
  const originalSend = kernel.sendToHost;
  kernel = {...kernel, sendToHost(message) {
    const click = (message as any).__arcMeasure ?? (message.type === 'showSession' ? (window as any).__arcClick : undefined);
    const tagged = {...message, __arcMeasure:click}; trace('browser-post', {message:tagged,bytes:new TextEncoder().encode(JSON.stringify(tagged)).length}, click); originalSend(tagged);
  } };
  const vscode = Object.freeze({ postMessage:kernel.sendToHost });
  (window as any).__arcClock = (id) => { const time=performance.now(); trace('clock-send',{},id); kernel.sendToHost({type:'__arcClock',__arcMeasure:id} as any); return time; };`,
  );
  patch(
    'webview/panel.ts',
    'function receiveHostMessage(data: unknown) {',
    `function receiveHostMessage(data: unknown) {
    const tagged = data as any;
    trace('browser-receive', data, tagged?.__arcMeasure);
    if (tagged?.type === '__arcClock') return;
    `,
  );
  for (const kind of ['selection', 'render'])
    patch(
      'webview/panel.ts',
      kind + ': function (msg) {',
      kind +
        `: function (msg) {
        drawOwner = {click:tagged?.__arcMeasure, content:tagged?.__arcSelection};
        trace('selection-accepted', drawOwner.content ?? {}, drawOwner.click);`,
    );
  patch(
    'webview/panel.ts',
    '    acknowledgePaint();\n  }',
    `    acknowledgePaint();
    const owner = drawOwner;
    const click = owner?.click;
    const content = {...(owner?.content ?? {}), draw:++drawSerial};
    const finishMeasuredDraw = () => {
      if (drawOwner !== owner) return;
      if (!timelineRenderer.settled()) { requestAnimationFrame(finishMeasuredDraw); return; }
      trace('draw', content, click);
      requestAnimationFrame(() => trace('frame', content, click));
    };
    finishMeasuredDraw();
  }`,
  );
}

async function poll<T>(read: () => Promise<T | null>, deadline: number): Promise<T> {
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (performance.now() >= deadline) throw new Error('Selection measurement reached its deadline.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function nodeEvents(scratch: string): SelectionEvent[] {
  return fs
    .readdirSync(scratch)
    .filter((name) => name.startsWith('selection-trace-') && name.endsWith('.jsonl'))
    .flatMap((name) => {
      const text = fs.readFileSync(path.join(scratch, name), 'utf8');
      return text
        .slice(0, text.lastIndexOf('\n'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    });
}

export async function measureSelection(
  scratch: string,
  timeoutMs: number,
): Promise<{ complete: boolean; note: string }> {
  const deadline = performance.now() + timeoutMs;
  const receipt: Record<string, unknown> = {
    nativeClock: true,
    imposedDelay: false,
    scenarios: [],
    fixtureClocks: false,
    measurementOnly: true,
  };
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let frame: Frame | undefined;
  try {
    const port = await poll(async () => {
      try {
        return fs.readFileSync(path.join(scratch, 'user-data', 'DevToolsActivePort'), 'utf8').split('\n')[0];
      } catch {
        return null;
      }
    }, deadline);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: Math.max(1, deadline - performance.now()),
    });
    receipt.cdpConnected = true;
    const transport = await browser.newBrowserCDPSession();
    receipt.cdpTargets = await transport.send('Target.getTargets');
    frame = await poll(async () => {
      receipt.frames = browser!
        .contexts()
        .flatMap((context) => context.pages().flatMap((page) => page.frames().map((candidate) => candidate.url())));
      for (const context of browser!.contexts())
        for (const page of context.pages())
          for (const candidate of page.frames()) {
            try {
              if (
                await candidate.evaluate(() =>
                  Array.isArray((window as unknown as { __arcEvents?: unknown }).__arcEvents),
                )
              )
                return candidate;
            } catch {
              /* A webview frame can detach while the editor opens it. */
            }
          }
      return null;
    }, deadline);
    receipt.transport = 'owned editor CDP';
    receipt.frame = frame.url();
    receipt.clockAlignment = [];
    for (let index = 0; index < 5; index++) {
      const id = 'alignment-' + index;
      await frame.evaluate((id) => (window as unknown as { __arcClock: (id: string) => number }).__arcClock(id), id);
      await frame.waitForFunction(
        (id) =>
          (window as unknown as { __arcEvents: SelectionEvent[] }).__arcEvents.some(
            (event) => event.stage === 'browser-receive' && event.click === id,
          ),
        id,
        { timeout: Math.max(1, deadline - performance.now()) },
      );
    }
    await frame.waitForFunction((selector) => document.querySelectorAll(selector).length >= 2, SESSION_BUTTON, {
      timeout: Math.max(1, deadline - performance.now()),
    });
    const sessions = await frame.locator(SESSION_BUTTON).evaluateAll((rows) =>
      rows.map((row) => ({
        session: row.getAttribute('data-session')!,
        current: row.getAttribute('aria-current') === 'true',
      })),
    );
    const a = sessions.find((row) => row.current)?.session;
    const b = sessions.find((row) => row.session !== a)?.session;
    if (!a || !b) throw new Error('Selection needs a selected A and another visible B.');
    const scenarios: { name: string; session: string; click?: string; interrupted?: boolean; missing?: string[] }[] =
      [];
    receipt.scenarios = scenarios;
    const waitCompleted = (id: string, session: string) =>
      poll(async () => {
        const events = await frame!.evaluate(
          () => (window as unknown as { __arcEvents: SelectionEvent[] }).__arcEvents,
        );
        return selectionFinished(events, id, session) ? true : null;
      }, deadline);
    const click = async (name: string, session: string, wait: boolean) => {
      await frame!
        .locator(`${SESSION_BUTTON}[data-session="${session.replaceAll('"', '\\"')}"]`)
        .click({ timeout: Math.max(1, deadline - performance.now()) });
      const id = await frame!.evaluate(() => (window as unknown as { __arcClick: string }).__arcClick);
      scenarios.push({ name, session, click: id });
      if (wait) await waitCompleted(id, session);
      return id;
    };
    await click('repeated-selected-A', a, true);
    const firstB = await click('first-opening-B', b, false);
    const pending = nodeEvents(scratch).filter((event) => event.click === firstB);
    const started = pending.find((event) => {
      const payload = event.payload as { request?: { kind?: string; input?: { session?: { sessionId?: string } } } };
      return (
        event.stage === 'worker-start' &&
        payload.request?.kind === 'window' &&
        payload.request.input?.session?.sessionId === b
      );
    });
    const requestId = (started?.payload as { id?: number } | undefined)?.id;
    const ended = pending.some(
      (event) => event.stage === 'worker-end' && (event.payload as { id?: number })?.id === requestId,
    );
    receipt.pendingObservation = { started: started ?? null, ended, observedAt: performance.now(), clock: 'driver' };
    if (started && !ended) {
      scenarios.find((scenario) => scenario.click === firstB)!.interrupted = true;
      receipt.pendingAttempt = { firstB, nextClick: await click('click-while-B-pending', a, true), session: b };
      await click('establish-completed-B', b, true);
    } else {
      scenarios.push({ name: 'click-while-B-pending', session: a, missing: ['natural pending B was not observed'] });
      await waitCompleted(firstB, b);
    }
    await click('establish-completed-A', a, true);
    await click('retained-A', a, true);
    await click('retained-B', b, true);
    await click('retained-A-return', a, true);
    return {
      complete: false,
      note: 'Selection trace retained. Review correlation and natural pending coverage before accepting live timing.',
    };
  } catch (error) {
    receipt.error = String(error);
    return { complete: false, note: String(error) };
  } finally {
    try {
      if (frame)
        receipt.browserEvents = await frame.evaluate(
          () => (window as unknown as { __arcEvents: SelectionEvent[] }).__arcEvents,
        );
    } catch (error) {
      receipt.browserTraceError = String(error);
    }
    receipt.hostWorkerEvents = nodeEvents(scratch);
    const events = [
      ...((receipt.browserEvents as SelectionEvent[]) ?? []),
      ...(receipt.hostWorkerEvents as SelectionEvent[]),
    ];
    const attempt = receipt.pendingAttempt as { firstB: string; nextClick: string; session: string } | undefined;
    const overlap = attempt ? pendingOverlap(events, attempt.firstB, attempt.nextClick, attempt.session) : null;
    receipt.pendingOverlap = overlap;
    receipt.coverage = (
      receipt.scenarios as {
        name: string;
        session: string;
        click?: string;
        interrupted?: boolean;
        missing?: string[];
      }[]
    ).map((scenario) => {
      const coverage = selectionCoverage(events, scenario.click ?? '');
      const missing = [...coverage.missing, ...(scenario.missing ?? [])];
      if (!scenario.interrupted && !selectionFinished(events, scenario.click ?? '', scenario.session))
        missing.push('accepted selected-window frame');
      if (scenario.name === 'click-while-B-pending' && !overlap?.available)
        missing.push(overlap?.reason ?? 'natural pending overlap unavailable');
      return { ...scenario, complete: missing.length === 0, missing };
    });
    receipt.clockAlignment = Array.from({ length: 5 }, (_, index) => {
      const id = 'alignment-' + index;
      const send = events.find((event) => event.stage === 'clock-send' && event.click === id);
      const receive = events.find((event) => event.stage === 'browser-receive' && event.click === id);
      const host = events.find((event) => event.stage === 'clock-receive' && event.click === id);
      if (!send || !receive || !host || !sameClock(send, receive) || receive.time < send.time)
        return { id, unavailable: true };
      return {
        id,
        browserToHostOffsetMs: host.time - (send.time + receive.time) / 2,
        uncertaintyMs: (receive.time - send.time) / 2,
        hostClock: host.clock,
        browserClock: send.clock,
      };
    });
    receipt.workerClockAlignment = events
      .filter((event) => event.stage === 'worker-start')
      .map((start) => {
        const request = start.payload as { id: number; generation: number };
        const same = (event: SelectionEvent) => {
          const payload = event.payload as { id?: number; generation?: number; result?: { generation?: number } };
          return (
            event.click === start.click &&
            payload?.id === request.id &&
            (payload.generation ?? payload.result?.generation) === request.generation
          );
        };
        const send = events.find((event) => event.stage === 'worker-send' && same(event));
        const post = events.find((event) => event.stage === 'worker-post' && sameClock(event, start) && same(event));
        const receive = events.find((event) => event.stage === 'worker-receive' && same(event));
        if (
          !send ||
          !post ||
          !receive ||
          !sameClock(send, receive) ||
          post.time < start.time ||
          receive.time < send.time
        )
          return { request, unavailable: true };
        const lowerMs = send.time - start.time;
        const upperMs = receive.time - post.time;
        return {
          request,
          workerClock: start.clock,
          hostClock: send.clock,
          lowerMs,
          upperMs,
          offsetMs: (lowerMs + upperMs) / 2,
          uncertaintyMs: (upperMs - lowerMs) / 2,
          valid: upperMs >= lowerMs,
        };
      });
    receipt.unavailable = [
      'Asynchronous filesystem operations',
      'Compositor presentation',
      'Representative live workspace inputs',
      'Independent evidence review',
    ];
    receipt.complete = false;
    fs.writeFileSync(path.join(scratch, 'selection.json'), JSON.stringify(receipt, null, 2));
    await browser?.close();
  }
}
