export const compactWindow = 'a'.repeat(24);

export const compactPayload = {
  requestId: compactWindow + ':aaaaaaaa-1111-2222-3333-444444444444',
  window: compactWindow,
  self: true as const,
  afterTurn: true as const,
};
