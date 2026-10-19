import {
  SESSION_REQUEST_LIMITS,
  WindowChannel,
  type HostRegistration,
  type WindowState,
} from '../src/sessionrequests.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from '../src/temproot.ts';
import * as net from 'node:net';
import { Duplex } from 'node:stream';

export const state: WindowState = { folders: [], scopeReady: true, panelReady: false, panelVisible: false };

export function createWindowFixtures(channels: WindowChannel[], sockets: Duplex[]) {
  async function fixture(
    limits = { ...SESSION_REQUEST_LIMITS } as {
      lineBytes: number;
      lineDeadlineMs: number;
      connections: number;
      inFlight: number;
    },
    handler?: ConstructorParameters<typeof WindowChannel>[2],
  ) {
    const home = tempDir('window-channel-');
    const channel = new WindowChannel(home, limits, handler);
    channels.push(channel);
    await channel.update(state);
    const file = path.join(home, 'hosts', `${channel.hostId}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as HostRegistration;
    return { home, channel, file, entry };
  }

  async function connect(address: string): Promise<net.Socket> {
    const socket = net.createConnection(address);
    sockets.push(socket);
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return socket;
  }

  return { fixture, connect };
}

export function request(entry: HostRegistration, changes = {}) {
  return { id: 'request-1', version: 1, token: entry.token, method: 'ping', requester: null, params: {}, ...changes };
}

export function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

export function reply(socket: net.Socket): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]));
    });
    socket.once('close', () => reject(new Error('Channel closed before its reply.')));
  });
}
