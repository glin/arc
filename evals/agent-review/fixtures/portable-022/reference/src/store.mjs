import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ARC_IDENTITY } from "./identity.mjs";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isManifestEntry(value) {
  return isRecord(value) && typeof value.path === "string" && value.path.length > 0 && typeof value.snapshot === "string" && value.snapshot.length > 0 && typeof value.isNew === "boolean";
}
function isManifest(value) {
  return isRecord(value) && typeof value.sessionId === "string" && value.sessionId.length > 0 && (value.cwd === null || typeof value.cwd === "string") && (value.title === void 0 || value.title === null || typeof value.title === "string") && Array.isArray(value.files) && value.files.every(isManifestEntry);
}
function arcHome() {
  return process.env[`${ARC_IDENTITY.environmentPrefix}HOME`] || path.join(os.homedir(), ARC_IDENTITY.homeDirectory);
}
function storeRoot() {
  return path.join(arcHome(), ARC_IDENTITY.snapshotsDirectory);
}
function cacheRoot() {
  return path.join(arcHome(), "cache");
}
function projectSpendDirectory(workspaceCacheRoot) {
  return path.join(workspaceCacheRoot, "project-spend");
}
function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === void 0) {
    throw new Error("A workspace identity holds a value that cannot be written to JSON.");
  }
  return encoded;
}
function normalizedWorkspaceFolder(folder) {
  const unified = path.resolve(folder).replace(/\\/g, "/").replace(/\/$/, "");
  return /^[A-Za-z]:\//.test(unified) || process.platform === "win32" ? unified.toLowerCase() : unified;
}
function normalizedWorkspaceIdentity(folders, workspaceFile = null) {
  return {
    workspaceFile: workspaceFile ? normalizedWorkspaceFolder(workspaceFile) : null,
    folders: [...new Set(folders.map(normalizedWorkspaceFolder))].sort()
  };
}
function workspaceCacheKey(identity) {
  if (identity.workspaceFile === null && identity.folders.length === 0) {
    return null;
  }
  return crypto.createHash("sha256").update(stableJson(identity)).digest("hex");
}
function rejectLinkedDestination(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Saved data cannot be written through a linked folder or file: ${current}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
function createWorkspaceCacheRoot(cacheDirectory, identity) {
  const resolvedCacheDirectory = path.resolve(cacheDirectory);
  rejectLinkedDestination(resolvedCacheDirectory);
  fs.mkdirSync(resolvedCacheDirectory, { recursive: true });
  const reusableKey = workspaceCacheKey(identity);
  if (reusableKey) {
    const partition = path.join(resolvedCacheDirectory, reusableKey);
    rejectLinkedDestination(partition);
    return partition;
  }
  return fs.mkdtempSync(path.join(resolvedCacheDirectory, "folderless-"));
}
function readManifest(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return isManifest(value) ? value : null;
  } catch {
    return null;
  }
}
function tabLabelMatchesTitle(tabLabel, title) {
  return tabLabel === title || tabLabel.startsWith(`${title} (`);
}
function isPathWithin(target, folders) {
  if (!target) {
    return false;
  }
  return folders.some((f) => {
    if (!f) {
      return false;
    }
    const base = f.endsWith(path.sep) ? f.slice(0, -1) : f;
    return target === base || target.startsWith(base + path.sep);
  });
}
const COMPARE_CHUNK = 1 << 20;
function filesEqual(a, b, size) {
  let fa = -1, fb = -1;
  try {
    fa = fs.openSync(a, "r");
    fb = fs.openSync(b, "r");
    const bufA = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK, size));
    const bufB = Buffer.allocUnsafe(Math.min(COMPARE_CHUNK, size));
    let pos = 0;
    while (pos < size) {
      const n = fs.readSync(fa, bufA, 0, bufA.length, pos);
      const m = fs.readSync(fb, bufB, 0, bufB.length, pos);
      if (n !== m) {
        return false;
      }
      if (n <= 0) {
        return true;
      }
      if (!bufA.subarray(0, n).equals(bufB.subarray(0, m))) {
        return false;
      }
      pos += n;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fa >= 0) {
      try {
        fs.closeSync(fa);
      } catch {
      }
    }
    if (fb >= 0) {
      try {
        fs.closeSync(fb);
      } catch {
      }
    }
  }
}
function fileDiffersOnDisk(entry) {
  let liveStat;
  try {
    liveStat = fs.statSync(entry.path);
  } catch {
    return false;
  }
  if (!liveStat.isFile()) {
    return false;
  }
  const liveSize = liveStat.size;
  let baseSize = 0;
  try {
    baseSize = fs.statSync(entry.snapshot).size;
  } catch {
  }
  if (liveSize !== baseSize) {
    return true;
  }
  if (liveSize === 0) {
    return false;
  }
  return !filesEqual(entry.path, entry.snapshot, liveSize);
}
function pendingSessions(root, workspaceFolders) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const manifestFile = path.join(root, d, "manifest.json");
    const manifest = readManifest(manifestFile);
    if (!manifest || !manifest.cwd || !isPathWithin(manifest.cwd, workspaceFolders)) {
      continue;
    }
    const pending = manifest.files.filter(fileDiffersOnDisk);
    if (pending.length > 0) {
      out.push({ manifestFile, manifest: { ...manifest, files: pending } });
    }
  }
  return out;
}
const SNAPSHOT_KEEP_DAYS = 30;
function sweepOldSessions(root, maxAgeDays = SNAPSHOT_KEEP_DAYS, now = Date.now()) {
  if (!(maxAgeDays > 0)) {
    return [];
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    let mtime = stat.mtimeMs;
    try {
      mtime = fs.statSync(path.join(dir, "trigger")).mtimeMs;
    } catch {
    }
    if ((now - mtime) / 864e5 <= maxAgeDays) {
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(d);
    } catch {
    }
  }
  return removed;
}
export {
  SNAPSHOT_KEEP_DAYS,
  arcHome,
  cacheRoot,
  createWorkspaceCacheRoot,
  fileDiffersOnDisk,
  isPathWithin,
  normalizedWorkspaceIdentity,
  pendingSessions,
  projectSpendDirectory,
  readManifest,
  storeRoot,
  sweepOldSessions,
  tabLabelMatchesTitle,
  workspaceCacheKey
};
