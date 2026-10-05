import * as fs from "node:fs";
import * as path from "node:path";
const TEMPORARY_GRACE_MILLISECONDS = 6e4;
const TEMPORARY_NAME = /^(.+)\.(\d+)\.(\d+)\.tmp$/;
function temporaryIsStale(name, targetName, ownPid, now, running) {
  const parts = TEMPORARY_NAME.exec(name);
  if (!parts || parts[1] !== targetName) {
    return false;
  }
  if (Number(parts[2]) === ownPid) {
    return true;
  }
  if (now - Number(parts[3]) < TEMPORARY_GRACE_MILLISECONDS) {
    return false;
  }
  return !running(Number(parts[2]));
}
function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function removeStaleTemporaries(target) {
  const directory = path.dirname(target);
  const targetName = path.basename(target);
  const now = Date.now();
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!temporaryIsStale(name, targetName, process.pid, now, processIsRunning)) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(directory, name));
    } catch {
    }
  }
}
function writeFileAtomically(target, text, replace = fs.renameSync) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  removeStaleTemporaries(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, "utf8");
    replace(temporary, target);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
    }
  }
}
export {
  TEMPORARY_GRACE_MILLISECONDS,
  temporaryIsStale,
  writeFileAtomically
};
