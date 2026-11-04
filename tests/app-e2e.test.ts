// @vitest-environment happy-dom
/*
 * End-to-end test of the browser path:
 *   compile the bundled compiler bundle -> deploy -> write -> read.
 *
 * The real compiler source is served from the npm package (the same file the
 * browser downloads), so this exercises `instantiateSoljson`, the standard JSON
 * compile, the EVM devnet and the generated UI forms together.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/ui/app.ts';
import type { EditorFactory } from '../src/ui/editor.ts';

const require = createRequire(import.meta.url);
const VERSIONS_KEY = 'chainpad:solc-versions:v1';

const fakeEditorFactory: EditorFactory = (parent, options) => {
  const area = document.createElement('textarea');
  area.value = options.value;
  area.addEventListener('input', () => options.onChange(area.value));
  parent.appendChild(area);
  return {
    getValue: () => area.value,
    setValue: (value: string) => {
      area.value = value;
    },
    focus: () => area.focus(),
    destroy: () => area.remove(),
  };
};

async function waitFor<T>(check: () => T | null | undefined, label: string, timeout = 90_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function cardBySignature(selector: string, signature: string): HTMLElement | null {
  const cards = [...document.querySelectorAll<HTMLElement>(selector)];
  return cards.find((card) => card.querySelector('.fn-signature')?.textContent === signature) ?? null;
}

let app: App;
let root: HTMLElement;
let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    VERSIONS_KEY,
    JSON.stringify({
      at: Date.now(),
      builds: [
        {
          version: '0.8.30',
          longVersion: '0.8.30+commit.73712a01',
          path: 'soljson-v0.8.30+commit.73712a01.js',
          url: 'https://binaries.soliditylang.org/wasm/soljson-v0.8.30+commit.73712a01.js',
        },
      ],
    }),
  );

  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);

  const soljson = readFileSync(require.resolve('solc/soljson.js'), 'utf8');
  const originalFetch = globalThis.fetch;
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('soljson')) {
      return new Response(soljson, {
        status: 200,
        headers: { 'content-type': 'text/javascript' },
      });
    }
    return originalFetch(input);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
});

afterEach(() => {
  app?.destroy();
  restoreFetch?.();
  restoreFetch = null;
});

describe('compile, deploy and interact through the UI', () => {
  it('compiles Counter, deploys it, sends a transaction and reads the result', async () => {
    app = new App(root, { editorFactory: fakeEditorFactory });
    await app.init();

    const compileButton = root.querySelector<HTMLButtonElement>('.build-bar .btn-primary');
    expect(compileButton).not.toBeNull();
    compileButton!.click();

    const contractCard = await waitFor(
      () => root.querySelector<HTMLElement>('.contract-card'),
      'the compiled Counter contract',
    );
    expect(contractCard.textContent).toContain('Counter');
    expect(root.querySelector('.notice-ok')?.textContent).toContain('Compiled');
    expect(root.querySelector('.notice-ok')?.textContent).toContain('0.8.30');

    // The deploy form is generated from the ABI: Counter(uint256 start).
    const startInput = await waitFor(
      () => root.querySelector<HTMLInputElement>('[name="ctor-0"]'),
      'the constructor argument field',
    );
    startInput.value = '7';

    const deployButton = [...root.querySelectorAll<HTMLButtonElement>('.deploy-form .btn')].find(
      (element) => element.textContent === 'Deploy to devnet',
    );
    expect(deployButton).toBeDefined();
    deployButton!.click();

    const incrementCard = await waitFor(
      () => cardBySignature('.fn-card', 'increment'),
      'the generated Interact forms',
    );
    expect(root.querySelector('[data-tab="interact"]')?.getAttribute('aria-selected')).toBe('true');

    // Write: increment() emits Changed and bumps count from 7 to 8.
    const sendButton = incrementCard.querySelector<HTMLButtonElement>('.fn-actions .btn-primary');
    expect(sendButton).not.toBeNull();
    sendButton!.click();

    const ok = await waitFor(
      () => incrementCard.querySelector<HTMLElement>('.fn-ok'),
      'the transaction receipt',
    );
    expect(ok.textContent).toContain('block');
    expect(incrementCard.querySelector('.fn-event')?.textContent).toContain('Changed');

    // Read: count() should now return 8.
    const countCard = cardBySignature('.fn-card', 'count');
    expect(countCard).not.toBeNull();
    countCard!.querySelector<HTMLButtonElement>('.fn-actions .btn')!.click();

    const value = await waitFor(
      () => countCard!.querySelector<HTMLElement>('.fn-value'),
      'the read result',
    );
    expect(value.textContent).toBe('8');

    // Activity log records the deployment and the write.
    expect(app.accounts).toHaveLength(3);
  }, 120_000);

  it('shows compile errors instead of throwing', async () => {
    app = new App(root, { editorFactory: fakeEditorFactory });
    await app.init();

    const area = root.querySelector<HTMLTextAreaElement>('.editor-host textarea')!;
    area.value = 'pragma solidity ^0.8.20;\ncontract Broken { uint x = ; }';
    area.dispatchEvent(new Event('input'));

    root.querySelector<HTMLButtonElement>('.build-bar .btn-primary')!.click();

    const errorDiagnostic = await waitFor(
      () => root.querySelector<HTMLElement>('.diagnostic-error'),
      'a compiler error',
    );
    expect(errorDiagnostic.textContent).toContain('error');
    expect(root.querySelector('.notice-error')?.textContent).toContain('1 error');
  }, 120_000);
});
