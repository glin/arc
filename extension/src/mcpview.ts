// Normalize reported MCP servers and build their panel control, menu rows, and toggle requests.
// Preserve reported status words, including unfamiliar states.

import { McpServer, arr, obj, str } from './agentwire';
// Import menu types without creating a runtime cycle with `composerview.ts`.
import type { Menu, MenuItem } from './composerview';

// Status words used for failure tone, disabled toggles, and known tool counts.
const FAILED = 'failed';
const DISABLED = 'disabled';
const CONNECTED = 'connected';

// Add explanatory text for starting and authentication states without replacing their reported status.
// Map lookup excludes inherited object keys.
const STATE_NOTES = new Map<string, string>([
  ['pending', 'Still starting.'],
  ['needs-auth', 'Wants a login, which cannot be given from here.'],
]);

// Reconnect action value sent by a menu press.
export const MCP_RECONNECT = 'reconnect';

// Preserve server order and normalize optional fields to empty values.
// Drop entries without a nonempty name because actions identify servers by name.
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
      // Preserve the reported status word.
      status: str(server.status) ?? '',
      error: str(server.error) ?? '',
      // Keep nonempty tool names and ignore other tool fields.
      tools: arr(server.tools)
        .map((tool) => str(obj(tool)?.name) ?? '')
        .filter(Boolean),
      scope: str(server.scope) ?? '',
      // Display name reported in serverInfo, distinct from the configured server name.
      title: str(obj(server.serverInfo)?.name) ?? '',
    });
  }
  return servers;
}

// Add the noun with singular wording at one.
function countWord(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function isFailed(server: McpServer): boolean {
  return server.status === FAILED;
}

// Select servers whose reported status is failed.
export function failedServers(servers: readonly McpServer[]): McpServer[] {
  return servers.filter(isFailed);
}

function failedCount(servers: readonly McpServer[]): number {
  return failedServers(servers).length;
}

// Include the failed count only when at least one server failed.
function serversLabel(servers: readonly McpServer[]): string {
  const failed = failedCount(servers);
  const count = countWord(servers.length, 'server');
  return failed ? `${count}, ${failed} failed` : count;
}

// Trim text and add a full stop unless it ends with sentence punctuation.
// Keep this helper local to avoid a runtime import cycle with `composerview.ts`.
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// MCP control presentation in the prompt box.
export interface McpPick {
  // Visible server count with failure count when nonzero.
  label: string;
  // Accessible name with server counts and the available menu actions.
  name: string;
  // Hover detail.
  detail: string;
  // Use caution tone when a server reports failed.
  caution: boolean;
}

// Return no picker when the reported server list is empty.
export function mcpPick(servers: readonly McpServer[], agentName: string): McpPick | null {
  if (!servers.length) {
    return null;
  }
  const failed = failedCount(servers);
  const label = serversLabel(servers);
  // Read-only lists offer inspection. Mutable lists offer toggles and reconnection when a server failed.
  const readOnly = servers.every((server) => server.mutable === false);
  const press = readOnly
    ? 'Press to inspect them.'
    : failed
      ? 'Press to switch one off or on, or to try the failed ones again.'
      : 'Press to switch one off or on.';
  // Describe failures using the same status counted by the control.
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

// Show tool counts for connected or ready servers, or any server with reported tools.
function saysTools(server: McpServer): boolean {
  return server.status === CONNECTED || server.status === 'ready' || server.tools.length > 0;
}

// Combine the reported status, known tool count, and scope.
// Append state explanations and reported errors without replacing the status word.
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
  // Include both the known-state explanation and any reported error.
  const after = [STATE_NOTES.get(server.status) ?? '', server.error].filter(Boolean).join(' ');
  const line = parts.join(', ');
  if (!after) {
    return line;
  }
  return line ? `${sentence(line)} ${after}` : after;
}

// Announce the server name and description. Mutable rows also announce toggle state and the next action.
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
  // Only disabled marks a server switched off. Failed and pending servers remain checked.
  const checked = server.status !== DISABLED;
  const description = serverDescription(server);
  return {
    kind: server.mutable === false ? 'status' : 'toggle',
    // Use the configured server name for the row and its action value.
    value: server.name,
    label: server.name,
    description,
    checked,
    caution: isFailed(server),
    name: serverRowName(server, description, checked),
  };
}

// Build the reconnect action appended for failed servers in a mutable menu.
function reconnectRow(failed: number): MenuItem {
  const label = failed === 1 ? 'Reconnect the server that failed' : 'Reconnect the servers that failed';
  return {
    kind: 'action',
    value: MCP_RECONNECT,
    label,
    description: '',
    // Reconnection is an action without checked state or caution tone.
    checked: false,
    caution: false,
    name: `${label}. Press to try ${countWord(failed, 'server')} again.`,
  };
}

// Build server rows in reported order, with an empty-menu answer when no servers are reported.
export function mcpMenu(servers: readonly McpServer[], agent: string, agentName: string): Menu | null {
  const readOnly = agent === 'codex' || servers.every((server) => server.mutable === false);
  // An empty list still opens a menu through the agent command. `mcpPick` omits the empty picker.
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
  // Preserve reported order so status changes do not reorder rows.
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
    // Nonempty menus need no empty-state message.
    empty: '',
  };
}

// Request enabled state only for a disabled server. Request disabled state for every other reported status.
// Read the newest supplied list by configured server name. Return null when the server is absent.
export function mcpToggleWanted(servers: readonly McpServer[], name: string): boolean | null {
  const server = servers.find((s) => s.name === name);
  if (!server) {
    return null;
  }
  return server.status === DISABLED;
}
