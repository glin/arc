import * as os from 'node:os';
import * as path from 'node:path';

export function claudeConfigHome(): string {
  return path.normalize(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

export function codexHome(): string {
  return path.normalize(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}
