// Draw the editor context menu stand-in for README captures and the web demo.
// Menu entries come from the manifest. Their context comes from the production panel's data-vscode-context.

export interface MenuEntry {
  command: string;
  title: string;
  group: string;
  when: string;
}

export type MenuContext = Record<string, unknown>;

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; group?: string; when?: string }[]>;
  };
}

// Commands offered by the demo menu, including host actions that the adapter leaves inactive.
export const DEMO_MENU_COMMANDS: ReadonlySet<string> = new Set([
  'arc.pinSession',
  'arc.unpinSession',
  'arc.markSessionRead',
  'arc.markSessionUnread',
  'arc.archiveSession',
  'arc.unarchiveSession',
  'arc.labelSession',
  'arc.newSessionWithLabels',
  'arc.copySessionId',
  'arc.showSessionDetails',
  'arc.markTurnRead',
  'arc.markTurnUnread',
  'arc.copyTurnSummary',
  'arc.commentOnTurn',
  'arc.sendSelectedTextWithLabels',
  'arc.sendSelectedText',
  'arc.sendResponseLinkWithLabels',
  'arc.sendResponseLink',
]);

// Validate every manifest when clause, including excluded entries. Unsupported grammar stops the build.
export function manifestMenu(manifest: Manifest, commands?: ReadonlySet<string>): MenuEntry[] {
  const titles = new Map(manifest.contributes.commands.map((command) => [command.command, command.title]));
  const entries = manifest.contributes.menus['webview/context'] ?? [];
  for (const entry of entries) whenHolds(entry.when ?? '', {});
  return entries
    .filter((entry) => !commands || commands.has(entry.command))
    .map((entry) => ({
      command: entry.command,
      title: titles.get(entry.command) ?? entry.command,
      group: entry.group ?? '',
      when: entry.when ?? '',
    }));
}

// Read keys, ==, !=, !, &&, ||, parentheses, and quoted or bare values in when clauses.
// Reject other operators and leftover tokens.
export function whenHolds(expression: string, context: MenuContext): boolean {
  if (!expression.trim()) return true;
  const fail = (reason: string): never => {
    throw new Error(`The menu stand-in cannot read the when clause "${expression}": ${reason}.`);
  };
  const tokens: string[] = [];
  const lexer = /\s*('[^']*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.:-]*)/y;
  while (lexer.lastIndex < expression.length) {
    if (!expression.slice(lexer.lastIndex).trim()) break;
    const start = lexer.lastIndex;
    const match = lexer.exec(expression);
    if (!match) fail(`unsupported text at "${expression.slice(start).trim()}"`);
    tokens.push(match![1]);
  }
  const word = (token: string | undefined) => token !== undefined && /^[A-Za-z_]/.test(token);
  let at = 0;
  const value = (token: string | undefined): unknown => {
    if (token?.startsWith("'")) return token.slice(1, -1);
    if (!word(token)) fail(`a comparison has no value after "${tokens[at - 2]} ${tokens[at - 1]}"`);
    return token === 'true' ? true : token === 'false' ? false : token;
  };
  const primary = (): boolean => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = or();
      if (tokens[at++] !== ')') fail('a parenthesis is not closed');
      return inner;
    }
    if (token === '!') return !primary();
    if (!word(token)) fail(token === undefined ? 'it ends early' : `unexpected "${token}"`);
    const actual = context[token];
    if (tokens[at] === '==' || tokens[at] === '!=') {
      const equal = tokens[at++] === '==';
      const expected = value(tokens[at++]);
      return (actual === expected || String(actual) === String(expected)) === equal;
    }
    return !!actual;
  };
  const and = (): boolean => {
    let result = primary();
    while (tokens[at] === '&&') {
      at++;
      result = primary() && result;
    }
    return result;
  };
  const or = (): boolean => {
    let result = and();
    while (tokens[at] === '||') {
      at++;
      result = and() || result;
    }
    return result;
  };
  const result = or();
  if (at < tokens.length) fail(`unexpected "${tokens[at]}"`);
  return result;
}

// Group visible entries in editor order: navigation, other group names, then each entry's number after @.
export function menuGroups(entries: readonly MenuEntry[], context: MenuContext): MenuEntry[][] {
  const groups = new Map<string, { order: number; entry: MenuEntry }[]>();
  for (const entry of entries) {
    if (!whenHolds(entry.when, context)) continue;
    const [name, order] = entry.group.split('@');
    const list = groups.get(name) ?? [];
    list.push({ order: Number(order) || 0, entry });
    groups.set(name, list);
  }
  return [...groups.keys()]
    .sort((a, b) => (a === 'navigation' ? -1 : b === 'navigation' ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map((name) =>
      groups
        .get(name)!
        .sort((a, b) => a.order - b.order)
        .map((item) => item.entry),
    );
}

// Combine ancestor data-vscode-context values. The nearest element wins.
export function contextAt(node: Element | null): MenuContext {
  const chain: MenuContext[] = [];
  for (let at = node; at; at = at.parentElement) {
    const raw = (at as HTMLElement).dataset?.vscodeContext;
    if (!raw) continue;
    try {
      chain.push(JSON.parse(raw) as MenuContext);
    } catch {
      // Ignore context that does not parse as JSON.
    }
  }
  return Object.assign({}, ...chain.reverse()) as MenuContext;
}

// Open for contextmenu events with visible entries. Otherwise, keep the browser menu.
export function installMenu(
  document: Document,
  entries: readonly MenuEntry[],
  choose: (command: string, context: MenuContext) => void,
): void {
  const view = document.defaultView!;
  let close: ((restore: boolean) => void) | null = null;
  view.addEventListener('contextmenu', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('.demo-menu')) return;
    close?.(false);
    const context = contextAt(target);
    const groups = menuGroups(entries, context);
    if (!groups.length) return;
    event.preventDefault();
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = document.createElement('div');
    menu.className = 'demo-menu';
    menu.setAttribute('role', 'menu');
    groups.forEach((group, index) => {
      if (index) {
        const line = document.createElement('div');
        line.setAttribute('role', 'separator');
        menu.append(line);
      }
      for (const entry of group) {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.tabIndex = -1;
        item.textContent = entry.title;
        item.addEventListener('click', () => {
          close?.(true);
          choose(entry.command, context);
        });
        menu.append(item);
      }
    });
    document.body.append(menu);
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const box = target.getBoundingClientRect();
    const synthetic = event.clientX === 0 && event.clientY === 0;
    const x = synthetic ? box.left : event.clientX;
    const y = synthetic ? box.bottom : event.clientY;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(0, x + width > view.innerWidth ? view.innerWidth - width : x)}px`;
    menu.style.top = `${Math.max(0, y + height > view.innerHeight ? y - height : y)}px`;
    const outside = (down: Event) => {
      if (!(down.target instanceof Node) || !menu.contains(down.target)) close?.(false);
    };
    const shut = (restore: boolean) => {
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
      view.removeEventListener('blur', blur);
      close = null;
      if (restore && opener?.isConnected) opener.focus();
    };
    const blur = () => shut(false);
    close = shut;
    document.addEventListener('pointerdown', outside, true);
    view.addEventListener('blur', blur);
    menu.addEventListener('keydown', (key) => {
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        key.key === 'ArrowDown'
          ? (index + 1) % items.length
          : key.key === 'ArrowUp'
            ? (index - 1 + items.length) % items.length
            : key.key === 'Home'
              ? 0
              : key.key === 'End'
                ? items.length - 1
                : -1;
      if (next >= 0) {
        key.preventDefault();
        items[next].focus();
      } else if (key.key === 'Escape' || key.key === 'Tab') {
        key.preventDefault();
        shut(true);
      }
    });
    items[0].focus();
  });
}
