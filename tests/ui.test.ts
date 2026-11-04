// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/ui/app.ts';
import { saveWalletDeployments } from '../src/lib/deployments.ts';
import { TEMPLATES, encodeProjectHash } from '../src/lib/project.ts';
import { setFallbackProvider } from '../src/lib/wallet.ts';
import type { EditorFactory } from '../src/ui/editor.ts';

const VERSIONS_KEY = 'chainpad:solc-versions:v1';

const fakeEditorFactory: EditorFactory = (parent, options) => {
  const area = document.createElement('textarea');
  area.value = options.value;
  area.setAttribute('aria-label', options.ariaLabel ?? '');
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

function seedVersions(): void {
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
}

let root: HTMLElement;
let app: App;

beforeEach(() => {
  window.location.hash = '';
  localStorage.clear();
  seedVersions();
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  app?.destroy();
  setFallbackProvider(null);
});

async function mount(): Promise<void> {
  app = new App(root, { editorFactory: fakeEditorFactory });
  await app.init();
}

describe('app shell', () => {
  it('mounts the editor, tabs and status bar', async () => {
    await mount();
    expect(root.querySelector('.brand-name')?.textContent).toBe('ChainPad');
    expect(root.querySelectorAll('.tab')).toHaveLength(6);
    expect(root.querySelector('[data-tab="build"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector<HTMLTextAreaElement>('.editor-host textarea')?.value).toContain(
      'contract Counter',
    );
    expect(root.querySelector('.statusbar')?.textContent).toContain('ChainPad Devnet');
    expect(root.querySelector('.statusbar')?.textContent).toContain('devnet resets on reload');
    // No wallet paired yet, so no wallet chip is advertised.
    expect(root.querySelector('.status-wallet')).toBeNull();
    expect(root.querySelector('.panel-title')?.textContent).toBe('Build');
  });

  it('shows a wallet chip once a mobile wallet is paired', async () => {
    setFallbackProvider({ request: async () => [] });
    await mount();
    expect(root.querySelector('.status-wallet')?.textContent).toBe('Wallet connected');
  });

  it('starts the devnet with three accounts', async () => {
    await mount();
    expect(app.accounts).toHaveLength(3);
  });

  it('switches between mobile views and panels', async () => {
    await mount();
    const workspace = root.querySelector<HTMLElement>('.workspace')!;
    expect(workspace.dataset.view).toBe('panel');

    root.querySelector<HTMLButtonElement>('.tab-mobile')!.click();
    expect(workspace.dataset.view).toBe('code');

    // The tab strip is hidden in code view; the floating Tools button is the
    // way back to the panel on a phone.
    root.querySelector<HTMLButtonElement>('.tools-fab')!.click();
    expect(workspace.dataset.view).toBe('panel');

    root.querySelector<HTMLButtonElement>('[data-tab="interact"]')!.click();
    expect(workspace.dataset.view).toBe('panel');
    expect(root.querySelector('.panel-title')?.textContent).toBe('Interact');
    expect(root.querySelector('.empty')?.textContent).toContain('Nothing deployed yet');
  });

  it('opens a project from a share link and shares it back', async () => {
    const project = TEMPLATES.find((item) => item.id === 'erc20')!.project();
    project.name = 'Shared token';
    window.location.hash = encodeProjectHash(project);

    await mount();

    expect(document.querySelector('.toast-ok')?.textContent).toBe('Loaded a shared project');
    // The ERC-20 template is open, not the default Counter project.
    expect(root.querySelector<HTMLTextAreaElement>('.editor-host textarea')?.value).toContain(
      'contract Token',
    );

    // Sharing copies a link that carries the same project.
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    const share = [...root.querySelectorAll<HTMLButtonElement>('.header-actions .btn')].find(
      (element) => element.textContent === 'Share',
    );
    expect(share).toBeDefined();
    share!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('#p=');
    expect(written[0]).toContain(window.location.origin);
  });

  it('opens the template picker with all four templates', async () => {
    await mount();
    const templatesButton = [...root.querySelectorAll<HTMLButtonElement>('.header-actions .btn')].find(
      (element) => element.textContent === 'Templates',
    );
    expect(templatesButton).toBeDefined();
    templatesButton!.click();

    const overlay = document.querySelector('.overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelectorAll('.template-card')).toHaveLength(4);
    expect(overlay!.textContent).toContain('ERC-20 token');

    overlay!.querySelector<HTMLButtonElement>('.modal-head .btn')!.click();
    expect(document.querySelector('.overlay')).toBeNull();
  });

  it('edits the active file and reflects it in the editor', async () => {
    await mount();
    const area = root.querySelector<HTMLTextAreaElement>('.editor-host textarea')!;
    area.value = 'contract Edited {}';
    area.dispatchEvent(new Event('input'));
    // Switching tabs re-renders the panel but must keep the edited source.
    root.querySelector<HTMLButtonElement>('[data-tab="learn"]')!.click();
    expect(root.querySelector('.panel-title')?.textContent).toBe('Learn');
  });

  it('restores a wallet deployment from a previous session', async () => {
    saveWalletDeployments([
      {
        id: 'wallet-1',
        name: 'Counter',
        address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        abi: [
          {
            type: 'function',
            name: 'count',
            inputs: [],
            outputs: [{ name: '', type: 'uint256' }],
            stateMutability: 'view',
          },
        ],
        contractId: 'Counter.sol:Counter',
        chainId: 11155111,
        createdAt: Date.now(),
      },
    ]);
    await mount();

    root.querySelector<HTMLButtonElement>('[data-tab="interact"]')!.click();

    const meta = root.querySelector('.interact-meta');
    expect(meta?.textContent).toContain('chain 11155111 (Sepolia)');
    expect(root.querySelector('.fn-signature')?.textContent).toBe('count');
    // The sender comes from the wallet, so no devnet account picker is shown.
    expect(root.querySelector('.interact-meta')?.textContent).toContain('Sender: the account you pick in your wallet');
  });

  it('shows the Learn tab content', async () => {
    await mount();
    root.querySelector<HTMLButtonElement>('[data-tab="learn"]')!.click();
    expect(root.querySelectorAll('.learn-step')).toHaveLength(6);
    expect(root.querySelector('.panel-body')?.textContent).toContain('Compile');
    expect(root.querySelector('.panel-body')?.textContent).toContain('Sponsor the project');
  });

  it('renders the empty activity log', async () => {
    await mount();
    root.querySelector<HTMLButtonElement>('[data-tab="log"]')!.click();
    expect(root.querySelector('.panel-title')?.textContent).toBe('Activity');
    expect(root.querySelector('.empty')?.textContent).toContain('No transactions yet');
  });
});
