import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
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

export interface RefreshSplit {
  refresh: number;
  reason: string | null;
  selectedOnly: boolean;
  startMs: number;
  stages: Record<string, number>;
  details: Record<string, unknown>;
  promptChecks: number;
}

export interface SelectionSplit {
  click: string;
  clickToHostMs: number | null;
  refreshes: RefreshSplit[];
  windows: { id: number; hostMs: number; enteredAfterMs: number | null; outcome: string }[];
  selectionMessageMs: number | null;
  paintMs: number | null;
}

// One switch, from the browser click to the frame after the first draw of the completed selected content.
// Host stage times count from the host's receipt of the click. Each stage lasts from the previous mark of the same refresh.
// Prompt checks count the synchronous stat calls between the catalog revalidation and the end of admission.
export function selectionSplit(events: SelectionEvent[], click: string, hostOffsetMs: number | null): SelectionSplit {
  const own = events.filter((event) => event.click === click);
  const at = (stage: string) => own.find((event) => event.stage === stage);
  const clicked = at('click');
  const received = at('host-receive');
  const refreshes: RefreshSplit[] = own
    .filter((event) => event.stage === 'refresh')
    .map((start) => {
      const id = (start.payload as { refresh?: number }).refresh ?? -1;
      const marks = own.filter(
        (event) => event.stage === 'refresh-stage' && sameClock(event, start) && (event.payload as any)?.refresh === id,
      );
      const stages: Record<string, number> = {};
      const details: Record<string, unknown> = {};
      let previous = start;
      let opened: SelectionEvent | null = null;
      let closed: SelectionEvent | null = null;
      for (const mark of marks) {
        const { stage, refresh: _refresh, selectedOnly: _selectedOnly, ...detail } = mark.payload as any;
        stages[stage] = (stages[stage] ?? 0) + (mark.time - previous.time);
        Object.assign(details, detail);
        if (stage === 'revalidated') opened = mark;
        if (stage === 'prompts') closed = mark;
        previous = mark;
      }
      const from = opened?.time ?? Infinity;
      const to = closed?.time ?? -Infinity;
      const promptChecks =
        opened && closed
          ? own.filter(
              (event) =>
                event.stage === 'file' &&
                sameClock(event, start) &&
                (event.payload as any)?.operation === 'statSync' &&
                event.time >= from &&
                event.time <= to,
            ).length
          : 0;
      return {
        refresh: id,
        reason: (start.payload as { reason?: string }).reason ?? null,
        selectedOnly: (start.payload as { selectedOnly?: boolean }).selectedOnly === true,
        startMs: received && sameClock(received, start) ? start.time - received.time : NaN,
        stages,
        details,
        promptChecks,
      };
    });
  const sent = own.filter(
    (event) => event.stage === 'worker-send' && (event.payload as RequestPayload)?.request?.kind === 'window',
  );
  const windows = sent.flatMap((send) => {
    const key = requestKey(send);
    const settled = events.find(
      (event) => event.stage === 'window-settled' && sameClock(event, send) && requestKey(event) === key,
    );
    const payload = settled?.payload as { id: number; hostMs: number; enteredAfterMs: number | null; outcome: string };
    return payload
      ? [{ id: payload.id, hostMs: payload.hostMs, enteredAfterMs: payload.enteredAfterMs, outcome: payload.outcome }]
      : [];
  });
  const firstSelection = own.find(
    (event) => event.stage === 'browser-receive' && (event.payload as { type?: string })?.type === 'selection',
  );
  const session = (clicked?.payload as { session?: string })?.session;
  const accepted = own.find((event) => {
    const content = event.payload as { session?: string; complete?: boolean };
    return event.stage === 'selection-accepted' && content?.session === session && content.complete === true;
  });
  const frame =
    accepted &&
    own.find((event) => {
      const content = event.payload as { session?: string; complete?: boolean; generation?: number };
      return (
        event.stage === 'frame' &&
        sameClock(event, accepted) &&
        event.time >= accepted.time &&
        content?.session === session &&
        content.complete === true &&
        content.generation === (accepted.payload as { generation?: number }).generation
      );
    });
  const since = (event: SelectionEvent | undefined | false) =>
    clicked && event && sameClock(clicked, event) ? event.time - clicked.time : null;
  return {
    click,
    clickToHostMs: clicked && received && hostOffsetMs !== null ? received.time - hostOffsetMs - clicked.time : null,
    refreshes,
    windows,
    selectionMessageMs: since(firstSelection),
    paintMs: since(frame),
  };
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
    selectionTrace('host-post', {message:tagged.__arcMeasure === undefined ? {type:tagged.type} : tagged, bytes:Buffer.byteLength(JSON.stringify(tagged))});
    const posted = host.webview.postMessage(tagged);`,
  );
  patch(
    'panelhost.ts',
    'async refresh(force = false, reuseCatalog = false, metadataAfterRender = false, selectedOnly = false): Promise<void> {',
    `async refresh(force = false, reuseCatalog = false, metadataAfterRender = false, selectedOnly = false): Promise<void> {
    const __arcRefresh = ((globalThis as any).__arcRefreshSerial = ((globalThis as any).__arcRefreshSerial ?? 0) + 1);
    const __arcStage = (stage: string, detail: object = {}) => selectionTrace('refresh-stage', {refresh:__arcRefresh, selectedOnly, stage, ...detail});
    selectionTrace('refresh', {refresh:__arcRefresh, reason:this.refreshReason, force,reuseCatalog,metadataAfterRender,selectedOnly});`,
  );
  // Each stage mark closes the stage that the previous mark of the same refresh opened.
  const stages: [string, string][] = [
    ['      const admissionCandidates = all;', "__arcStage('revalidated');"],
    [
      '      const counts = this.unreadCounts();\n      const fullLabels',
      "__arcStage('listing', {catalog: all.length});",
    ],
    [
      '      const metadata = all.map((session) => [session.sessionId, this.metaFor(session)] as const);',
      "__arcStage('rows', {rows: this.sessionRows.length});",
    ],
    ['      const metadataAcceptedHosts = new Set<PanelHost>();', "__arcStage('railInputs');"],
    ['        const hostRail = ', "__arcStage('hostRows');"],
    [
      '        const selectedSession = sessions.find((session) => session.sessionId === hostSession);',
      "__arcStage('rail', {railRows: hostRail.rail.length});",
    ],
    ['        this.startupLoadingSent = JSON.stringify(', "__arcStage('payload');"],
    ['        if (hostSession) {\n          this.hostPreviousSessions?.set(host, hostSession);', "__arcStage('post');"],
    ['      this.checkpointDerivedCache();\n      if (selectedOnly) {', "__arcStage('posted');"],
    [
      '      this.performanceCounters.recordRefresh(refreshReason, performance.now() - refreshStarted);',
      "__arcStage('end');",
    ],
  ];
  for (const [needle, mark] of stages) patch('panelhost.ts', needle, `${mark}\n${needle}`);
  patch(
    'panelhost.ts',
    "      this.performanceCounters.recordRefresh('catalog-enumeration', performance.now() - catalogStarted);",
    `      this.performanceCounters.recordRefresh('catalog-enumeration', performance.now() - catalogStarted);
      __arcStage('prompts', {candidates: admissionCandidates.length, admitted: all.length});`,
  );
  patch(
    'progressiveworker.ts',
    '    if (this.recentWindows.length > RECENT_WINDOW_READS) this.recentWindows.shift();',
    `    selectionTrace('window-settled', this.recentWindows[this.recentWindows.length - 1], undefined);
    if (this.recentWindows.length > RECENT_WINDOW_READS) this.recentWindows.shift();`,
  );
  patch(
    'progressiveworker.ts',
    'const message = { id, generation, request: transported, repeated };',
    `const message = { id, generation, request: transported, repeated, __arcMeasure: requestClick };
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
    // An untagged message keeps only its type, so startup traffic on a large catalog stays small.
    const kept = click === undefined && stage === 'browser-receive' ? {type:payload?.type} : payload;
    ((window as any).__arcEvents ??= []).push({stage, payload:JSON.parse(JSON.stringify(kept)), click, time, origin:performance.timeOrigin, clock:'browser'});
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

// This overlay runs only in the disposable editor with agent connections blocked.
export function instrumentResponse(tree: string): void {
  const source = path.join(tree, 'extension', 'src');
  const traceFile = path.join(source, 'selection-measure.ts');
  let traceSource = fs.readFileSync(traceFile, 'utf8');
  traceSource = traceSource.replace(
    'const write = fs.writeSync.bind(fs);',
    'const write = fs.writeSync.bind(fs); let retained = 0;',
  );
  traceSource = traceSource.replace(
    '  write(descriptor, JSON.stringify({stage, click, payload, time:',
    "  if (click !== 'synthetic-rich-response' && !String(click).startsWith('response-clock-') && !stage.startsWith('response-')) return; if (++retained > 20000) throw new Error('Response trace capacity exceeded.');\n  write(descriptor, JSON.stringify({stage, click, payload, time:",
  );
  fs.writeFileSync(traceFile, traceSource);
  const patch = (name: string, needle: string, replacement: string) => {
    const file = path.join(source, name);
    const text = fs.readFileSync(file, 'utf8');
    if (text.split(needle).length !== 2) throw new Error(`Response overlay boundary is ambiguous: ${name}`);
    fs.writeFileSync(file, text.replace(needle, replacement));
  };
  patch(
    'panelhost.ts',
    '    const click = (raw as any)?.__arcMeasure;',
    `
    if ((raw as any)?.type === '__arcResponse') {
      if (process.env.ARC_MEASURE_BLOCK_AGENTS !== '1') throw new Error('Response capture requires launch isolation.');
      const input = raw as any;
      return selectionContext.run(input.id, async () => {
        try {
          if (input.action === 'begin') {
            const session = this.showing;
            const state = session && this.stateFor(session);
            const sources = this.catalog?.sessions.filter(one => one.sessionId === session && one.agent === 'codex') ?? [];
            if (!state || sources.length !== 1) throw new Error('One selected synthetic Codex source is required.');
            const file = fs.realpathSync(sources[0].file);
            const root = fs.realpathSync(process.env.ARC_CODEX_ROOT!);
            if (!file.startsWith(root + path.sep)) throw new Error('Source is outside the synthetic root.');
            const at = this.noteLive(state, 'prompt', input.prompt);
            const turnId = 880001;
            const timer = setTimeout(() => this.forgetPendingResponses(turnId), LIVE_PRESS_LIMIT_MS);
            timer.unref?.();
            this.pendingResponseOwners.set(turnId, {session, source:session, at, timer});
            selectionTrace('response-owner', {session, at, turnId, registered:this.pendingResponseOwners.has(turnId)});
            this.livePressAnswered(session, at, {delivered:true, session, turnId});
            const press = this.live[session]?.find(one => one.at === at);
            if (!press || press.turnId !== turnId || !press.ran) throw new Error('Delivery did not bind the intended press.');
            const identity = {session, at, turnId, file, prompt:input.prompt, text:input.text,
              nativeTurn:input.id, initialSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
            (this as any).__arcResponse = identity;
            selectionTrace('response-bound', identity);
            this.noteReply(session, input.text, turnId);
            this.postReply();
            selectionTrace('response-live', {identity, press:this.live[session]?.find(one => one.at === at)});
            await host.webview.postMessage({type:'__arcResponse', action:'begin', identity});
          } else {
            const identity = (this as any).__arcResponse;
            if (!identity || identity.nativeTurn !== input.id) throw new Error('Response identity is missing.');
            const {session, at, turnId, file, prompt, text} = identity;
            const record = (type, payload) => JSON.stringify({timestamp:new Date(at + 1).toISOString(), type, payload}) + '\\n';
            const bytes = record('event_msg',{type:'task_started',turn_id:input.id}) +
              record('event_msg',{type:'user_message',message:prompt}) +
              Array.from({length:80}, () => record('measurement_padding',{text:'x'.repeat(65536)})).join('') +
              record('event_msg',{type:'agent_message',phase:'final_answer',message:text}) +
              record('event_msg',{type:'task_complete',turn_id:input.id,last_agent_message:text});
            const offset = fs.statSync(file).size;
            fs.appendFileSync(file, bytes);
            selectionTrace('response-append', {identity,offset,bytes:Buffer.byteLength(bytes),
              sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
              finalSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
            this.noteCompletedReply(session, text, input.id, turnId, () => selectionTrace('response-saved', identity));
            await host.webview.postMessage({type:'__arcResponse',action:'complete',identity});
          }
        } catch (error) { selectionTrace('response-error', String(error)); await host.webview.postMessage({type:'__arcResponse',error:String(error)}); }
      });
    }
    const click = (raw as any)?.__arcMeasure;`,
  );
  patch(
    'panelhost.ts',
    '  private async completeSelectedWindow(sessionId: string, generation: number): Promise<void> {',
    `  private async completeSelectedWindow(sessionId: string, generation: number): Promise<void> {
      selectionTrace('response-read-trigger', {sessionId,generation,held:!!this.selectionWorks?.get(sessionId)});`,
  );
  patch(
    'panelhost.ts',
    '      this.updateHistoryAfterAcceptedWindow(sessionId, previous, result, true);',
    `      selectionTrace('response-read-accepted', {sessionId,generation,result});
      this.updateHistoryAfterAcceptedWindow(sessionId, previous, result, true);`,
  );
  patch(
    'panelhost.ts',
    '      summaryHtml: renderRichMarkdown(turn.summary),',
    `      summaryHtml: (() => { selectionTrace('response-prepare-start',{session:turn.sessionId,summary:turn.summary});
      const html = renderRichMarkdown(turn.summary); selectionTrace('response-prepare-end',{session:turn.sessionId,summary:turn.summary,html}); return html; })(),`,
  );
  patch(
    'webview/panel.ts',
    '    const tagged = data as any;',
    `
    const tagged = data as any;
    if (tagged?.type === '__arcResponse') {
      (window as any).__arcResponse = tagged;
      trace('response-ack', tagged, tagged.identity?.nativeTurn);
      return;
    }`,
  );
  patch(
    'webview/panel.ts',
    '  let drawSerial = 0;',
    `
  (window as any).__arcResponseSend = input => kernel.sendToHost({type:'__arcResponse',...input} as any);
  let responseDomKey = '';
  new MutationObserver(() => {
    const identity = (window as any).__arcResponse?.identity;
    if (!identity) return;
    const live = document.querySelector('.clive[data-live-at="' + identity.at + '"]');
    const card = latest?.cards.find(one => one.sessionId === identity.session && one.summary === identity.text);
    const article = card && Array.from(document.querySelectorAll('article.turn')).find(one => (one as HTMLElement).dataset.key === card.key);
    const rich = article?.querySelector('.summary strong');
    const code = article?.querySelector('.summary code');
    const key = JSON.stringify([!!live,card?.key,!!rich,!!code,window.getSelection()?.toString()]);
    if (key === responseDomKey) return;
    responseDomKey = key;
    const payload = {identity, live:!!live, key:card?.key, rich:rich?.textContent, code:code?.textContent, selected:window.getSelection()?.toString()};
    trace('response-dom',payload,identity.nativeTurn);
    if (!live && rich && code) requestAnimationFrame(() => trace('response-frame',payload,identity.nativeTurn));
  }).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
  let drawSerial = 0;`,
  );
}

export async function measureResponse(
  scratch: string,
  timeoutMs: number,
): Promise<{ complete: boolean; note: string }> {
  const deadline = performance.now() + timeoutMs;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let frame: Frame | undefined;
  const receipt: Record<string, unknown> = { complete: false, synthetic: true, compositorPresentation: false };
  try {
    const port = fs.readFileSync(path.join(scratch, 'user-data', 'DevToolsActivePort'), 'utf8').split('\n')[0];
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {
      timeout: Math.max(1, deadline - performance.now()),
    });
    receipt.cdpConnected = true;
    const transport = await browser.newBrowserCDPSession();
    receipt.cdpTargets = await transport.send('Target.getTargets');
    await reloadWorkbench(browser, deadline);
    receipt.discoveryReload = true;
    frame = await poll(async () => {
      receipt.frames = browser!
        .contexts()
        .flatMap((context) => context.pages().flatMap((page) => page.frames().map((candidate) => candidate.url())));
      for (const context of browser!.contexts())
        for (const page of context.pages())
          for (const candidate of page.frames()) {
            try {
              if (await candidate.evaluate(() => typeof (window as any).__arcResponseSend === 'function'))
                return candidate;
            } catch {}
          }
      return null;
    }, deadline);
    await frame.waitForFunction(
      () =>
        !!document.querySelector('article.turn') && !!document.querySelector('button.railcard[aria-current="true"]'),
      undefined,
      { timeout: Math.max(1, deadline - performance.now()) },
    );
    receipt.welcomeBefore = await dismissWelcome(frame, deadline);
    receipt.welcomeAbsent = true;
    for (let index = 0; index < 3; index++) {
      const alignment = 'response-clock-' + index;
      await frame.evaluate((id) => (window as any).__arcClock(id), alignment);
      await frame.waitForFunction(
        (id) =>
          (window as any).__arcEvents.some(
            (event: SelectionEvent) => event.stage === 'browser-receive' && event.click === id,
          ),
        alignment,
        { timeout: Math.max(1, deadline - performance.now()) },
      );
    }
    const id = 'synthetic-rich-response';
    await frame.evaluate((input) => (window as any).__arcResponseSend(input), {
      id,
      action: 'begin',
      prompt: 'Review the response transition',
      text: 'The **synthetic response** includes `rich-code`.',
    });
    await frame.waitForFunction(
      () => (window as any).__arcResponse?.action === 'begin' || (window as any).__arcResponse?.error,
      undefined,
      { timeout: Math.max(1, deadline - performance.now()) },
    );
    const begin = await frame.evaluate(() => (window as any).__arcResponse);
    receipt.begin = begin;
    if (begin.error) throw new Error(begin.error);
    await frame.locator('.clive .head').click({ timeout: Math.max(1, deadline - performance.now()) });
    await frame.waitForFunction(
      () =>
        document.querySelector('.cliveresponse')?.textContent === 'The **synthetic response** includes `rich-code`.',
      undefined,
      { timeout: Math.max(1, deadline - performance.now()) },
    );
    await frame.page().screenshot({ path: path.join(scratch, 'response-before.png') });
    await frame.evaluate(() => {
      const text = document.querySelector('.cliveresponse')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await frame.evaluate((input) => (window as any).__arcResponseSend(input), { id, action: 'complete' });
    await poll(
      async () =>
        nodeEvents(scratch).some(
          (event) =>
            event.stage === 'response-read-accepted' &&
            event.click === id &&
            (event.payload as any)?.result?.value?.read?.turns.some(
              (turn: any) => turn.summary === begin.identity.text,
            ),
        )
          ? true
          : null,
      deadline,
    );
    await frame.waitForFunction(
      (identity) =>
        (window as any).__arcEvents.some(
          (event: SelectionEvent) =>
            event.stage === 'browser-receive' &&
            (event.payload as any)?.cards?.some(
              (card: any) => card.sessionId === identity.session && card.summary === identity.text,
            ),
        ),
      begin.identity,
      { timeout: Math.max(1, deadline - performance.now()) },
    );
    receipt.protection = await frame.evaluate(() => ({
      selected: window.getSelection()?.toString(),
      live: !!document.querySelector('.clive'),
    }));
    if ((receipt.protection as any).selected !== 'The' || !(receipt.protection as any).live)
      throw new Error('Live response selection was not retained through accepted recorded content.');
    await frame.evaluate(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await frame.waitForFunction(
      () => (window as any).__arcEvents.some((event: SelectionEvent) => event.stage === 'response-frame'),
      undefined,
      { timeout: Math.max(1, deadline - performance.now()) },
    );
    await frame.page().screenshot({ path: path.join(scratch, 'response-after.png') });
    receipt.domTransitionObserved = true;
    receipt.complete = true;
    return {
      complete: true,
      note: 'Synthetic response delivery, recorded rich descendants, and selection protection observed.',
    };
  } catch (error) {
    receipt.error = String(error);
    await frame
      ?.page()
      .screenshot({ path: path.join(scratch, 'response-error.png') })
      .catch(() => {});
    return { complete: false, note: String(error) };
  } finally {
    if (frame) {
      try {
        receipt.browserEvents = await frame.evaluate(() => (window as any).__arcEvents);
      } catch (error) {
        receipt.browserTraceError = String(error);
      }
    }
    receipt.hostWorkerEvents = nodeEvents(scratch);
    fs.writeFileSync(path.join(scratch, 'response.json'), JSON.stringify(receipt, null, 2));
    await browser?.close();
  }
}

// Reload the isolated workbench after attachment so Chromium reports existing webview children.
async function reloadWorkbench(
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>,
  deadline: number,
): Promise<void> {
  for (const context of browser.contexts())
    for (const page of context.pages())
      if (page.url().startsWith('vscode-file:'))
        await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - performance.now()) });
}

// Close the editor's welcome dialog, whose overlay takes pointer input. Returns how many dialogs were open.
async function dismissWelcome(frame: Frame, deadline: number): Promise<number> {
  const workbench = frame.page();
  const welcome = workbench.getByRole('dialog', { name: 'Welcome to Visual Studio Code' });
  const open = await welcome.count();
  if (open) {
    const dismiss = welcome.getByRole('button', { name: /skip|close|done|start/i }).last();
    await dismiss.click({ timeout: Math.max(1, deadline - performance.now()) });
  }
  await workbench.waitForFunction(() => !document.querySelector('.onboarding-a-overlay'), undefined, {
    timeout: Math.max(1, deadline - performance.now()),
  });
  return open;
}

async function poll<T>(read: () => Promise<T | null>, deadline: number): Promise<T> {
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (performance.now() >= deadline) throw new Error('Selection measurement reached its deadline.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Keeps the events a click or a request owns, clock records, and settled window reads. A large catalog writes
// gigabytes of untagged startup file traces, so the files are read in chunks and an unfinished last line is skipped.
function nodeEvents(scratch: string): SelectionEvent[] {
  const events: SelectionEvent[] = [];
  const kept = (line: string) =>
    line.includes('"click":') || line.includes('"stage":"window-settled"') || line.includes('"stage":"clock"');
  for (const name of fs.readdirSync(scratch)) {
    if (!name.startsWith('selection-trace-') || !name.endsWith('.jsonl')) continue;
    const descriptor = fs.openSync(path.join(scratch, name), 'r');
    try {
      const decoder = new StringDecoder('utf8');
      const buffer = Buffer.alloc(1 << 22);
      let carry = '';
      for (;;) {
        const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (read === 0) break;
        const lines = (carry + decoder.write(buffer.subarray(0, read))).split('\n');
        carry = lines.pop()!;
        for (const line of lines) if (line && kept(line)) events.push(JSON.parse(line));
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return events;
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
    await reloadWorkbench(browser, deadline);
    receipt.discoveryReload = true;
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
    receipt.welcomeBefore = await dismissWelcome(frame, deadline);
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
          (id) =>
            (window as unknown as { __arcEvents: SelectionEvent[] }).__arcEvents.filter((event) => event.click === id),
          id,
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
    await frame
      ?.page()
      .screenshot({ path: path.join(scratch, 'selection-error.png') })
      .catch(() => {});
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
    const offsets = (receipt.clockAlignment as { browserToHostOffsetMs?: number }[])
      .map((row) => row.browserToHostOffsetMs)
      .filter((offset): offset is number => offset !== undefined)
      .sort((left, right) => left - right);
    const hostOffset = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;
    receipt.split = (receipt.scenarios as { click?: string }[])
      .filter((scenario) => scenario.click)
      .map((scenario) => ({ ...scenario, ...selectionSplit(events, scenario.click!, hostOffset) }));
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
