/*
 * Stylesheet contract for the phone layout.
 *
 * There is no real browser in this environment, so the visual layout cannot be
 * screenshotted. What *can* be checked is the thing that actually breaks a
 * phone user: whether the stylesheet still declares the rules that let you
 * switch between the code editor and the tools panel, and whether the desktop
 * rules still put both panes side by side. That is a contract test on the real
 * `src/style.css`, not a mock.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Rule {
  media: string | null;
  selectors: string[];
  declarations: Record<string, string>;
}

const CSS = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

/** Minimal CSS reader: enough for flat rules and one level of `@media`. */
function parse(css: string): Rule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];

  function declarations(body: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const part of body.split(';')) {
      const index = part.indexOf(':');
      if (index === -1) continue;
      const property = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim().replace(/\s+/g, ' ');
      if (property) result[property] = value;
    }
    return result;
  }

  function readBlock(start: number, end: number, media: string | null): number {
    let buffer = '';
    let index = start;
    while (index < end) {
      const char = clean[index];
      if (char !== '{') {
        buffer += char;
        index += 1;
        continue;
      }
      const selector = buffer.trim().replace(/\s+/g, ' ');
      buffer = '';
      let depth = 1;
      let cursor = index + 1;
      while (cursor < end && depth > 0) {
        if (clean[cursor] === '{') depth += 1;
        else if (clean[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const body = clean.slice(index + 1, cursor - 1);
      if (selector.startsWith('@media')) {
        readBlock(index + 1, cursor - 1, selector.replace(/^@media\s*/, ''));
      } else if (!selector.startsWith('@')) {
        rules.push({
          media,
          selectors: selector.split(',').map((part) => part.trim().replace(/\s+/g, ' ')),
          declarations: declarations(body),
        });
      }
      index = cursor;
    }
    return index;
  }

  readBlock(0, clean.length, null);
  return rules;
}

const RULES = parse(CSS);

function find(selector: string, media: string | null): Rule[] {
  return RULES.filter(
    (rule) => rule.media === media && rule.selectors.includes(selector),
  );
}

function display(selector: string, media: string | null): string | undefined {
  const matches = find(selector, media);
  // Later rules win, exactly like the cascade for same-specificity selectors.
  const last = matches.at(-1);
  return last?.declarations.display;
}

describe('phone layout stylesheet', () => {
  it('starts with the editor hidden and only the tools panel visible', () => {
    expect(display('.workspace', null)).toBe('grid');
    expect(display('.editor-pane', null)).toBe('none');
    expect(find('.workspace', null)[0]?.declarations['grid-template-columns']).toBe('1fr');
  });

  it('shows the editor and hides the tools panel in the code view', () => {
    expect(display(".workspace[data-view='code'] .editor-pane", null)).toBe('flex');
    expect(display(".workspace[data-view='code'] .panel-pane", null)).toBe('none');
  });

  it('keeps the floating Tools button hidden until the phone code view', () => {
    expect(display('.tools-fab', null)).toBe('none');
    const mobile = find(".workspace[data-view='code'] .tools-fab", '(max-width: 899px)');
    expect(mobile.at(-1)?.declarations.display).toBe('inline-flex');
  });

  it('reserves room under the editor so the floating button never covers code', () => {
    const padding = find(
      ".workspace[data-view='code'] .editor-host .cm-scroller",
      '(max-width: 899px)',
    ).at(-1)?.declarations['padding-bottom'];
    expect(padding).toBe('62px');
  });

  it('shows both panes side by side on a desktop, whatever the view state', () => {
    for (const selector of [
      ".workspace[data-view='code'] .editor-pane",
      ".workspace[data-view='panel'] .editor-pane",
    ]) {
      expect(display(selector, '(min-width: 900px)'), selector).toBe('flex');
    }
    for (const selector of [
      ".workspace[data-view='code'] .panel-pane",
      ".workspace[data-view='panel'] .panel-pane",
    ]) {
      expect(display(selector, '(min-width: 900px)'), selector).toBe('flex');
    }
  });

  it('hides the phone-only Code tab on a desktop', () => {
    expect(display('.tab-mobile', '(min-width: 900px)')).toBe('none');
  });

  it('uses one phone breakpoint, adjacent to the desktop one', () => {
    const breakpoints = RULES.map((rule) => rule.media).filter((media): media is string => Boolean(media));
    const maxWidths = [...new Set(breakpoints.filter((media) => media.includes('max-width')))];
    const minWidths = [...new Set(breakpoints.filter((media) => media.includes('min-width')))].sort();
    // 899/900 are adjacent: there is no width range where neither layout applies.
    expect(maxWidths).toEqual(['(max-width: 899px)']);
    expect(minWidths).toEqual(['(min-width: 1280px)', '(min-width: 900px)']);
  });

  it('declares a viewport-independent tap target size for the floating button', () => {
    const fab = find('.tools-fab', null).at(-1);
    expect(fab?.declarations['min-height']).toBe('38px');
    expect(fab?.declarations.position).toBe('fixed');
  });
});
