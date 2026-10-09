import assert from 'node:assert';
import { test } from 'vitest';
import { createHost, type VsCodeWebviewApi } from './host.ts';

test('the VS Code API remains inside the host closure', () => {
  const posted: unknown[] = [];
  let stored: unknown = { showing: 's1' };
  const api: VsCodeWebviewApi = {
    postMessage(message) {
      posted.push(message);
    },
    getState() {
      return stored;
    },
    setState(state) {
      stored = state;
    },
  };

  const ports = createHost(api);
  assert.deepEqual(Object.keys(ports).sort(), ['browserState', 'host', 'readOnly']);
  assert.equal(Object.values(ports).includes(api), false);
  assert.equal(Object.values(ports.host).includes(api), false);
  assert.equal(Object.values(ports.browserState).includes(api), false);

  ports.host.send({ type: 'initialize' });
  assert.deepEqual(posted, [{ type: 'initialize' }]);
  assert.deepEqual(ports.browserState.read(), { showing: 's1' });
  ports.browserState.write({ showing: 's2' });
  assert.deepEqual(stored, { showing: 's2' });
});
