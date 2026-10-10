import { h, type ComponentChildren, type JSX } from 'preact';

type InputProps = Omit<JSX.InputHTMLAttributes, 'ref' | 'aria-invalid' | 'aria-busy'> & {
  ref?: (node: HTMLInputElement | null) => void;
  'aria-invalid'?: string;
  'aria-busy'?: string;
  'data-control'?: string;
};

export type TextFieldProps = InputProps & {
  // The text the box holds now. It decides whether the cross shows and never reaches the input.
  text: string;
  // The cross glyph.
  cross: ComponentChildren;
  // The cross's accessible name and hint.
  clearLabel: string;
  // The cross's data-control value.
  clearControl: string;
  // Runs after the box is emptied and focused. Pass the handler the box's own input event calls, with an empty string.
  onClear(): void;
};

// A single-line text box with a cross that empties it. A read-only box and an empty box draw no cross.
export function textField({ text, cross, clearLabel, clearControl, onClear, ...input }: TextFieldProps) {
  const clear = (event: Event) => {
    const field = (event.currentTarget as HTMLElement).closest('.textfield')?.querySelector('input');
    if (field) {
      field.value = '';
      // The redraw from onClear unmounts the cross, so focus moves first.
      field.focus();
    }
    onClear();
  };
  return h('span', { class: 'textfield' }, [
    h('input', input as JSX.InputHTMLAttributes),
    text && !input.readOnly
      ? h(
          'button',
          {
            class: 'fieldclear',
            type: 'button',
            'aria-label': clearLabel,
            'data-hint': clearLabel,
            'data-control': clearControl,
            onClick: clear,
          },
          h('span', { 'aria-hidden': 'true' }, cross),
        )
      : null,
  ]);
}
