// The timeline layout: where an open turn card draws its record and its prompt.
//
// Two settings, each a VS Code setting under `arc.timeline`. The extension reads them and
// sends them with every render and after each setting change. The panel draws the Timeline
// layout dialog from those values, so the dialog, Settings editor and open cards agree.

export type CardLayout = 'compact' | 'one-column' | 'two-columns';
export type PromptPosition = 'above' | 'below';

export interface TimelineLayout {
  cardLayout: CardLayout;
  promptPosition: PromptPosition;
}

export type TimelineLayoutKey = keyof TimelineLayout;

export const CARD_LAYOUTS: readonly CardLayout[] = ['compact', 'one-column', 'two-columns'];
export const PROMPT_POSITIONS: readonly PromptPosition[] = ['above', 'below'];

export const DEFAULT_TIMELINE_LAYOUT: TimelineLayout = { cardLayout: 'two-columns', promptPosition: 'below' };

// The words the dialog draws, and the words the Settings editor shows for each value. Reader-facing
// copy never says chip: Compact names the setting, and the explanation names what the figures hold.
export const TIMELINE_LAYOUT_WORDS = {
  title: 'Timeline layout',
  hintDetail: 'How an open turn shows its subagents, commits, files and prompt',
  // The dialog's section headings.
  sections: {
    cardLayout: 'Card layout',
    promptPosition: 'Prompt',
  } satisfies Record<TimelineLayoutKey, string>,
  // The names a refused save uses for each setting, as the Settings editor titles them.
  settings: {
    cardLayout: 'Card layout',
    promptPosition: 'Prompt position',
  } satisfies Record<TimelineLayoutKey, string>,
  values: {
    cardLayout: {
      compact: 'Compact',
      'one-column': 'One column',
      'two-columns': 'Two columns',
    } satisfies Record<CardLayout, string>,
    promptPosition: {
      above: 'Above the response',
      below: 'Below the response',
    } satisfies Record<PromptPosition, string>,
  },
  // One sentence per value. The dialog shows it on its row, and the Settings editor shows it
  // under the value in focus.
  explanations: {
    cardLayout: {
      compact:
        "The card keeps its subagents, commits and files in the popovers under the figures in the card's top row.",
      'one-column': 'The card lists its subagents, commits and files under Activity.',
      'two-columns':
        'The card lists its subagents, commits and files beside the response on a wide card, and under Activity on a narrow one.',
    } satisfies Record<CardLayout, string>,
    promptPosition: {
      above: 'The prompt leads the card, clamped to two lines.',
      below: 'The prompt follows the response, under its opening heading.',
    } satisfies Record<PromptPosition, string>,
  },
} as const;

// The setting under `arc` that each layout key saves to.
export const TIMELINE_LAYOUT_SETTINGS = {
  cardLayout: 'timeline.cardLayout',
  promptPosition: 'timeline.promptPosition',
} as const satisfies Record<TimelineLayoutKey, string>;

export type TimelineLayoutSetting = (typeof TIMELINE_LAYOUT_SETTINGS)[TimelineLayoutKey];

// What the reader reads when the editor refuses a layout press. The Timeline layout stays as
// it was, so the message names the setting the press meant to change and the value it asked for.
export function timelineLayoutNotSaved(key: TimelineLayoutKey, value: string): string {
  const words = TIMELINE_LAYOUT_WORDS.values[key] as Record<string, string>;
  return (
    `Arc: The ${TIMELINE_LAYOUT_WORDS.settings[key]} setting did not change to ${words[value] ?? value}. ` +
    'The timeline keeps its current layout.'
  );
}

// Save one layout setting. Report a refused write because the dialog selects a row only after the saved setting returns.
export function saveTimelineLayout(
  key: TimelineLayoutKey,
  value: string,
  save: (setting: TimelineLayoutSetting, value: string) => PromiseLike<void>,
  tell: (message: string) => void,
): Promise<void> {
  return Promise.resolve()
    .then(() => save(TIMELINE_LAYOUT_SETTINGS[key], value))
    .then(
      () => undefined,
      () => {
        tell(timelineLayoutNotSaved(key, value));
      },
    );
}

export function isCardLayout(value: unknown): value is CardLayout {
  return typeof value === 'string' && (CARD_LAYOUTS as readonly string[]).includes(value);
}

export function isPromptPosition(value: unknown): value is PromptPosition {
  return typeof value === 'string' && (PROMPT_POSITIONS as readonly string[]).includes(value);
}

// A value a reader typed by hand into their settings file can be anything. An unknown value
// draws the default rather than a card with no layout.
export function timelineLayout(raw: unknown): TimelineLayout {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    cardLayout: isCardLayout(record.cardLayout) ? record.cardLayout : DEFAULT_TIMELINE_LAYOUT.cardLayout,
    promptPosition: isPromptPosition(record.promptPosition)
      ? record.promptPosition
      : DEFAULT_TIMELINE_LAYOUT.promptPosition,
  };
}

// Open card body parts and their layout columns. Two columns adds a record column only when hasRecord is true.
export type CardBodyPart = 'prompt' | 'error' | 'response' | 'activity' | 'record';

export function cardBodyColumns(layout: TimelineLayout, hasRecord: boolean): CardBodyPart[][] {
  const prose: CardBodyPart[] = [
    ...(layout.promptPosition === 'above' ? ['prompt' as const] : []),
    'error',
    'response',
    'activity',
  ];
  const below: CardBodyPart[] = layout.promptPosition === 'below' ? ['prompt'] : [];
  if (layout.cardLayout === 'compact' || !hasRecord) {
    return [[...prose, ...below]];
  }
  if (layout.cardLayout === 'two-columns') {
    return [[...prose, ...below], ['record']];
  }
  return [[...prose, 'record', ...below]];
}
