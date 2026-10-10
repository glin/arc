export const MAX_PATH_COMPLETIONS = 100;

export interface PathCompletionEntry {
  name: string;
  directory: boolean;
  symbolicLink?: boolean;
}

export interface PathCompletionReader {
  readDirectory(path: string): Promise<readonly PathCompletionEntry[]>;
  stat?(path: string): Promise<{ directory: boolean }>;
}

export interface PathCompletionOptions {
  token: string;
  workingDirectory: string;
  homeDirectory: string;
  platform: 'win32' | 'posix';
  reader: PathCompletionReader;
}

export interface PathCompletionResult {
  token: string;
  separator: '/' | '\\';
  prefix: string;
  entries: PathCompletionEntry[];
}

function separatorFor(token: string, platform: 'win32' | 'posix'): '/' | '\\' {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  if (slash >= 0) {
    return token[slash] === '\\' ? '\\' : '/';
  }
  return platform === 'win32' ? '\\' : '/';
}

function parentAndLeaf(token: string): { prefix: string; parent: string; leaf: string } {
  const at = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return at < 0
    ? { prefix: '', parent: '', leaf: token }
    : { prefix: token.slice(0, at + 1), parent: token.slice(0, at + 1), leaf: token.slice(at + 1) };
}

export function nativePath(value: string, platform: 'win32' | 'posix'): string {
  return platform === 'win32' ? value.replace(/\//g, '\\') : value.replace(/\\/g, '/');
}

function join(base: string, tail: string, platform: 'win32' | 'posix'): string {
  const separator = platform === 'win32' ? '\\' : '/';
  if (!tail) {
    return base;
  }
  return base.replace(/[\\/]+$/, '') + separator + tail.replace(/^[\\/]+/, '');
}

function windowsRoot(directory: string): string | null {
  const drive = /^[A-Za-z]:\\/.exec(directory);
  if (drive) {
    return `${directory.slice(0, 2)}\\`;
  }
  const share = /^(\\\\[^\\]+\\[^\\]+)(?:\\|$)/.exec(directory);
  return share ? `${share[1]}\\` : null;
}

function resolveParent(parent: string, options: PathCompletionOptions): string | null {
  const native = nativePath(parent, options.platform);
  if (native.startsWith(`~${options.platform === 'win32' ? '\\' : '/'}`)) {
    return join(options.homeDirectory, native.slice(2), options.platform);
  }
  if (options.platform === 'win32' && (/^[A-Za-z]:\\/.test(native) || native.startsWith('\\\\'))) {
    return native;
  }
  if (options.platform === 'win32' && native.startsWith('\\')) {
    const root = windowsRoot(nativePath(options.workingDirectory, 'win32'));
    return root ? join(root, native, 'win32') : null;
  }
  if (options.platform === 'posix' && native.startsWith('/')) {
    return native;
  }
  return join(options.workingDirectory, native, options.platform);
}

function lexical(platform: 'win32' | 'posix'): (left: string, right: string) => number {
  return platform === 'win32'
    ? (left, right) => left.localeCompare(right, undefined, { sensitivity: 'accent' })
    : (left, right) => left.localeCompare(right, undefined, { sensitivity: 'variant' });
}

export async function completePath(options: PathCompletionOptions): Promise<PathCompletionResult> {
  const { prefix, parent, leaf } = parentAndLeaf(options.token);
  const separator = separatorFor(options.token, options.platform);
  const directory = resolveParent(parent, options);
  if (!directory) {
    return { token: options.token, separator, prefix, entries: [] };
  }
  try {
    const read = await options.reader.readDirectory(directory);
    const needle = options.platform === 'win32' ? leaf.toLocaleLowerCase() : leaf;
    const matched = await Promise.all(
      read
        .filter((entry) => leaf.startsWith('.') || !entry.name.startsWith('.'))
        .filter((entry) =>
          (options.platform === 'win32' ? entry.name.toLocaleLowerCase() : entry.name).startsWith(needle),
        )
        .map(async (entry) => {
          if (!entry.symbolicLink || !options.reader.stat) {
            return entry;
          }
          try {
            return {
              ...entry,
              directory: (await options.reader.stat(join(directory, entry.name, options.platform))).directory,
            };
          } catch {
            return entry;
          }
        }),
    );
    matched.sort(
      (left, right) =>
        Number(right.directory) - Number(left.directory) || lexical(options.platform)(left.name, right.name),
    );
    return { token: options.token, separator, prefix, entries: matched.slice(0, MAX_PATH_COMPLETIONS) };
  } catch {
    return { token: options.token, separator, prefix, entries: [] };
  }
}
