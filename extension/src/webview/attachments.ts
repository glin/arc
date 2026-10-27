import { h, render, type ComponentChildren } from 'preact';
import { URI_DRAG_TYPES } from '../domain/prompt-assets.ts';
import type { ComposerFile, ComposerView, PanelToHost } from './protocol.ts';

interface AttachmentOptions {
  readOnly?: boolean;
  document: Document;
  composer: HTMLElement;
  prompt: HTMLTextAreaElement;
  mount: HTMLElement;
  noticeMount: HTMLElement;
  sendToHost(message: PanelToHost): void;
  session(): string | null;
  view(): ComposerView | null;
  updateFoot(): void;
  setDropping(dropping: boolean): void;
  limits: { count: number; fileBytes: number; totalBytes: number };
}

export interface AttachmentRenderer {
  update(view: ComposerView | null): void;
  submissionNotice(session: string, words: string | null): void;
  isStaging(session: string | null): boolean;
  pendingLabel(session: string): string;
  staging(session: string, pending: boolean, token: string, count?: number): void;
  rejected(session: string, token: string): void;
}

function FileChip(props: {
  file: ComposerFile;
  session: string;
  removable: boolean;
  sendToHost(message: PanelToHost): void;
  onRemove?(id: string, control: HTMLButtonElement): void;
}): ComponentChildren {
  const { file } = props;
  return h('div', { class: 'cfile', key: file.id, 'aria-label': file.label }, [
    file.preview ? h('img', { class: 'cthumb', src: file.preview, alt: '' }) : h('span', { class: 'ckind' }, file.kind),
    file.preview ? null : ' ',
    h('span', { class: 'cname' }, [
      h('span', { class: 'cstem', title: file.name }, file.stem),
      h('span', { class: 'cext' }, file.ext),
    ]),
    ' ',
    h('span', { class: 'csize' }, file.sizeLabel),
    props.removable && file.removeLabel
      ? [
          ' ',
          h(
            'button',
            {
              class: 'cfileremove',
              'aria-label': file.removeName,
              'data-control': file.removeControl,
              onClick(event) {
                props.onRemove?.(file.id, event.currentTarget as HTMLButtonElement);
                props.sendToHost({ type: 'removeFile', session: props.session, value: file.id });
              },
            },
            file.removeLabel,
          ),
        ]
      : null,
  ]);
}

export function AttachmentFiles(props: {
  session: string;
  files: ComposerFile[];
  removable: boolean;
  pending: string | null;
  sendToHost(message: PanelToHost): void;
  onRemove?(id: string, control: HTMLButtonElement): void;
}): ComponentChildren {
  return h('div', { class: 'cfiles' }, [
    ...props.files.map((file) =>
      h(FileChip, {
        key: file.id,
        file,
        session: props.session,
        removable: props.removable,
        sendToHost: props.sendToHost,
        onRemove: props.onRemove,
      }),
    ),
    props.pending ? h('div', { class: 'cfile cfilepending' }, props.pending) : null,
  ]);
}

function Notice(props: { words: string | null }): ComponentChildren {
  return props.words ? h('div', { class: 'cnotice', role: 'status' }, props.words) : null;
}

export function createAttachmentRenderer(options: AttachmentOptions): AttachmentRenderer {
  const sessions = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  const canceled = new Set<string>();
  let serial = 0;
  let dropDepth = 0;
  let current: ComposerView | null = null;
  // Each session keeps its own notice, so a returned send still explains itself after the reader switches away and back.
  const submissionNotices = new Map<string, string>();
  let pendingRemoval: { session: string; id: string; index: number; control: HTMLButtonElement } | null = null;

  const isStaging = (session: string | null): boolean => !!session && (sessions.get(session)?.size ?? 0) > 0;
  const pendingLabel = (session: string): string => {
    const count = [...(sessions.get(session) ?? [])].reduce((sum, token) => sum + (counts.get(token) ?? 1), 0);
    return `Attaching ${count} ${count === 1 ? 'file' : 'files'}…`;
  };
  const add = (session: string, token: string, count?: number) => {
    const tokens = sessions.get(session) ?? new Set<string>();
    tokens.add(token);
    sessions.set(session, tokens);
    if (count !== undefined) {
      counts.set(token, count);
    }
  };
  const release = (session: string, token: string) => {
    const tokens = sessions.get(session);
    if (!tokens) {
      return;
    }
    tokens.delete(token);
    if (!tokens.size) {
      sessions.delete(session);
    }
    if (![...sessions.values()].some((held) => held.has(token))) {
      counts.delete(token);
    }
  };
  const releaseEverywhere = (token: string) => {
    for (const [session, tokens] of [...sessions]) {
      if (tokens.has(token)) {
        release(session, token);
      }
    }
  };
  const redraw = () => {
    const view = current;
    const session = view?.sessionId;
    const removed = pendingRemoval;
    const removedFromCurrent =
      removed && session === removed.session && !view?.files.some((file) => file.id === removed.id);
    const restoreFocus = removedFromCurrent && options.document.activeElement === removed.control;
    render(
      view && session && (view.files.length || isStaging(session))
        ? h(AttachmentFiles, {
            session,
            files: view.files,
            removable: true,
            pending: isStaging(session) ? pendingLabel(session) : null,
            sendToHost: options.sendToHost,
            onRemove(id, control) {
              pendingRemoval = { session, id, index: view.files.findIndex((file) => file.id === id), control };
            },
          })
        : null,
      options.mount,
    );
    if (removedFromCurrent && removed) {
      if (restoreFocus) {
        const controls = options.mount.querySelectorAll<HTMLButtonElement>('.cfileremove');
        controls[Math.min(removed.index, controls.length - 1)]?.focus();
      }
      pendingRemoval = null;
    }
    render(
      h(Notice, {
        words: (current && submissionNotices.get(current.sessionId)) ?? current?.notice ?? null,
      }),
      options.noticeMount,
    );
  };
  const dragTypes = (event: DragEvent): string[] => Array.from(event.dataTransfer?.types ?? []);
  const fileDrag = (event: DragEvent): boolean =>
    dragTypes(event).some((type) => type === 'Files' || URI_DRAG_TYPES.includes(type.toLowerCase()));
  const clearDrop = () => {
    dropDepth = 0;
    options.setDropping(false);
  };
  const rejected = (session: string, token: string) => {
    canceled.add(token);
    releaseEverywhere(token);
    redraw();
    options.updateFoot();
  };
  const readFiles = (files: FileList | File[], clipboard: boolean): boolean => {
    if (options.readOnly) return false;
    const captured = Array.from(files ?? []);
    const session = options.session();
    const view = options.view();
    if (!captured.length || !session || !view || view.sessionId !== session) {
      return false;
    }
    if (isStaging(session)) {
      options.sendToHost({ type: 'fileRejected', session, code: 'busy', name: '', size: 0, rejected: 0 });
      return true;
    }
    if (view.files.length + captured.length > options.limits.count) {
      options.sendToHost({
        type: 'fileRejected',
        session,
        code: 'count',
        name: '',
        size: 0,
        rejected: captured.length,
      });
      return true;
    }
    const tooLarge = captured.find((file) => file.size > options.limits.fileBytes);
    if (tooLarge) {
      options.sendToHost({
        type: 'fileRejected',
        session,
        code: 'file-size',
        name: tooLarge.name,
        size: tooLarge.size,
        rejected: 0,
      });
      return true;
    }
    const total =
      view.files.reduce((sum, file) => sum + file.size, 0) + captured.reduce((sum, file) => sum + file.size, 0);
    if (total > options.limits.totalBytes) {
      options.sendToHost({ type: 'fileRejected', session, code: 'total-size', name: '', size: total, rejected: 0 });
      return true;
    }
    const token = `${Date.now()}:${++serial}:${Math.random()}`;
    add(session, token, captured.length);
    redraw();
    options.updateFoot();
    options.sendToHost({ type: 'beginFileStaging', session, token });
    Promise.all(
      captured.map(async (file) => {
        try {
          return { name: file.name, mime: file.type || '', data: await file.arrayBuffer() };
        } catch {
          throw { fileName: file.name };
        }
      }),
    )
      .then((items) => {
        if (canceled.delete(token)) {
          return;
        }
        options.sendToHost({ type: 'attachFiles', session, token, clipboard, files: items });
      })
      .catch((error: { fileName?: string }) => {
        if (canceled.delete(token)) {
          return;
        }
        releaseEverywhere(token);
        redraw();
        options.updateFoot();
        options.sendToHost({ type: 'fileReadError', session, token, name: error?.fileName ?? '' });
      });
    return true;
  };

  const dropUris = (types: string[], values: Array<{ type: string; data: string }>) => {
    const session = options.session();
    const view = options.view();
    if (options.readOnly || !session || !view || view.sessionId !== session) {
      return;
    }
    options.sendToHost({ type: 'dropUris', session, types, values });
  };

  options.prompt.addEventListener('paste', (event) => {
    const files = event.clipboardData?.files;
    if (files?.length && readFiles(files, true)) {
      event.preventDefault();
    }
  });
  options.prompt.addEventListener('input', () => {
    if (current && submissionNotices.delete(current.sessionId)) {
      redraw();
    }
  });
  options.composer.addEventListener('dragenter', (event) => {
    if (!fileDrag(event)) {
      return;
    }
    event.preventDefault();
    dropDepth += 1;
    options.setDropping(true);
  });
  options.composer.addEventListener('dragover', (event) => {
    if (fileDrag(event)) {
      event.preventDefault();
    }
  });
  options.composer.addEventListener('dragleave', () => {
    if (!options.composer.classList.contains('dropping')) {
      return;
    }
    dropDepth = Math.max(0, dropDepth - 1);
    if (!dropDepth) {
      clearDrop();
    }
  });
  options.composer.addEventListener('drop', (event) => {
    if (!fileDrag(event)) {
      return;
    }
    clearDrop();
    const types = dragTypes(event);
    const uriTypes = types.filter((type) => URI_DRAG_TYPES.includes(type.toLowerCase()));
    // Every value is read here, inside the drop event, because the data is gone after the first await.
    const values = uriTypes.map((type) => ({ type, data: event.dataTransfer?.getData(type) ?? '' }));
    // A drag whose only URI type is text/uri-list also carries web links. With no file: line, the drop is not ours.
    const linkOnly =
      uriTypes.length === 1 &&
      uriTypes[0].toLowerCase() === 'text/uri-list' &&
      !values[0].data.split(/\r?\n/).some((line) => /^file:/i.test(line.trim()));
    if (linkOnly && !types.includes('Files')) {
      return;
    }
    event.preventDefault();
    if (uriTypes.length && !linkOnly) {
      // A URI drag follows the path route even when the drag also lists Files.
      dropUris(types, values);
      return;
    }
    readFiles(event.dataTransfer?.files ?? [], false);
  });

  return {
    update(view) {
      current = view;
      redraw();
    },
    submissionNotice(session, words) {
      if (words) submissionNotices.set(session, words);
      else submissionNotices.delete(session);
      redraw();
    },
    isStaging,
    pendingLabel,
    staging(session, pending, token, count) {
      if (pending) {
        add(session, token, count);
      } else {
        release(session, token);
      }
      redraw();
      options.updateFoot();
    },
    rejected,
  };
}
