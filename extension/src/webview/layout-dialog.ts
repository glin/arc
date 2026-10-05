// One Timeline layout dialog serves every session-heading gear in the panel.
// Radio rows post setLayout and reflect the latest host settings. Their labels expose native tooltips from the Settings editor.

import { Fragment, h, render } from 'preact';
import {
  CARD_LAYOUTS,
  PROMPT_POSITIONS,
  TIMELINE_LAYOUT_WORDS,
  type TimelineLayout,
  type TimelineLayoutKey,
} from '../view/timeline-layout.ts';
import { placeFloat } from './dom.ts';
import type { PanelToHost } from './protocol.ts';

export const LAYOUT_DIALOG_ID = 'layoutpop';

export interface LayoutDialogOptions {
  document: Document;
  events: {
    document(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
    window(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
  };
  layout(): TimelineLayout;
  post(message: PanelToHost): void;
}

export interface LayoutDialog {
  // Opens the dialog under a gear, or closes it when that gear already holds it open.
  toggle(gear: HTMLElement): void;
  // Redraws the checked rows and the gears' expanded state after a render.
  sync(): void;
  close(returnFocus: boolean): void;
  isOpen(): boolean;
}

function Section({
  setting,
  layout,
  post,
}: {
  setting: TimelineLayoutKey;
  layout: TimelineLayout;
  post(message: PanelToHost): void;
}) {
  const nameId = `${LAYOUT_DIALOG_ID}-${setting}`;
  const values = setting === 'cardLayout' ? CARD_LAYOUTS : PROMPT_POSITIONS;
  const words = TIMELINE_LAYOUT_WORDS.values[setting] as Record<string, string>;
  const explanations = TIMELINE_LAYOUT_WORDS.explanations[setting] as Record<string, string>;
  return h('div', { class: 'railfiltersection' }, [
    h('div', { class: 'railfiltersectionname', id: nameId }, TIMELINE_LAYOUT_WORDS.sections[setting]),
    h(
      'div',
      { class: 'layoutchoices', role: 'radiogroup', 'aria-labelledby': nameId },
      values.map((value) => {
        const checked = layout[setting] === value;
        return h(
          'button',
          {
            type: 'button',
            class: 'launchrow railfilterchoice',
            role: 'radio',
            'aria-checked': String(checked),
            tabIndex: checked ? 0 : -1,
            'data-control': `layout:${setting}:${value}`,
            key: value,
            onClick() {
              post(
                setting === 'cardLayout'
                  ? { type: 'setLayout', key: 'cardLayout', value: value as TimelineLayout['cardLayout'] }
                  : { type: 'setLayout', key: 'promptPosition', value: value as TimelineLayout['promptPosition'] },
              );
            },
          },
          h('span', { class: 'launchname', title: explanations[value] }, words[value]),
        );
      }),
    ),
  ]);
}

export function createLayoutDialog(options: LayoutDialogOptions): LayoutDialog {
  const { document } = options;
  const pop = document.createElement('div');
  pop.id = LAYOUT_DIALOG_ID;
  pop.className = 'pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', TIMELINE_LAYOUT_WORDS.title);
  document.body.appendChild(pop);
  let anchor: HTMLElement | null = null;

  const draw = () => {
    render(
      anchor
        ? h(Fragment, {}, [
            h('div', { class: 'launchhead', key: 'head' }, TIMELINE_LAYOUT_WORDS.title),
            h(Section, { setting: 'cardLayout', layout: options.layout(), post: options.post, key: 'cardLayout' }),
            h(Section, {
              setting: 'promptPosition',
              layout: options.layout(),
              post: options.post,
              key: 'promptPosition',
            }),
          ])
        : null,
      pop,
    );
  };

  const markGears = () => {
    for (const gear of Array.from(document.querySelectorAll<HTMLElement>('[aria-controls="layoutpop"]'))) {
      gear.setAttribute('aria-expanded', String(gear === anchor));
    }
  };

  // Align the dialog's right edge with the gear to keep it inside the panel.
  const place = () => {
    if (!anchor || pop.hidden) {
      return;
    }
    placeFloat(document.defaultView!, pop, anchor, { align: 'end' });
  };

  const close = (returnFocus: boolean) => {
    if (!anchor) {
      return;
    }
    const gear = anchor;
    anchor = null;
    pop.hidden = true;
    draw();
    markGears();
    if (returnFocus && gear.isConnected) {
      gear.focus();
    }
  };

  const open = (gear: HTMLElement) => {
    anchor = gear;
    pop.hidden = false;
    draw();
    markGears();
    place();
    pop.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  };

  pop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    // Tab past either edge closes the dialog before focus leaves, including when no other panel control follows.
    if (event.key === 'Tab') {
      const stops = Array.from(pop.querySelectorAll<HTMLElement>('[role="radio"][tabindex="0"]'));
      const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
      if (event.target === edge) {
        close(false);
      }
      return;
    }
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    const group = row?.closest<HTMLElement>('[role="radiogroup"]');
    if (!step || !row || !group) {
      return;
    }
    event.preventDefault();
    const rows = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
    const next = rows[(rows.indexOf(row) + step + rows.length) % rows.length];
    for (const one of rows) {
      one.tabIndex = one === next ? 0 : -1;
    }
    next.focus();
  });
  // Focus moving to another control closes the dialog. A window blur with no focus target leaves it open.
  pop.addEventListener('focusout', (event) => {
    const to = event.relatedTarget as Node | null;
    if (!to || pop.contains(to) || anchor?.contains(to)) {
      return;
    }
    close(false);
  });
  // The gear moves when the panel resizes or scrolls, and the dialog follows it.
  options.events.window('resize', place);
  options.events.document('scroll', place, { capture: true, passive: true });
  options.events.document('pointerdown', (event) => {
    const target = event.target as Node | null;
    if (!anchor || (target && (pop.contains(target) || anchor.contains(target)))) {
      return;
    }
    close(false);
  });

  return {
    toggle(gear) {
      if (anchor === gear) {
        close(true);
        return;
      }
      if (anchor) {
        close(false);
      }
      open(gear);
    },
    sync() {
      if (anchor && !anchor.isConnected) {
        const section = anchor.closest<HTMLElement>('[data-session]')?.dataset.session;
        const replacement = section
          ? document.querySelector<HTMLElement>(
              `.sessionrow[data-session="${CSS.escape(section)}"] [aria-controls="layoutpop"]`,
            )
          : null;
        if (!replacement) {
          close(false);
          return;
        }
        anchor = replacement;
      }
      draw();
      markGears();
      place();
    },
    close,
    isOpen() {
      return anchor !== null;
    },
  };
}
