export const STATIC_PAGE_RAIL_WIDTH = 380;

import { DEMO_SHELL } from './static-shell.ts';

export function staticPageBody(title: string, description: string, loading: string): string {
  return `<body class="vscode-dark" data-theme="onedark"><header class="demo-header"><div class="demo-heading"><strong>${title}</strong><span>${description}</span></div><div class="demo-tools"><label for="demo-theme">Theme</label><select id="demo-theme"><option value="onedark">One Dark Pro Darker</option><option value="dark">VS Code dark</option><option value="light">VS Code light</option></select></div></header>${DEMO_SHELL}<h1 class="sr-only">${title}</h1><main id="list" aria-label="Timeline"><p class="empty" data-startup-status role="status" aria-live="polite">${loading}</p></main>`;
}
