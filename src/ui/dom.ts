type Child = Node | string | number | null | undefined | false;

type Props = {
  class?: string;
  text?: string;
  title?: string;
  on?: Partial<Record<keyof HTMLElementEventMap | 'input' | 'change', (event: Event) => void>>;
  style?: Partial<CSSStyleDeclaration>;
  [key: string]: unknown;
};

/** Tiny hyperscript helper: no virtual DOM, no template-string injection. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') {
      node.className = String(value);
      continue;
    }
    if (key === 'text') {
      node.textContent = String(value);
      continue;
    }
    if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
      continue;
    }
    if (key === 'on' && typeof value === 'object') {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler as EventListener);
      }
      continue;
    }
    if (key in node) {
      (node as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    node.setAttribute(key, String(value));
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function button(
  label: string,
  onClick: (event: MouseEvent) => void,
  options: { variant?: 'primary' | 'ghost' | 'danger' | 'quiet'; disabled?: boolean; title?: string; class?: string } = {},
): HTMLButtonElement {
  const classes = ['btn'];
  if (options.variant) classes.push(`btn-${options.variant}`);
  if (options.class) classes.push(options.class);
  return h(
    'button',
    {
      class: classes.join(' '),
      type: 'button',
      title: options.title,
      disabled: options.disabled ?? false,
      on: { click: onClick as (event: Event) => void },
    },
    label,
  );
}

export function field(
  label: string,
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): HTMLLabelElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input);
}

export function textInput(options: {
  value?: string;
  placeholder?: string;
  type?: string;
  name?: string;
  ariaLabel?: string;
  class?: string;
  min?: string;
  max?: string;
  step?: string;
  onInput?: (value: string) => void;
}): HTMLInputElement {
  return h('input', {
    class: ['input', options.class].filter(Boolean).join(' '),
    type: options.type ?? 'text',
    value: options.value ?? '',
    placeholder: options.placeholder ?? '',
    name: options.name,
    'aria-label': options.ariaLabel ?? options.placeholder ?? options.name,
    min: options.min,
    max: options.max,
    step: options.step,
    spellcheck: false,
    autocomplete: 'off',
    on: options.onInput
      ? {
          input: (event: Event) => options.onInput?.((event.target as HTMLInputElement).value),
        }
      : undefined,
  });
}

export function selectInput(
  options: Array<{ value: string; label: string }>,
  selected: string,
  onChange: (value: string) => void,
  ariaLabel?: string,
): HTMLSelectElement {
  const select = h('select', {
    class: 'input',
    'aria-label': ariaLabel,
    on: { change: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
  });
  for (const option of options) {
    select.appendChild(
      h('option', { value: option.value, selected: option.value === selected }, option.label),
    );
  }
  return select;
}

/** Copy text and flash the button label; resolves to whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatEth(value: bigint): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction.slice(0, 4)}` : whole.toString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Compact monospace identifier, e.g. 0x1234…abcd. */
export function monoId(value: string, size = 5): string {
  if (!value) return '';
  if (value.length <= 2 + size * 2) return value;
  return `${value.slice(0, 2 + size)}…${value.slice(-size)}`;
}
