import * as os from "node:os";
import * as path from "node:path";
function claudeConfigHome() {
  return path.normalize(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}
function codexHome() {
  return path.normalize(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}
export {
  claudeConfigHome,
  codexHome
};
