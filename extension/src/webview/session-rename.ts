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

// The session the rename editor is open over, and the control it was opened from. A rail
// card or a session heading opens it. The section and control find that control again after
// a redraw, because a session two views match draws two rail rows.
export interface OpenRename {
  session: string;
  title: string;
  error: string;
  // The id of the rename sent and not yet answered, or null. While a rename waits, the box,
  // Save, and Cancel hold still, so one press sends one rename and Cancel never claims to
  // take back a name the agent may already have saved.
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

// The editor once the typed name is sent under `request`, or null when nothing may be sent:
// a rename already waits, or the box is empty.
export function submittedRename(open: OpenRename, request: number): OpenRename | null {
  if (open.request !== null || !open.title.trim()) {
    return null;
  }
  return { ...open, request, error: '' };
}

// What one answer does to the editor. Only the answer to the rename the editor waits on
// counts. An answer to a rename the reader walked away from, before they opened the editor
// again and saved another name, changes nothing. Success closes the editor. A failure keeps
// the text the reader typed beside the reason.
export function answeredRename(open: OpenRename | null, answer: SessionRenameAnswer): 'ignore' | 'close' | OpenRename {
  if (!open || open.session !== answer.session || open.request === null || open.request !== answer.request) {
    return 'ignore';
  }
  if (!answer.error) {
    return 'close';
  }
  return { ...open, title: answer.title, error: answer.error, request: null };
}

// One session's name. The box starts from the full name, not the shortened one the card
// draws, so the reader edits what the agent saved. Enter saves and Escape closes, as in the
// view editor.
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
