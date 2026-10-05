// What the panel says about an agent's MCP servers, and what a reading of them means.
//
// An agent can only reach as far as the servers behind it, and a server that has fallen over
// takes its tools with it without saying so. Nothing announces the loss: the agent simply
// stops being able to do a thing it could do yesterday, and the next turn quietly does less
// than the last one. So the control exists to put that on screen before a turn is spent
// finding out, and the menu behind it lets the reader switch a server off or ask for the
// failed ones to be tried again.
//
// Nothing here narrows what the agent said. The CLI's schema names five states and every one
// of them is written for below, but a status word still reaches the screen exactly as it
// arrived: the schema is free to gain a sixth, and a panel that recognised only the five
// would either drop a server it could not place or call an unfamiliar one broken. Both are
// the panel claiming something it was never told, which is worse than an unfamiliar word.
//
// Every word the reader sees is written here, the same split the composer's own controls are
// built on: the webview inserts strings and decides nothing. This file imports no `vscode`,
// so the tests reach all of it.

import { McpServer, arr, obj, str } from './agentwire';
// Types only. `composerview.ts` imports the two builders below, so a value taken from it here
// would leave the pair needing each other at load time; a type import is erased before the
// module ever runs and cannot close that loop.
import type { Menu, MenuItem } from './composerview';

// The three states the panel has to act on, out of the five the schema names. Only one is a
// fault worth a caution tone, only one means somebody switched the server off, and only one
// makes an empty tool list an answer rather than a silence. The other two, a server still
// starting and a server wanting a login, are read as text like any word the panel has never
// seen, because neither changes what a press does or what the row is drawn as.
const FAILED = 'failed';
const DISABLED = 'disabled';
const CONNECTED = 'connected';

// The two states whose own word does not say enough on its own.
//
// A row saying only "pending" leaves a reader wondering whether the server is broken, and one
// saying only "needs-auth" leaves them looking for the button that logs in. Both get a plain
// sentence after the agent's word, never in place of it. The login cannot be given from this
// panel in this version, so the row says so rather than implying a control that is not there.
//
// A Map rather than a table object, so a server in a state named `constructor` is looked up
// and found missing instead of finding a function on the prototype.
const STATE_NOTES = new Map<string, string>([
  ['pending', 'Still starting.'],
  ['needs-auth', 'Wants a login, which cannot be given from here.'],
]);

// What the reader may press on a menu row that is not a server. It goes back on the wire as
// itself, so it is written once here rather than spelled again wherever a press is read.
export const MCP_RECONNECT = 'reconnect';

// The servers in one answer, in the order the agent listed them.
//
// The optional halves really are absent rather than empty: a connected server carries
// `serverInfo` and `tools` and no `error`, a failed one carries the error and neither of the
// others. So every field is read one at a time and an absent one becomes the empty value for
// its type, which is what the panel draws when the agent said nothing.
//
// An entry with no name is dropped. The name is the only handle the reader has on a server:
// it is the row's label, and it is what goes back on the wire when they switch it off. A row
// carrying neither would be one the reader can see and cannot act on.
export function readMcpServers(v: unknown): McpServer[] {
  const servers: McpServer[] = [];
  for (const entry of arr(obj(v)?.mcpServers)) {
    const server = obj(entry);
    if (!server) {
      continue;
    }
    const name = str(server.name) ?? '';
    if (!name) {
      continue;
    }
    servers.push({
      name,
      // Taken as it arrived. This is the one field the panel is most tempted to tidy, and
      // tidying it is how a state the agent reported becomes a state the panel guessed.
      status: str(server.status) ?? '',
      error: str(server.error) ?? '',
      // Each tool is an object with a name and whatever else that version publishes, and only
      // the name is drawn. A tool with no name is dropped for the same reason a server with
      // none is: it would count towards a total and be nothing the reader could look up.
      tools: arr(server.tools)
        .map((tool) => str(obj(tool)?.name) ?? '')
        .filter(Boolean),
      scope: str(server.scope) ?? '',
      // What the server calls itself, which it only says once it is up. Different from the
      // key it is configured under more often than not.
      title: str(obj(server.serverInfo)?.name) ?? '',
    });
  }
  return servers;
}

// A count with its own noun, singular at one. Written once because the control counts servers
// and the rows count tools, and a second copy of the rule is how "1 servers" reaches a screen.
function countWord(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function isFailed(server: McpServer): boolean {
  return server.status === FAILED;
}

// The servers a reconnect is actually asking about.
//
// Exported because the press that reconnects them is sent from `extension.ts`, which imports
// `vscode` and which no test can reach. Left there, working out which servers had failed
// would mean spelling the agent's word for the state in that file, so the panel would hold
// two answers to "which of these is broken" with only one of them under a test. It is the
// same reason `mcpToggleWanted` below is here rather than beside its caller.
export function failedServers(servers: readonly McpServer[]): McpServer[] {
  return servers.filter(isFailed);
}

function failedCount(servers: readonly McpServer[]): number {
  return failedServers(servers).length;
}

// What the control reads: how many servers there are, and how much trouble they are in.
//
// The trouble is said only when there is some. A control that always ended in "0 failed"
// would make a real failure just another number in a line the eye has learned to skip, and
// spotting it at a glance is the whole job of the word.
function serversLabel(servers: readonly McpServer[]): string {
  const failed = failedCount(servers);
  const count = countWord(servers.length, 'server');
  return failed ? `${count}, ${failed} failed` : count;
}

// Text that has to sit beside other text in one spoken line, so a sentence that came without
// a full stop is given one and a sentence that came with one is left alone. The composer
// writes its own row names through the same shape, and the two cannot share it: pulling a
// value out of `composerview.ts` is the load-time loop the type import above avoids.
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// The control on the composer row, written whole here the way the model and ask controls are.
export interface McpPick {
  // What the eye reads: the count, and the trouble when there is any.
  label: string;
  // The button's accessible name, carrying both halves always: what the control is, and what
  // it is set to. A reader who cannot see the row gets this and nothing else, and a name
  // saying only "5 servers" names no question.
  name: string;
  // The button's hover.
  detail: string;
  // Drawn in the caution tone, which here means a server is down and the tools behind it are
  // not there to be called.
  caution: boolean;
}

// The control, or nothing at all for a machine that has no MCP servers configured.
//
// Nothing is the honest answer there. A control reading "0 servers" takes a place on a row
// that has three other settings on it and answers a question the reader never asked, and the
// menu behind it would open on an empty box.
export function mcpPick(servers: readonly McpServer[], agentName: string): McpPick | null {
  if (!servers.length) {
    return null;
  }
  const failed = failedCount(servers);
  const label = serversLabel(servers);
  // What a press does, which changes with the trouble: the menu grows a way to try the failed
  // servers again, and a name that never mentioned it would hide the one row the reader
  // opened the menu for.
  const readOnly = servers.every((server) => server.mutable === false);
  const press = readOnly
    ? 'Press to inspect them.'
    : failed
      ? 'Press to switch one off or on, or to try the failed ones again.'
      : 'Press to switch one off or on.';
  // Said in the agent's own word for the state, so the hover and the row it hangs off cannot
  // describe one server two ways.
  const trouble = failed
    ? ` ${countWord(failed, 'server')} failed, so ${failed === 1 ? 'its' : 'their'} tools cannot be called.`
    : '';
  return {
    label,
    name: `MCP servers: ${label}. ${press}`,
    detail: `The servers ${agentName} can call tools on.${trouble}`,
    caution: failed > 0,
  };
}

// Whether the agent has actually answered for this server's tools.
//
// A connected server's empty list is an answer: the agent has the connection and the server
// offered nothing. A server that has not connected has told the agent nothing about its
// tools, so "0 tools" on a row for one is a claim the agent never made. A server in some
// other state that listed tools anyway has answered too, and is taken at its word.
function saysTools(server: McpServer): boolean {
  return server.status === CONNECTED || server.status === 'ready' || server.tools.length > 0;
}

// What one row says under the server's name: the state, how much it offers, and where it is
// configured. A failed server carries its error as well, which is the reader's whole
// diagnosis and the only part of the row they can act on.
//
// The state is the agent's own word every time. It is not translated and never swapped for
// the word the panel thinks it implies, so a state nobody has met reads as whatever the agent
// called it. Where the word alone leaves a question open, the plain answer follows it in a
// sentence of its own, in the same place the error goes.
function serverDescription(server: McpServer): string {
  const parts: string[] = [];
  if (server.status) {
    parts.push(server.status);
  }
  if (saysTools(server)) {
    parts.push(countWord(server.tools.length, 'tool'));
  }
  if (server.scope) {
    parts.push(`${server.scope} scope`);
  }
  // What the state means and what went wrong sit together, because they answer one question:
  // what this row means for the reader. No server carries both, since only a failed server
  // has an error and `failed` is a word that needs no explaining.
  const after = [STATE_NOTES.get(server.status) ?? '', server.error].filter(Boolean).join(' ');
  const line = parts.join(', ');
  if (!after) {
    return line;
  }
  return line ? `${sentence(line)} ${after}` : after;
}

// What one row says to a reader who cannot see it: the name, everything written under it, and
// what pressing it will do. That last part is what makes a toggle worth announcing at all,
// since a row that only said "switched on" leaves the reader to guess whether a press turns
// it off or opens something.
//
// The caution tone gets no sentence of its own, unlike the composer's rows, because what it
// stands for here is already in the description twice over: the agent's word for the state,
// and the error underneath it.
function serverRowName(server: McpServer, description: string, checked: boolean): string {
  if (server.mutable === false) {
    return [sentence(server.name), description ? sentence(description) : ''].filter(Boolean).join(' ');
  }
  return [
    sentence(server.name),
    description ? sentence(description) : '',
    checked ? 'Switched on.' : 'Switched off.',
    checked ? 'Press to switch it off.' : 'Press to switch it on.',
  ]
    .filter(Boolean)
    .join(' ');
}

function serverRow(server: McpServer): MenuItem {
  // A server is drawn switched off only where somebody switched it off, which across every
  // state the schema names is the one word below. A server that failed, or is still starting,
  // or wants a login, is on: drawing any of them unticked would tell the reader they had
  // turned it off themselves and send them to undo something they never did, while the real
  // trouble went on standing.
  const checked = server.status !== DISABLED;
  const description = serverDescription(server);
  return {
    kind: server.mutable === false ? 'status' : 'toggle',
    // The server's own name, which is both what the row reads and what goes back on the wire.
    value: server.name,
    label: server.name,
    description,
    checked,
    caution: isFailed(server),
    name: serverRowName(server, description, checked),
  };
}

// The row at the foot that asks for the failed servers to be tried again. It appears only
// when something has failed, so a menu over healthy servers offers nothing to fix.
function reconnectRow(failed: number): MenuItem {
  const label = failed === 1 ? 'Reconnect the server that failed' : 'Reconnect the servers that failed';
  return {
    kind: 'action',
    value: MCP_RECONNECT,
    label,
    description: '',
    // An action has no state. A tick would say it was on, and the caution tone belongs to the
    // servers that are in trouble rather than to the thing that mends them.
    checked: false,
    caution: false,
    name: `${label}. Press to try ${countWord(failed, 'server')} again.`,
  };
}

// The menu the control opens, or nothing at all where there are no servers, which is the same
// answer `mcpPick` gives to the same machine. The control is not drawn, so there is no menu
// to open and no line to write about being empty.
export function mcpMenu(servers: readonly McpServer[], agent: string, agentName: string): Menu | null {
  const readOnly = agent === 'codex' || servers.every((server) => server.mutable === false);
  // An agent with no servers still answers, because the reader can reach this menu by typing
  // the agent's own `/mcp` and a menu that refused to open would read as a broken command.
  // The picker row is a different question: `mcpPick` still draws no control there, so a
  // count of zero never takes a place on the row beside the settings.
  if (!servers.length) {
    return {
      control: 'mcp',
      agent,
      head: readOnly
        ? `Which servers can ${agentName} call tools on?`
        : `Which servers should ${agentName} be able to call tools on?`,
      items: [],
      empty: `${agentName} has no MCP servers in this folder. Add one with the agent's own command line, and it will be here the next time the panel asks.`,
    };
  }
  const failed = failedCount(servers);
  // In the order the agent listed them. Sorting the broken ones to the top would move a row
  // out from under the reader the moment a server fell over, which is the moment they are
  // most likely to be pressing one.
  const items: MenuItem[] = servers.map(serverRow);
  if (failed && !readOnly) {
    items.push(reconnectRow(failed));
  }
  return {
    control: 'mcp',
    agent,
    head: readOnly
      ? `Which servers can ${agentName} call tools on?`
      : `Which servers should ${agentName} be able to call tools on?`,
    items,
    // Never reached. This builder answers with nothing rather than with an empty menu, so
    // there is no state in which the popover has rows to draw and none to draw.
    empty: '',
  };
}

// Which way a press on one server's row is asking to set it, or nothing at all for a server
// that is no longer in the list.
//
// The wire's toggle sets a state rather than flipping one: it is told what the server should
// be, and being told the same thing twice does nothing the second time. So a press has to
// carry a direction with it. Worked out at the far end instead, the direction would come from
// a fresh reading of the servers, and a server that changed between the draw and the press
// would be set to the opposite of what the reader asked for.
//
// Read here, off the newest reading rather than off a snapshot pinned to the press, which is
// the same list the row was last drawn from and not quite the same thing as the list the
// reader was looking at. The two can differ for as long as it takes a repaint to run, since
// whatever replaces the reading also redraws the open menu. Narrowing that to nothing would
// mean sending the drawn state with the press, and the press carries only a name.
//
// It is written in this file rather than beside the call that sends it because that call
// lives in `extension.ts`, which imports `vscode`, and no test can reach a decision made
// there.
//
// A server nobody switched off is on, whatever else is wrong with it. One that failed and one
// waiting for a login are both on, so a press on either is asking for it to go off, and only
// a server already switched off answers the other way.
export function mcpToggleWanted(servers: readonly McpServer[], name: string): boolean | null {
  const server = servers.find((s) => s.name === name);
  if (!server) {
    return null;
  }
  return server.status === DISABLED;
}
