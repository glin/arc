// A session can be resumed from a terminal without knowing where its source record lives.
// The stable record identity is the only argument the current CLIs require.
//
// The panel words this command from the identity its session row carries, and a reader
// pastes the result into a shell. An identity that reads as anything but one argument gets
// no command: one carrying shell syntax, and one opening with a dash, which a CLI takes for
// a flag of its own.
const ONE_ARGUMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function resumeCommand(agent: string, sessionId: string): string | null {
  if (!ONE_ARGUMENT.test(sessionId)) {
    return null;
  }
  if (agent === 'claude') {
    return `claude --resume ${sessionId}`;
  }
  return agent === 'codex' ? `codex resume ${sessionId}` : null;
}
