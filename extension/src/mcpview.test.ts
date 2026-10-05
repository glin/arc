import { test } from 'vitest';
import assert from 'node:assert';
import { MCP_RECONNECT, failedServers, mcpMenu, mcpPick, mcpToggleWanted, readMcpServers } from './mcpview';
import { McpServer } from './agentwire';

// The fixture includes connected, failed, and disabled servers. Optional response fields remain absent.

const ANSWER = {
  mcpServers: [
    {
      name: 'filesystem',
      status: 'connected',
      serverInfo: { name: 'mcp-filesystem', version: '0.0.1' },
      config: { type: 'stdio', command: 'node.exe', args: ['filesystem-server.js'] },
      scope: 'dynamic',
      tools: [
        { name: 'read_file', annotations: {} },
        { name: 'write_file', annotations: {} },
      ],
    },
    {
      name: 'database',
      status: 'failed',
      error: 'Connection closed',
      config: { type: 'stdio', command: 'a-program-that-is-not-installed', args: [] },
      scope: 'dynamic',
    },
    {
      name: 'memory',
      status: 'disabled',
      config: { type: 'stdio', command: 'node.exe', args: [] },
      scope: 'user',
    },
  ],
};

function server(over: Partial<McpServer> = {}): McpServer {
  return {
    name: 'files',
    status: 'connected',
    error: '',
    tools: ['read'],
    scope: 'project',
    title: 'file-server',
    ...over,
  };
}

const named = (servers: readonly McpServer[]): string[] => servers.map((s) => s.name);

test('the menu answers an agent with no servers, and the picker row still draws no control', () => {
  // An empty server list still opens the /mcp menu. The prompt box picker row has no server control.

  const empty = mcpMenu([], 'claude', 'Claude');
  assert.ok(empty, 'an agent with no servers opened no menu, so its own /mcp does nothing');
  assert.deepEqual(empty.items, [], 'a menu with no servers drew a row anyway');
  assert.ok(empty.empty.includes('no MCP servers'), `the empty menu does not say why it is empty: ${empty.empty}`);
  assert.ok(empty.head.includes('Claude'), 'the empty menu drops the agent it is about');
  assert.equal(
    mcpMenu([], 'codex', 'Codex')?.head,
    'Which servers can Codex call tools on?',
    'an empty Codex status list promises configuration controls it cannot provide',
  );
  assert.equal(mcpPick([], 'Claude'), null, 'a count of zero took a place on the picker row');
});

test('a connected server, a failed one and a switched-off one are read as the agent reported them', () => {
  const servers = readMcpServers(ANSWER);
  assert.deepEqual(named(servers), ['filesystem', 'database', 'memory']);
  assert.deepEqual(servers[0], {
    name: 'filesystem',
    status: 'connected',
    error: '',
    tools: ['read_file', 'write_file'],
    scope: 'dynamic',
    title: 'mcp-filesystem',
  });
  assert.deepEqual(servers[1], {
    name: 'database',
    status: 'failed',
    error: 'Connection closed',
    tools: [],
    scope: 'dynamic',
    title: '',
  });
  assert.deepEqual(servers[2], {
    name: 'memory',
    status: 'disabled',
    error: '',
    tools: [],
    scope: 'user',
    title: '',
  });
});

test('a state this version has never met is carried through as the agent wrote it', () => {
  // Retain unfamiliar server status strings without replacing them or dropping the server.

  const servers = readMcpServers({
    mcpServers: [
      { name: 'slow', status: 'starting', scope: 'project' },
      { name: 'locked', status: 'needs-authentication', scope: 'user' },
    ],
  });
  assert.deepEqual(
    servers.map((s) => s.status),
    ['starting', 'needs-authentication'],
  );
});

test('the halves an agent only sends sometimes are read as empty rather than as missing', () => {
  const [only] = readMcpServers({ mcpServers: [{ name: 'bare' }] });
  assert.deepEqual(only, { name: 'bare', status: '', error: '', tools: [], scope: '', title: '' });
});

test('a server with no name is dropped and the servers either side of it are kept', () => {
  // The name is the whole handle: it is what the row reads and what goes back on the wire
  // when the reader switches the server off. A row with neither can be seen and not acted on.
  const servers = readMcpServers({
    mcpServers: [
      { name: 'first', status: 'connected' },
      { status: 'connected', scope: 'user' },
      { name: '', status: 'connected' },
      { name: 'last', status: 'connected' },
    ],
  });
  assert.deepEqual(named(servers), ['first', 'last']);
});

test('a tool the agent named nothing is left out of the count', () => {
  const [only] = readMcpServers({
    mcpServers: [{ name: 'files', status: 'connected', tools: [{ name: 'read' }, { annotations: {} }, 'write'] }],
  });
  assert.deepEqual(only.tools, ['read']);
});

test('an answer that is not the shape expected reads as no servers at all', () => {
  assert.deepEqual(readMcpServers(null), []);
  assert.deepEqual(readMcpServers({}), []);
  assert.deepEqual(readMcpServers({ mcpServers: 'none' }), []);
  assert.deepEqual(readMcpServers({ mcpServers: [null, 7, 'files'] }), []);
});

// Cover connected, failed, needs-auth, pending, and disabled states.

const FIVE: McpServer[] = [
  server({ name: 'files', status: 'connected', tools: ['read', 'write'], scope: 'project' }),
  server({ name: 'db', status: 'failed', error: 'Connection closed', tools: [], scope: 'user', title: '' }),
  server({ name: 'auth', status: 'needs-auth', tools: [], scope: 'user', title: '' }),
  server({ name: 'slow', status: 'pending', tools: [], scope: 'local', title: '' }),
  server({ name: 'old', status: 'disabled', tools: [], scope: 'local', title: '' }),
];

const rows = (servers: readonly McpServer[]) => mcpMenu(servers, 'claude', 'Claude')?.items ?? [];

test('a machine with no MCP servers gets no control at all', () => {
  // The prompt box picker row omits the server control when the list is empty.

  assert.equal(mcpPick([], 'Claude'), null);
});

test('the control counts the servers, and says server once where there is one', () => {
  assert.equal(mcpPick([server()], 'Claude')?.label, '1 server');
  assert.equal(mcpPick([server(), server({ name: 'db' })], 'Claude')?.label, '2 servers');
  assert.equal(mcpPick(FIVE, 'Claude')?.label, '5 servers, 1 failed');
});

test('the control says how much trouble there is, and says nothing where there is none', () => {
  const well = mcpPick([server(), server({ name: 'db', status: 'pending', tools: [] })], 'Claude');
  assert.equal(well?.label, '2 servers');
  assert.equal(well?.detail, 'The servers Claude can call tools on.');
  const badly = mcpPick(
    [
      server({ status: 'failed', error: 'Connection closed', tools: [] }),
      server({ name: 'db', status: 'failed', error: 'spawn ENOENT', tools: [] }),
    ],
    'Claude',
  );
  assert.equal(badly?.label, '2 servers, 2 failed');
  assert.equal(
    badly?.detail,
    'The servers Claude can call tools on. 2 servers failed, so their tools cannot be called.',
  );
});

test('the control raises the caution tone for a failure and for no other state', () => {
  // Only a failed server raises the caution tone.

  for (const status of ['connected', 'pending', 'needs-auth', 'disabled', 'warming-up']) {
    assert.equal(
      mcpPick([server({ status, tools: [] })], 'Claude')?.caution,
      false,
      `a server the agent called ${status} was drawn as a fault`,
    );
  }
  assert.equal(mcpPick([server({ status: 'failed', error: 'Connection closed', tools: [] })], 'Claude')?.caution, true);
});

test('the control names what it is and what it is set to, and says what a press does', () => {
  assert.equal(mcpPick([server()], 'Claude')?.name, 'MCP servers: 1 server. Press to switch one off or on.');
  // With something down, the name has to mention the one row the reader opened the menu for.
  assert.equal(
    mcpPick(FIVE, 'Claude')?.name,
    'MCP servers: 5 servers, 1 failed. Press to switch one off or on, or to try the failed ones again.',
  );
});

test('a read-only Codex inventory is a status list and promises no switches', () => {
  const codex = [server({ status: 'ready', mutable: false, scope: '' })];
  assert.equal(mcpPick(codex, 'Codex')?.name, 'MCP servers: 1 server. Press to inspect them.');
  const menu = mcpMenu(codex, 'codex', 'Codex');
  assert.ok(menu);
  assert.equal(menu.head, 'Which servers can Codex call tools on?');
  assert.equal(menu.items[0].kind, 'status');
  assert.equal(menu.items[0].name, 'files. ready, 1 tool.');
  assert.ok(!menu.items[0].name.includes('switch'));
});

test('the menu has one row per server, in the order the agent listed them', () => {
  const menu = mcpMenu(FIVE, 'claude', 'Claude');
  assert.ok(menu);
  assert.equal(menu.control, 'mcp');
  assert.equal(menu.agent, 'claude');
  assert.equal(menu.head, 'Which servers should Claude be able to call tools on?');
  assert.equal(menu.empty, '');
  const servers = menu.items.filter((i) => i.kind === 'toggle');
  assert.deepEqual(
    servers.map((i) => i.label),
    ['files', 'db', 'auth', 'slow', 'old'],
  );
  // The value goes back on the wire as the server name and carries nothing else, so the far
  // end never has to take a row apart to find out which server was pressed.
  assert.deepEqual(
    servers.map((i) => i.value),
    ['files', 'db', 'auth', 'slow', 'old'],
  );
});

test('only a server somebody switched off is drawn switched off', () => {
  // A failed server remains enabled. Only disabled servers render an unchecked toggle.

  assert.deepEqual(
    rows(FIVE)
      .filter((i) => i.kind === 'toggle')
      .map((i) => i.checked),
    [true, true, true, true, false],
  );
  assert.deepEqual(
    rows([server({ status: 'warming-up', tools: [] })]).map((i) => i.checked),
    [true],
  );
});

test('a row is drawn in the caution tone only where the agent said the server failed', () => {
  assert.deepEqual(
    rows(FIVE)
      .filter((i) => i.kind === 'toggle')
      .map((i) => i.caution),
    [false, true, false, false, false],
  );
});

test('each row says the state in the word the agent used, the tool count and the scope', () => {
  assert.deepEqual(
    rows(FIVE)
      .filter((i) => i.kind === 'toggle')
      .map((i) => i.description),
    [
      'connected, 2 tools, project scope',
      'failed, user scope. Connection closed',
      'needs-auth, user scope. Wants a login, which cannot be given from here.',
      'pending, local scope. Still starting.',
      'disabled, local scope',
    ],
  );
});

test('the menu writes no state word the agent did not say', () => {
  // Menu descriptions retain unfamiliar status strings without inventing a known state.

  const menu = mcpMenu(
    [
      server({ name: 'a', status: 'warming-up', tools: [], scope: 'user' }),
      server({ name: 'b', status: 'idle', tools: [], scope: 'user' }),
    ],
    'claude',
    'Claude',
  );
  assert.ok(menu);
  assert.deepEqual(
    menu.items.map((i) => i.description),
    ['warming-up, user scope', 'idle, user scope'],
  );
  const written = menu.items.map((i) => `${i.label} ${i.description} ${i.name}`).join(' ');
  for (const word of ['connected', 'failed', 'disabled', 'pending', 'needs-auth']) {
    assert.ok(!written.includes(word), `the menu called a server ${word} when the agent never did`);
  }
});

test('a server that has not connected says nothing at all about its tools', () => {
  // A server that has not connected supplies no known tool count.

  const said = (status: string): string => rows([server({ status, tools: [], scope: '' })])[0].description;
  assert.equal(said('pending'), 'pending. Still starting.');
  assert.equal(said('warming-up'), 'warming-up');
  // A connected server with an empty list has been asked and has answered, so its row says so.
  assert.equal(said('connected'), 'connected, 0 tools');
  assert.equal(rows([server({ tools: ['read'], scope: '' })])[0].description, 'connected, 1 tool');
});

test('a failed row carries the error, which is the whole of the diagnosis', () => {
  const row = rows([server({ name: 'db', status: 'failed', error: 'spawn ENOENT', tools: [], scope: 'project' })])[0];
  assert.equal(row.description, 'failed, project scope. spawn ENOENT');
  assert.ok(row.name.includes('spawn ENOENT'), 'a reader who cannot see the row lost the error');
});

test('a row says everything the eye can see on it and what a press will do', () => {
  const [on, , , , off] = rows(FIVE);
  assert.equal(on.name, 'files. connected, 2 tools, project scope. Switched on. Press to switch it off.');
  assert.equal(off.name, 'old. disabled, local scope. Switched off. Press to switch it on.');
});

test('the reconnect row is added once when something failed, and never when nothing has', () => {
  const actions = (servers: readonly McpServer[]) => rows(servers).filter((i) => i.kind === 'action');
  assert.deepEqual(actions([server(), server({ name: 'db', status: 'pending', tools: [] })]), []);
  const one = actions(FIVE);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], {
    kind: 'action',
    value: 'reconnect',
    label: 'Reconnect the server that failed',
    description: '',
    checked: false,
    caution: false,
    name: 'Reconnect the server that failed. Press to try 1 server again.',
  });
  // However many failed, there is one row asking for them all, and it sits at the foot where
  // the reader reaches it after reading what went wrong.
  const many = rows([
    server({ status: 'failed', error: 'Connection closed', tools: [] }),
    server({ name: 'db', status: 'failed', error: 'spawn ENOENT', tools: [] }),
  ]);
  assert.equal(many.filter((i) => i.kind === 'action').length, 1);
  assert.equal(many[many.length - 1].label, 'Reconnect the servers that failed');
  assert.equal(MCP_RECONNECT, 'reconnect');
});

test('a press on a switched-off server asks for it on, and a press on any other asks for it off', () => {
  // The toggle request carries the desired state derived from the displayed server list.

  assert.equal(mcpToggleWanted(FIVE, 'old'), true);
  for (const name of ['files', 'db', 'auth', 'slow']) {
    assert.equal(mcpToggleWanted(FIVE, name), false, `a press on ${name}, which is on, asked for it to be switched on`);
  }
});

test('a press on a server that has gone from the list asks for nothing', () => {
  // Nothing rather than a guess, so a row left over from a reading that has since changed
  // sends no instruction about a server the agent no longer has.
  assert.equal(mcpToggleWanted(FIVE, 'gone'), null);
  assert.equal(mcpToggleWanted([], 'files'), null);
});

test('the servers a reconnect asks about are the failed ones, and only those', () => {
  // Reconnect selects failed servers only. Pending, needs-auth, and disabled servers receive no reconnect request.

  assert.deepEqual(
    failedServers(FIVE).map((s) => s.name),
    ['db'],
  );
  assert.deepEqual(failedServers([]), []);
  assert.deepEqual(failedServers(FIVE.filter((s) => s.status !== 'failed')), []);
});
