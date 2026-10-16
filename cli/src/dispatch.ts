import * as fs from 'node:fs';
import { DispatchReceipts, DISPATCH_ID } from '../../extension/src/dispatchreceipts.ts';
import { requestWindow, WindowUnavailableError } from '../../extension/src/sessionrequests.ts';
import { waitStandalone, superviseStandalone } from './standalone.ts';

export async function runDispatch(action: string, args: string[]): Promise<string> {
  const options = new Map<string, string>();
  const ids: string[] = [];
  const accepted = [
    '--event',
    '--origin',
    '--owner',
    '--token',
    '--outcome-file',
    '--deadline-ms',
    '--window',
    '--cursor',
    '--limit',
  ];
  let json = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (arg === '--json' && !json) json = true;
    else if (accepted.includes(arg) && !options.has(arg)) {
      const value = args[++at];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options.set(arg, value);
    } else if (!arg.startsWith('-')) ids.push(arg);
    else throw new Error(`Unknown or repeated argument: ${arg}`);
  }
  if (ids.length !== 1 || !DISPATCH_ID.test(ids[0])) throw new Error('Dispatch requires one full launch ID.');
  const allowed =
    action === 'claim'
      ? ['--event', '--origin', '--owner']
      : action === 'ack'
        ? ['--event', '--origin', '--owner', '--token', '--outcome-file']
        : action === 'wait'
          ? ['--deadline-ms', '--window']
          : action === 'result' || action === 'recover'
            ? ['--event']
            : action === 'status' || action === 'refresh'
              ? ['--cursor', '--limit']
              : [];
  for (const key of options.keys())
    if (!allowed.includes(key)) throw new Error(`${key} is unavailable for dispatch ${action}.`);
  const need = (key: string) => {
    const value = options.get(key);
    if (!value) throw new Error(`Dispatch ${action} requires ${key}.`);
    return value;
  };
  const id = ids[0];
  const receipts = new DispatchReceipts();
  const launch = receipts.launch(id);
  let result: unknown;
  if (action === 'claim') result = receipts.claim(id, need('--event'), need('--origin'), need('--owner'));
  else if (action === 'ack') {
    const file = need('--outcome-file');
    const fd = fs.openSync(file, 'r');
    let disposition: string;
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 16 * 1024)
        throw new Error('The disposition must be a regular UTF-8 file up to 16 KiB.');
      const buffer = Buffer.alloc(16 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > 16 * 1024) throw new Error('The disposition exceeds 16 KiB.');
      disposition = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } finally {
      fs.closeSync(fd);
    }
    result = receipts.ack(id, need('--event'), need('--origin'), need('--owner'), need('--token'), disposition);
  } else if (action === 'wait') {
    if (launch.completion !== 'wait') throw new Error('This dispatch launch did not select waited completion.');
    const deadlineMs = Number(options.get('--deadline-ms') ?? '110000');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 110_000)
      throw new Error('The wait deadline must be 1 through 110000 milliseconds.');
    try {
      result =
        launch.transport === 'standalone'
          ? await waitStandalone(receipts, id, deadlineMs)
          : await requestWindow(
              'dispatch',
              { dispatchAction: 'wait', launchId: id, deadlineMs },
              options.get('--window') ?? launch.origin,
            );
    } catch (error) {
      if (!(error instanceof WindowUnavailableError)) throw error;
      result = {
        launchId: id,
        state: 'uncertain',
        reason: 'The host is unavailable. Read dispatch status or recover this receipt.',
      };
    }
  } else if (action === 'monitor')
    result =
      launch.transport === 'standalone'
        ? await superviseStandalone(receipts, id, true, undefined, undefined, undefined, false, process.argv[1])
        : {
            launchId: id,
            state: 'unavailable',
            reason: 'Hosted dispatch uses lifecycle observation.',
          };
  else if (action === 'recover') {
    const event = receipts.event(id, need('--event'));
    result = {
      launchId: id,
      eventId: event.eventId,
      outcome: event.outcome,
      delivery: 'unavailable',
      completion: launch.completion,
      reason:
        launch.transport === 'hosted'
          ? 'Hosted recovery observes retained delivery without sending input. This launch has no callback delivery.'
          : 'This standalone launch selected no callback delivery. Read its saved report or resume observation with dispatch monitor.',
    };
  } else if (['result', 'status', 'refresh'].includes(action)) {
    try {
      if (launch.transport === 'hosted')
        await requestWindow('dispatch', { dispatchAction: 'status', launchId: id }, launch.origin);
    } catch {
      /* Saved reports remain available after host shutdown. */
    }
    if (action === 'refresh') receipts.refresh(id);
    result =
      action === 'result'
        ? receipts.result(id, need('--event'))
        : receipts.status(
            id,
            options.get('--cursor'),
            options.has('--limit') ? Number(options.get('--limit')) : undefined,
          );
  } else throw new Error(`Unknown dispatch operation: ${action}`);
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 48 * 1024)
    throw new Error('The dispatch reply exceeds its JSON allowance. Read one event with dispatch result.');
  return output;
}
