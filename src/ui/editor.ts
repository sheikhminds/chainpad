import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { solidity } from '@replit/codemirror-lang-solidity';

export interface EditorHandle {
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
  destroy(): void;
}

export interface EditorOptions {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter and Ctrl/Cmd+S. */
  onRun?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  readOnly?: boolean;
}

export type EditorFactory = (parent: HTMLElement, options: EditorOptions) => EditorHandle;

const theme = EditorView.theme(
  {
    '&': {
      color: '#e5e9f0',
      backgroundColor: 'transparent',
      fontSize: '13.5px',
      height: '100%',
    },
    '.cm-content': {
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      padding: '14px 0',
      caretColor: '#8b7cff',
    },
    '.cm-line': { padding: '0 14px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: '#4a5366',
      border: 'none',
      paddingLeft: '6px',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(139, 124, 255, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8b7cff' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(139, 124, 255, 0.28) !important' },
    '.cm-cursor': { borderLeftColor: '#8b7cff' },
    '.cm-scroller': { overflow: 'auto', lineHeight: '1.65' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(88, 214, 163, 0.22)', outline: 'none' },
    '.cm-placeholder': { color: '#4a5366' },
  },
  { dark: true },
);

function extensions(options: EditorOptions, onRun?: () => void): Extension[] {
  return [
    lineNumbers(),
    foldGutter({ openText: '▾', closedText: '▸' }),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    solidity,
    theme,
    EditorView.lineWrapping,
    options.placeholder ? placeholderExt(options.placeholder) : [],
    EditorState.readOnly.of(options.readOnly ?? false),
    EditorView.contentAttributes.of({
      'aria-label': options.ariaLabel ?? 'Solidity source code',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    }),
    keymap.of([
      {
        key: 'Mod-Enter',
        run: () => {
          onRun?.();
          return true;
        },
      },
      {
        key: 'Mod-s',
        run: () => {
          onRun?.();
          return true;
        },
      },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
    }),
  ];
}

/** CodeMirror-backed editor. The only editor implementation shipped to users. */
export const createCodeEditor: EditorFactory = (parent, options) => {
  let ext = extensions(options, options.onRun);
  let view = new EditorView({
    state: EditorState.create({ doc: options.value, extensions: ext }),
    parent,
  });

  return {
    getValue: () => view.state.doc.toString(),
    setValue(value: string) {
      view.destroy();
      view = new EditorView({
        state: EditorState.create({ doc: value, extensions: ext }),
        parent,
      });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
};
