import { Fragment, h, type ComponentChildren } from 'preact';

// The words the session rename editor draws. `CARD_ACTIONS` holds them.
export interface SessionRenameWords {
  sessionRename: string;
  sessionRenameField: string;
  sessionRenameCancel: string;
  sessionRenameSave: string;
  sessionRenameEmpty: string;
  sessionRenamePending: string;
}

// Rename state and opener identity. Section and control distinguish rows in multiple matching views.
export interface OpenRename {
  session: string;
  title: string;
  error: string;
  // Pending request id, or null. Disable edits, Save, and Cancel until its answer arrives.
  request: number | null;
  section: string | null;
  anchor: HTMLElement | null;
  control: string | null;
}

export interface SessionRenameAnswer {
  session: string;
  request: number;
  title: string;
  error: string;
}

// Set the request id unless a rename is pending or the name is empty.
export function submittedRename(open: OpenRename, request: number): OpenRename | null {
  if (open.request !== null || !open.title.trim()) {
    return null;
  }
  return { ...open, request, error: '' };
}

// Accept only the pending session and request. Success closes the editor.
// Failure restores the answer's title and displays its error.
export function answeredRename(open: OpenRename | null, answer: SessionRenameAnswer): 'ignore' | 'close' | OpenRename {
  if (!open || open.session !== answer.session || open.request === null || open.request !== answer.request) {
    return 'ignore';
  }
  if (!answer.error) {
    return 'close';
  }
  return { ...open, title: answer.title, error: answer.error, request: null };
}

// Edit the full session name. Enter submits it. The caller handles dismissal.
export function SessionRenameEditor({
  open,
  words,
  setInput,
  onTitle,
  onSubmit,
  onCancel,
}: {
  open: OpenRename | null;
  words: SessionRenameWords;
  setInput(node: HTMLInputElement | null): void;
  onTitle(value: string): void;
  onSubmit(): void;
  onCancel(): void;
}): ComponentChildren {
  if (!open) {
    return null;
  }
  const waiting = open.request !== null;
  const empty = !open.title.trim();
  const note = waiting ? words.sessionRenamePending : open.error || (empty ? words.sessionRenameEmpty : '');
  return h(Fragment, null, [
    h('div', { class: 'launchhead', key: 'head' }, words.sessionRename),
    h('div', { class: 'launchfield', key: 'name' }, [
      h('label', { class: 'launchfieldname', for: 'sessionrenamename' }, words.sessionRenameField),
      h('input', {
        type: 'text',
        id: 'sessionrenamename',
        class: 'labelfind',
        value: open.title,
        'data-control': 'session-rename-name',
        readOnly: waiting,
        'aria-describedby': 'sessionrenamenote',
        'aria-invalid': open.error || empty ? 'true' : undefined,
        'aria-busy': waiting ? 'true' : undefined,
        ref: setInput,
        onInput: (event: Event) => onTitle((event.currentTarget as HTMLInputElement).value),
        onKeyDown: (event: KeyboardEvent) => {
          if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') {
            return;
          }
          event.preventDefault();
          onSubmit();
        },
      }),
    ]),
    h(
      'div',
      { class: 'railviewnotes', id: 'sessionrenamenote', key: 'note', role: 'status' },
      note ? h('div', { class: 'labelnote' }, note) : null,
    ),
    h('div', { class: 'launchactions', key: 'actions' }, [
      h(
        'button',
        {
          class: 'launchback',
          type: 'button',
          disabled: waiting,
          'data-control': 'session-rename-cancel',
          onClick: onCancel,
        },
        words.sessionRenameCancel,
      ),
      h(
        'button',
        {
          class: 'launchcreate',
          type: 'button',
          disabled: empty || waiting,
          'data-control': 'session-rename-save',
          onClick: onSubmit,
        },
        words.sessionRenameSave,
      ),
    ]),
  ]);
}
