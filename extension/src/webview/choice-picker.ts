import { h, render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

interface PickerEvents {
  place(): void;
  outside(event: PointerEvent): void;
}
const pickerOwners = new WeakMap<Document, Set<PickerEvents>>();
export function initializeChoicePickers(doc: Document): void {
  if (pickerOwners.has(doc)) return;
  const owners = new Set<PickerEvents>();
  pickerOwners.set(doc, owners);
  doc.addEventListener('pointerdown', (event) => owners.forEach((owner) => owner.outside(event)), true);
  const place = () => owners.forEach((owner) => owner.place());
  doc.defaultView?.addEventListener('resize', place);
  doc.addEventListener('scroll', place, true);
}

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
  detail?: string;
}

export interface ChoicePickerProps {
  id: string;
  owner: string;
  control: string;
  label: string;
  name: string;
  detail?: string;
  className?: string;
  options: readonly PickerOption[];
  selected: string | null;
  storedValue?: string;
  disabled?: boolean;
  open: boolean;
  setOpen(open: boolean): void;
  commit(value: string): void;
}

// The popup owns tentative selection. The trigger owns DOM focus throughout its lifetime.
export function ChoicePicker(props: ChoicePickerProps): ComponentChildren {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<string | null>(props.selected);
  const search = useRef({ text: '', at: 0 });
  const owner = useRef(props.owner);
  const focused = useRef(false);
  const mounted = useRef(true);
  const events = useRef({ place() {}, outside(_event: PointerEvent) {} });
  const optionId = (value: string) => `${props.id}-option-${encodeURIComponent(value)}`;
  const close = (accept: boolean) => {
    if (!props.open || !mounted.current) return;
    if (accept && active !== null && props.options.some((item) => item.value === active)) props.commit(active);
    props.setOpen(false);
  };
  const open = (boundary?: 'first' | 'last') => {
    search.current = { text: '', at: 0 };
    setActive(
      boundary === 'last'
        ? (props.options.at(-1)?.value ?? null)
        : boundary === 'first'
          ? (props.options[0]?.value ?? null)
          : (props.selected ?? props.options[0]?.value ?? null),
    );
    props.setOpen(true);
  };
  useLayoutEffect(() => {
    if (!trigger.current) return undefined;
    const doc = trigger.current.ownerDocument;
    mounted.current = true;
    const node = doc.createElement('div');
    node.className = 'pop choicepop';
    node.id = `${props.id}-list`;
    node.hidden = true;
    doc.body.appendChild(node);
    popup.current = node;
    return () => {
      mounted.current = false;
      render(null, node);
      node.remove();
      popup.current = null;
    };
  }, [props.id]);
  useLayoutEffect(() => {
    const button = trigger.current;
    if (!button) return undefined;
    const doc = button.ownerDocument;
    const owners = pickerOwners.get(doc)!;
    owners.add(events.current);
    return () => {
      owners.delete(events.current);
    };
  }, [props.id]);
  useLayoutEffect(() => {
    if ((props.disabled || !props.options.length) && focused.current && trigger.current) {
      const root = trigger.current.closest('#launcher, #composer');
      const controls = [...(root?.querySelectorAll<HTMLElement>('button, input, select, textarea') ?? [])];
      const at = controls.indexOf(trigger.current);
      const next = [...controls.slice(at + 1), ...controls.slice(0, at).reverse()].find(
        (node) => node.tabIndex >= 0 && node.checkVisibility() && !('disabled' in node && node.disabled),
      );
      next?.focus();
      focused.current = false;
    }
    if (owner.current !== props.owner || props.disabled || !props.options.length) {
      owner.current = props.owner;
      if (props.open) props.setOpen(false);
    }
    if (props.open && !props.options.some((item) => item.value === active)) {
      setActive(props.selected ?? props.options[0]?.value ?? null);
    }
  }, [props.owner, props.disabled, props.options, props.open]);
  useLayoutEffect(() => {
    const node = popup.current;
    const button = trigger.current;
    if (!node || !button) return undefined;
    node.hidden = !props.open;
    node.setAttribute('role', 'listbox');
    node.setAttribute('aria-label', props.name);
    render(
      props.open
        ? props.options.map((item) =>
            h(
              'div',
              {
                key: item.value,
                id: optionId(item.value),
                class: `pickrow choiceoption${active === item.value ? ' is-active' : ''}`,
                role: 'option',
                'aria-selected': String(item.value === props.selected),
                'aria-label': item.label,
                'data-control': `${props.control}:${item.value}`,
                'aria-describedby': item.description || item.detail ? `${optionId(item.value)}-detail` : undefined,
                onPointerDown(event: PointerEvent) {
                  event.preventDefault();
                },
                onClick() {
                  props.commit(item.value);
                  props.setOpen(false);
                },
              },
              [
                h('span', { class: 'picktick', 'aria-hidden': 'true' }, item.value === props.selected ? '\u2713' : ''),
                h('span', { class: 'pickbody' }, [
                  h('span', { class: 'pickname' }, item.label),
                  item.description || item.detail
                    ? h(
                        'span',
                        { class: 'pickwhy', id: `${optionId(item.value)}-detail` },
                        item.description || item.detail,
                      )
                    : null,
                ]),
              ],
            ),
          )
        : null,
      node,
    );
    const place = () => {
      const at = button.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const win = button.ownerDocument.defaultView!;
      node.style.left = `${Math.max(6, Math.min(at.left, win.innerWidth - box.width - 6))}px`;
      node.style.top = `${Math.max(6, Math.min(at.bottom + 4 + box.height <= win.innerHeight - 6 ? at.bottom + 4 : at.top - box.height - 4, win.innerHeight - box.height - 6))}px`;
    };
    if (props.open) {
      place();
      if (active !== null) button.ownerDocument.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    }
    const outside = (event: PointerEvent) => {
      if (props.open && event.target instanceof Node && !node.contains(event.target) && !button.contains(event.target))
        close(true);
    };
    Object.assign(events.current, { place, outside });
    return undefined;
  });
  const keydown = (event: KeyboardEvent) => {
    const key = event.key;
    if (key === 'Tab') {
      close(true);
      return;
    }
    if (key === 'Escape' && props.open) {
      close(false);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    if (key === 'Enter' || key === ' ' || (event.altKey && key === 'ArrowUp')) {
      if (props.open) close(true);
      else open();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(key)) {
      if (!props.open) {
        open(key === 'Home' ? 'first' : key === 'End' ? 'last' : undefined);
      } else {
        const at = Math.max(
          0,
          props.options.findIndex((item) => item.value === active),
        );
        const next =
          key === 'Home'
            ? 0
            : key === 'End'
              ? props.options.length - 1
              : at + (key === 'PageDown' ? 10 : key === 'PageUp' ? -10 : key === 'ArrowDown' ? 1 : -1);
        setActive(props.options[Math.max(0, Math.min(next, props.options.length - 1))]?.value ?? null);
      }
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = (now - search.current.at < 750 ? search.current.text : '') + key.toLocaleLowerCase();
      search.current = { text, at: now };
      const repeated = Array.from(text).every((letter) => letter === text[0]);
      const prefix = repeated ? text[0] : text;
      const at = props.options.findIndex((item) => item.value === (props.open ? active : props.selected));
      const rows = repeated ? [...props.options.slice(at + 1), ...props.options.slice(0, at + 1)] : props.options;
      const match = rows.find((item) => item.label.toLocaleLowerCase().startsWith(prefix));
      if (!props.open) {
        setActive(props.selected ?? props.options[0]?.value ?? null);
        props.setOpen(true);
      }
      if (match) setActive(match.value);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return h(
    'button',
    {
      ref: trigger,
      id: props.id,
      class: props.className ?? 'choice-trigger',
      type: 'button',
      role: 'combobox',
      disabled: props.disabled || !props.options.length,
      'data-control': props.control,
      'data-value': props.storedValue ?? props.selected ?? '',
      'data-hint': props.open ? undefined : props.detail,
      'aria-label': props.name,
      'aria-description': props.detail,
      'aria-haspopup': 'listbox',
      'aria-expanded': String(props.open),
      'aria-controls': `${props.id}-list`,
      'aria-activedescendant':
        props.open && active !== null && props.options.some((item) => item.value === active)
          ? optionId(active)
          : undefined,
      onClick() {
        if (props.open) close(false);
        else open();
      },
      onKeyDown: keydown,
      onFocus() {
        focused.current = true;
      },
      onBlur() {
        // Chromium 151 and earlier fire blur inside the disabled setter, before the layout effect above runs.
        // Keep the focus flag so that effect still hands focus to the next enabled control.
        if (!trigger.current?.disabled) focused.current = false;
        close(true);
      },
    },
    [
      h('span', { class: 'choice-label' }, props.label),
      ' ',
      h('span', { class: 'cchev', 'aria-hidden': 'true' }, '\u25be'),
    ],
  );
}
