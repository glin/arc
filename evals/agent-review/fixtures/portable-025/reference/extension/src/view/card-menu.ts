import { canMarkRead } from '../domain/read.ts';

export const TURN_MENU_SECTIONS = {
  read: 'arcTurnRead',
  unread: 'arcTurnUnread',
  readSummary: 'arcTurnReadSummary',
  unreadSummary: 'arcTurnUnreadSummary',
  summary: 'arcTurnSummary',
} as const;

export const SESSION_MENU_SECTIONS = {
  live: 'arcSessionLive',
  archived: 'arcSessionArchived',
} as const;

export type TurnMenuNode = 'head' | 'body';

export interface TurnMenuContext {
  key: string;
  session: string;
  arcTurn?: true;
  arcComments?: true;
  arcSelection?: true;
  sessionLabeled?: true;
  webviewSection?: string;
  preventDefaultContextMenuItems?: true;
}

export function turnMenuSection(
  card: { kind: string; live?: boolean; summary?: string },
  isRead: boolean,
): string | null {
  const summary = typeof card.summary === 'string' && card.summary.trim() !== '';
  if (!canMarkRead(card)) {
    return summary ? TURN_MENU_SECTIONS.summary : null;
  }
  if (summary) {
    return isRead ? TURN_MENU_SECTIONS.readSummary : TURN_MENU_SECTIONS.unreadSummary;
  }
  return isRead ? TURN_MENU_SECTIONS.read : TURN_MENU_SECTIONS.unread;
}

export function turnMenuContext(
  card: { kind: string; live?: boolean; summary?: string; key: string; sessionId: string },
  isRead: boolean,
  where: TurnMenuNode,
  hasComments: boolean,
  hasSelection: boolean = false,
  sessionLabeled: boolean = false,
): TurnMenuContext | null {
  const section = turnMenuSection(card, isRead);
  const comment = card.kind !== 'compaction';
  if (!section && !comment && !hasComments && !sessionLabeled) {
    return null;
  }
  const context: TurnMenuContext = { key: card.key, session: card.sessionId };
  if (comment) {
    context.arcTurn = true;
  }
  if (hasComments) {
    context.arcComments = true;
  }
  if (hasSelection) {
    context.arcSelection = true;
  }
  if (sessionLabeled) {
    context.sessionLabeled = true;
  }
  if (section) {
    context.webviewSection = section;
  }
  if (where === 'head') {
    context.preventDefaultContextMenuItems = true;
  }
  return context;
}
