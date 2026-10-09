import type { SessionFile } from './transcript';
import { shortenTo } from './domain/text';
import type { ExportCaptureOptions } from './exportdata';
import { completeSessionExport } from './exportdata';
import { packagedExportAssets } from './exportassets';
import { projectSessionSite } from './exportsite';
import { ExportCancelled, withExportTransaction } from './exportwriter';

export function savedExportSource(session: string, sources: readonly SessionFile[]): SessionFile | null {
  const matches = sources.filter((source) => source.sessionId === session);
  return matches.length === 1 ? { ...matches[0] } : null;
}

export const EXPORT_CONFIRMATION =
  'The export includes recorded prompts, responses, commentary and linked session work. Text can contain secrets, paths and addresses. Inspect the complete export before sharing it.';

export interface SessionExportPorts {
  confirm(title: string, detail: string): PromiseLike<boolean>;
  chooseFolder(): PromiseLike<string | undefined>;
  progress<T>(
    title: string,
    operation: (signal: AbortSignal, report: (message: string) => void) => Promise<T>,
  ): PromiseLike<T>;
  write(destination: string, options: ExportCaptureOptions): Promise<{ index: string }>;
  completed(title: string, index: string): PromiseLike<void>;
  failed(message: string): void;
}

const PHASES = {
  inventory: 'Finding saved sessions',
  relationships: 'Finding linked work',
  text: 'Reading recorded text',
  numbers: 'Reading recorded figures',
  checking: 'Checking saved sources',
};

export async function exportSavedSession(
  source: SessionFile | null,
  title: string,
  options: Omit<ExportCaptureOptions, 'root' | 'signal' | 'progress'>,
  ports: SessionExportPorts,
): Promise<void> {
  const displayTitle = shortenTo(title.replace(/\s+/g, ' ').trim(), 80, '...');
  if (!source) {
    ports.failed(`Arc: ${displayTitle} is unavailable or ambiguous.`);
    return;
  }
  const root = { ...source };
  try {
    if (!(await ports.confirm(`Export ${displayTitle} as HTML?`, EXPORT_CONFIRMATION))) return;
    const destination = await ports.chooseFolder();
    if (!destination) return;
    const result = await ports.progress(`Exporting ${displayTitle}`, (signal, report) =>
      ports.write(destination, {
        ...options,
        root,
        signal,
        progress(phase, sessions) {
          report(`${PHASES[phase]} (${sessions} sessions)`);
        },
      }),
    );
    try {
      await ports.completed(displayTitle, result.index);
    } catch {
      ports.failed(`Arc: ${displayTitle} was exported but did not open.`);
    }
  } catch (error) {
    if (!(error instanceof ExportCancelled))
      ports.failed(
        `Arc: ${displayTitle} was not exported. ${error instanceof Error ? error.message : 'The export failed.'}`,
      );
  }
}

export async function writeSavedSession(
  destination: string,
  extensionDirectory: string,
  options: ExportCaptureOptions,
): Promise<{ index: string }> {
  const assets = await packagedExportAssets(extensionDirectory);
  return withExportTransaction(
    destination,
    (writer) =>
      completeSessionExport(writer, options, (capture, transaction) =>
        projectSessionSite(capture.model, transaction, assets),
      ),
    options.signal,
  );
}
