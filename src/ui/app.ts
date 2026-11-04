import { parseEther, type Abi, type Hex } from 'viem';
import {
  ArgumentError,
  formatValue,
  listFunctions,
  parseArguments,
  shortAddress,
  type AbiFunctionInfo,
} from '../lib/abi.ts';
import { CHAIN_ID, CHAIN_NAME, DevChain, type DevAccount, type TxLog } from '../lib/chain.ts';
import { loadWalletDeployments, saveWalletDeployments } from '../lib/deployments.ts';
import {
  compileProject,
  unlinkedLibraries,
  type CompiledContract,
  type Diagnostic,
} from '../lib/compile.ts';
import {
  TEMPLATES,
  encodeProjectHash,
  loadProject,
  projectFromHash,
  parseProject,
  saveProject,
  serializeProject,
  type Project,
  type Template,
} from '../lib/project.ts';
import { getCompiler, listCompilerVersions, type CompilerBuild } from '../lib/solc.ts';
import { runTestSuite, type TestRun } from '../lib/tests.ts';
import {
  deployWithWallet,
  describeChain,
  ensureWalletProvider,
  explorerTxUrl,
  hasInjectedWallet,
  readWithWallet,
  setFallbackProvider,
  walletProviderKind,
  writeWithWallet,
} from '../lib/wallet.ts';
import {
  appendChildren,
  button,
  clear,
  copyText,
  field,
  formatBytes,
  formatDuration,
  formatEth,
  h,
  monoId,
  selectInput,
  textInput,
} from './dom.ts';
import { createCodeEditor, type EditorFactory, type EditorHandle } from './editor.ts';

type PanelTab = 'build' | 'interact' | 'tests' | 'log' | 'learn';

interface Deployment {
  id: string;
  name: string;
  address: Hex;
  abi: Abi;
  contractId: string;
  via: 'devnet' | 'wallet';
  /** Set for wallet deployments: the network the contract actually lives on. */
  chainId?: number;
  createdAt: number;
}

const TABS: Array<{ id: PanelTab; label: string }> = [
  { id: 'build', label: 'Build' },
  { id: 'interact', label: 'Interact' },
  { id: 'tests', label: 'Tests' },
  { id: 'log', label: 'Activity' },
  { id: 'learn', label: 'Learn' },
];

const GITHUB_URL = 'https://github.com/sheikhminds/chainpad';
const SPONSOR_URL = 'https://github.com/sponsors/sheikhminds';

export class App {
  private root: HTMLElement;
  private editorFactory: EditorFactory;

  private project: Project = loadProject();
  private artifacts: CompiledContract[] = [];
  private diagnostics: Diagnostic[] = [];
  private compileInfo: { version: string; durationMs: number; at: number } | null = null;
  private versions: CompilerBuild[] = [];
  private chain: DevChain | null = null;
  private deployments: Deployment[] = [];
  /** Chain of the most recent wallet deployment, once one succeeded. */
  private walletChainId: number | null = null;
  private selectedDeploymentId: string | null = null;
  private selectedContractId: string | null = null;
  private accountIndex = 0;
  private tab: PanelTab = 'build';
  private mobileView: 'code' | 'panel' = 'panel';
  private busy: string | null = null;
  private testRun: TestRun | null = null;

  private editor: EditorHandle | null = null;
  private testEditor: EditorHandle | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private fileBar!: HTMLElement;
  private editorHost!: HTMLElement;
  private tabStrip!: HTMLElement;
  private panel!: HTMLElement;
  private status!: HTMLElement;
  private toastHost!: HTMLElement;
  private workspace!: HTMLElement;
  private toolsButton!: HTMLButtonElement;
  private readonly onResize = () => this.renderStatus();

  constructor(root: HTMLElement, options: { editorFactory?: EditorFactory } = {}) {
    this.root = root;
    this.editorFactory = options.editorFactory ?? createCodeEditor;
  }

  async init(): Promise<void> {
    const shared = projectFromHash(window.location.hash);
    if (shared) this.project = shared;

    // Contracts on a real network outlive the tab, so their forms come back.
    this.deployments = loadWalletDeployments().map((stored) => ({ ...stored, via: 'wallet' as const }));
    if (this.deployments.length > 0) {
      this.selectedDeploymentId = this.deployments[this.deployments.length - 1].id;
    }
    this.buildShell();
    this.renderTabs();
    this.renderFileBar();
    this.renderPanel();
    this.renderStatus();
    this.mountEditor();
    // The toast host exists once the shell is built.
    if (shared) this.toast('Loaded a shared project', 'ok');

    try {
      this.chain = await DevChain.create();
    } catch (error) {
      this.toast(
        `Could not start the devnet: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }

    this.renderStatus();
    this.renderPanel();

    const versions = await listCompilerVersions();
    this.versions = versions;
    if (versions.length > 0 && !versions.some((build) => build.version === this.project.settings.compiler)) {
      this.project.settings.compiler = versions[0].version;
      this.scheduleSave();
    }
    if (this.tab === 'build') this.renderPanel();
  }

  destroy(): void {
    this.editor?.destroy();
    this.testEditor?.destroy();
    window.removeEventListener('resize', this.onResize);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  // ---------------------------------------------------------------- shell

  private buildShell(): void {
    clear(this.root);
    this.root.classList.add('app');

    const actions = h(
      'div',
      { class: 'header-actions' },
      button('Templates', () => this.openTemplates(), { variant: 'ghost', title: 'Start from an example' }),
      button('Import', () => this.importProject(), { variant: 'ghost', title: 'Open a saved project file' }),
      button('Export', () => this.exportProject(), { variant: 'ghost', title: 'Download this project as JSON' }),
      button('Share', () => void this.shareProject(), { variant: 'ghost', title: 'Copy a link that contains this project' }),
      h(
        'a',
        {
          class: 'btn btn-ghost',
          href: GITHUB_URL,
          target: '_blank',
          rel: 'noreferrer',
          title: 'Source code on GitHub',
        },
        'GitHub',
      ),
    );

    const header = h(
      'header',
      { class: 'app-header' },
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '◆'),
        h(
          'div',
          {},
          h('span', { class: 'brand-name' }, 'ChainPad'),
          h('span', { class: 'brand-tagline' }, 'Smart contracts in your browser'),
          h('span', { class: 'brand-by' }, 'Built and maintained by an autonomous AI agent'),
        ),
      ),
      h(
        'div',
        { class: 'header-right' },
        h('span', { class: 'pill', title: `${CHAIN_NAME} · chain ID ${CHAIN_ID}` }, `Devnet · ${CHAIN_ID}`),
        actions,
      ),
    );

    this.fileBar = h('div', { class: 'filebar' });
    this.editorHost = h('div', { class: 'editor-host' });
    this.tabStrip = h('nav', { class: 'tabstrip', 'aria-label': 'Workspace panels' });
    this.panel = h('div', { class: 'panel-body' });
    this.status = h('footer', { class: 'statusbar' });
    this.toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });

    const editorPane = h(
      'section',
      { class: 'editor-pane', 'aria-label': 'Solidity editor' },
      this.fileBar,
      this.editorHost,
    );
    // On phones the panel is hidden in code view, so this is the way back.
    this.toolsButton = button('Tools', () => this.setMobileView('panel'), {
      variant: 'primary',
      class: 'tools-fab',
      title: 'Back to the tools panel',
    });
    editorPane.appendChild(this.toolsButton);
    const panelPane = h('section', { class: 'panel-pane', 'aria-label': 'Tools' }, this.tabStrip, this.panel);

    this.workspace = h('main', { class: 'workspace', 'data-view': this.mobileView }, editorPane, panelPane);
    appendChildren(this.root, [header, this.workspace, this.status, this.toastHost]);

    window.addEventListener('resize', this.onResize, { passive: true });

    // Drag and drop a `chainpad.json` project anywhere on the page.
    this.root.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    });
    this.root.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      void this.loadProjectFile(file);
    });
  }

  private mountEditor(): void {
    this.editor?.destroy();
    const file = this.currentFile();
    this.editor = this.editorFactory(this.editorHost, {
      value: file?.content ?? '',
      ariaLabel: `Solidity source for ${file?.name ?? 'project'}`,
      onChange: (value) => {
        const current = this.currentFile();
        if (!current) return;
        current.content = value;
        this.scheduleSave();
      },
      onRun: () => void this.compile(),
    });
  }

  private currentFile() {
    return this.project.files.find((file) => file.name === this.project.activeFile) ?? this.project.files[0];
  }

  private renderTabs(): void {
    clear(this.tabStrip);
    const codeTab = h(
      'button',
      {
        class: 'tab tab-mobile',
        type: 'button',
        on: { click: () => this.setMobileView('code') },
      },
      'Code',
    );
    this.tabStrip.appendChild(codeTab);

    for (const tab of TABS) {
      const badge =
        tab.id === 'build' && this.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
          ? String(this.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length)
          : tab.id === 'interact' && this.deployments.length > 0
            ? String(this.deployments.length)
            : '';
      this.tabStrip.appendChild(
        h(
          'button',
          {
            class: 'tab',
            type: 'button',
            'data-tab': tab.id,
            'aria-selected': tab.id === this.tab ? 'true' : 'false',
            on: { click: () => this.selectTab(tab.id) },
          },
          tab.label,
          badge ? h('span', { class: 'tab-badge' }, badge) : null,
        ),
      );
    }

    this.updateTabState();
  }

  private updateTabState(): void {
    const codeTab = this.tabStrip.querySelector<HTMLElement>('.tab-mobile');
    codeTab?.classList.toggle('is-active', this.mobileView === 'code');
    codeTab?.setAttribute('aria-selected', this.mobileView === 'code' ? 'true' : 'false');
    for (const element of this.tabStrip.querySelectorAll<HTMLElement>('[data-tab]')) {
      const active = element.dataset.tab === this.tab && this.mobileView === 'panel';
      element.classList.toggle('is-active', active);
      element.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    this.workspace?.setAttribute('data-view', this.mobileView);
  }

  private setMobileView(view: 'code' | 'panel'): void {
    this.mobileView = view;
    this.updateTabState();
    if (view === 'code') this.editor?.focus();
  }

  private selectTab(tab: PanelTab): void {
    this.tab = tab;
    this.mobileView = 'panel';
    this.renderPanel();
    this.updateTabState();
    if (tab === 'tests') {
      // Let the browser lay out the panel before focusing the editor.
      requestAnimationFrame(() => this.testEditor?.focus());
    }
  }

  private renderFileBar(): void {
    clear(this.fileBar);
    for (const file of this.project.files) {
      const isActive = file.name === this.project.activeFile;
      const tab = h(
        'div',
        {
          class: `filetab${isActive ? ' is-active' : ''}`,
          role: 'button',
          tabindex: 0,
          title: `${file.name} — double-click to rename`,
          on: {
            click: () => this.setActiveFile(file.name),
            keydown: (event) => {
              if ((event as KeyboardEvent).key === 'Enter') this.setActiveFile(file.name);
            },
            dblclick: () => this.renameFile(file.name),
          },
        },
        h('span', { class: 'filetab-name' }, file.name),
        this.project.files.length > 1
          ? h(
              'button',
              {
                class: 'filetab-close',
                type: 'button',
                title: `Remove ${file.name}`,
                'aria-label': `Remove ${file.name}`,
                on: {
                  click: (event) => {
                    event.stopPropagation();
                    this.removeFile(file.name);
                  },
                },
              },
              '×',
            )
          : null,
      );
      this.fileBar.appendChild(tab);
    }
    this.fileBar.appendChild(
      h(
        'button',
        {
          class: 'filetab-add',
          type: 'button',
          title: 'Add a Solidity file',
          'aria-label': 'Add a Solidity file',
          on: { click: () => this.addFile() },
        },
        '+',
      ),
    );
    this.fileBar.appendChild(
      h(
        'div',
        { class: 'filebar-meta' },
        h('span', { class: 'filebar-hint' }, 'Ctrl/⌘ + Enter to compile'),
      ),
    );
  }

  private setActiveFile(name: string): void {
    if (this.project.activeFile === name) return;
    this.project.activeFile = name;
    this.renderFileBar();
    this.editor?.setValue(this.currentFile()?.content ?? '');
    this.scheduleSave();
  }

  private addFile(): void {
    const suggested = `Contract${this.project.files.length + 1}.sol`;
    const name = window.prompt('File name (include .sol)', suggested)?.trim();
    if (!name) return;
    if (this.project.files.some((file) => file.name === name)) {
      this.toast(`A file named ${name} already exists`, 'error');
      return;
    }
    this.project.files.push({
      name,
      content: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract ${name.replace(/\W+/g, '_').replace(/_sol$/, '')} {\n}\n`,
    });
    this.project.activeFile = name;
    this.renderFileBar();
    this.editor?.setValue(this.currentFile()?.content ?? '');
    this.scheduleSave();
  }

  private renameFile(oldName: string): void {
    const next = window.prompt('Rename file', oldName)?.trim();
    if (!next || next === oldName) return;
    if (this.project.files.some((file) => file.name === next)) {
      this.toast(`A file named ${next} already exists`, 'error');
      return;
    }
    const file = this.project.files.find((candidate) => candidate.name === oldName);
    if (!file) return;
    file.name = next;
    if (this.project.activeFile === oldName) this.project.activeFile = next;
    this.renderFileBar();
    this.scheduleSave();
  }

  private removeFile(name: string): void {
    if (this.project.files.length <= 1) {
      this.toast('A project needs at least one file', 'error');
      return;
    }
    if (!window.confirm(`Remove ${name} from this project?`)) return;
    this.project.files = this.project.files.filter((file) => file.name !== name);
    if (this.project.activeFile === name) {
      this.project.activeFile = this.project.files[0].name;
      this.editor?.setValue(this.currentFile()?.content ?? '');
    }
    this.renderFileBar();
    this.scheduleSave();
  }

  // --------------------------------------------------------------- panels

  private renderPanel(): void {
    if (!this.panel) return;
    // The test editor lives inside a panel that gets rebuilt, so always tear
    // down the old CodeMirror instance before rendering a new one.
    this.testEditor?.destroy();
    this.testEditor = null;
    clear(this.panel);
    this.panel.appendChild(
      this.tab === 'build'
        ? this.renderBuildPanel()
        : this.tab === 'interact'
          ? this.renderInteractPanel()
          : this.tab === 'tests'
            ? this.renderTestsPanel()
            : this.tab === 'log'
              ? this.renderLogPanel()
              : this.renderLearnPanel(),
    );
    this.renderTabs();
    this.updateTabState();
  }

  private panelHeader(title: string, subtitle: string, extra?: Node | null): HTMLElement {
    return h(
      'div',
      { class: 'panel-header' },
      h('div', {}, h('h2', { class: 'panel-title' }, title), h('p', { class: 'panel-subtitle' }, subtitle)),
      extra ?? null,
    );
  }

  private renderBuildPanel(): HTMLElement {
    const container = h('div', { class: 'panel-section' });

    const versionOptions = this.versions.map((build) => ({
      value: build.version,
      label: build.version,
    }));
    if (versionOptions.length === 0) {
      versionOptions.push({ value: this.project.settings.compiler, label: this.project.settings.compiler });
    }
    if (!versionOptions.some((option) => option.value === this.project.settings.compiler)) {
      versionOptions.unshift({ value: this.project.settings.compiler, label: this.project.settings.compiler });
    }

    const optimizer = h('input', {
      type: 'checkbox',
      checked: this.project.settings.optimizer,
      'aria-label': 'Enable optimizer',
      on: {
        change: (event) => {
          this.project.settings.optimizer = (event.target as HTMLInputElement).checked;
          this.scheduleSave();
        },
      },
    });
    const runs = h('input', {
      class: 'input input-tiny',
      type: 'number',
      min: '1',
      max: '1000000',
      value: String(this.project.settings.runs),
      'aria-label': 'Optimizer runs',
      on: {
        change: (event) => {
          const value = Number((event.target as HTMLInputElement).value);
          if (Number.isFinite(value) && value > 0) {
            this.project.settings.runs = Math.round(value);
            this.scheduleSave();
          }
        },
      },
    });

    const compileButton = button('Compile', () => void this.compile(), {
      variant: 'primary',
      disabled: this.busy !== null,
      title: 'Compile with the official Solidity compiler (Ctrl/⌘ + Enter)',
    });

    const bar = h(
      'div',
      { class: 'build-bar' },
      h(
        'div',
        { class: 'build-controls' },
        h(
          'div',
          { class: 'control' },
          h('span', { class: 'field-label' }, 'Compiler'),
          selectInput(versionOptions, this.project.settings.compiler, (value) => {
            this.project.settings.compiler = value;
            this.scheduleSave();
          }, 'Solidity compiler version'),
        ),
        h('label', { class: 'control control-inline', title: 'Optimizer is recommended for deployment' }, optimizer, h('span', {}, 'Optimize')),
        h('label', { class: 'control control-inline' }, h('span', {}, 'Runs'), runs),
      ),
      compileButton,
    );

    container.appendChild(
      this.panelHeader(
        'Build',
        'Real Solidity compiler, downloaded once and cached for offline use.',
        h('a', { class: 'panel-link', href: 'https://docs.soliditylang.org/', target: '_blank', rel: 'noreferrer' }, 'Docs ↗'),
      ),
    );
    container.appendChild(bar);
    container.appendChild(h('p', { class: 'busy-line', 'data-busy': '' }, this.busy ?? ''));

    if (this.compileInfo) {
      const errorCount = this.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
      const warningCount = this.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
      container.appendChild(
        h(
          'div',
          { class: `notice ${errorCount > 0 ? 'notice-error' : 'notice-ok'}` },
          h('strong', {}, errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : 'Compiled'),
          h(
            'span',
            {},
            ` · ${this.compileInfo.version} · ${this.artifacts.length} contract${this.artifacts.length === 1 ? '' : 's'} · ${formatDuration(this.compileInfo.durationMs)}${warningCount ? ` · ${warningCount} warning${warningCount === 1 ? '' : 's'}` : ''}`,
          ),
        ),
      );
    }

    if (this.diagnostics.length > 0) {
      const list = h('div', { class: 'diagnostics' });
      for (const diagnostic of this.diagnostics) {
        list.appendChild(
          h(
            'details',
            { class: `diagnostic diagnostic-${diagnostic.severity}` },
            h(
              'summary',
              {},
              h('span', { class: `sev sev-${diagnostic.severity}` }, diagnostic.severity),
              h('span', { class: 'diagnostic-message' }, diagnostic.message.split('\n')[0]),
            ),
            h('pre', { class: 'diagnostic-body' }, diagnostic.formatted),
          ),
        );
      }
      container.appendChild(h('h3', { class: 'section-title' }, 'Compiler messages'));
      container.appendChild(list);
    }

    if (this.artifacts.length > 0) {
      container.appendChild(h('h3', { class: 'section-title' }, 'Contracts'));
      const list = h('div', { class: 'contract-list' });
      for (const artifact of this.artifacts) {
        const deployable = artifact.bytecode !== '0x';
        const selected = artifact.id === this.selectedContractId;
        const libraries = unlinkedLibraries(artifact);
        list.appendChild(
          h(
            'div',
            {
              class: `contract-card${selected ? ' is-selected' : ''}`,
              role: 'button',
              tabindex: 0,
              on: { click: () => this.selectContract(artifact.id) },
            },
            h(
              'div',
              { class: 'contract-main' },
              h('div', { class: 'contract-name' }, artifact.name),
              h(
                'div',
                { class: 'contract-meta' },
                artifact.file,
                deployable ? ` · ${formatBytes(artifact.bytecode.length / 2)}` : ' · no bytecode',
              ),
              libraries.length > 0
                ? h('div', { class: 'contract-warning' }, `Needs linking: ${libraries.join(', ')}`)
                : null,
            ),
            h(
              'div',
              { class: 'contract-actions' },
              button(
                'ABI',
                (event) => {
                  event.stopPropagation();
                  void copyText(JSON.stringify(artifact.abi, null, 2)).then((ok) =>
                    this.toast(ok ? 'ABI copied' : 'Clipboard unavailable', ok ? 'ok' : 'error'),
                  );
                },
                { variant: 'quiet', title: 'Copy the ABI as JSON' },
              ),
              h(
                'span',
                { class: `badge ${selected ? 'badge-accent' : ''}` },
                selected ? 'Selected' : 'Select',
              ),
            ),
          ),
        );
      }
      container.appendChild(list);

      const selected = this.artifacts.find((artifact) => artifact.id === this.selectedContractId);
      if (selected) container.appendChild(this.renderDeployForm(selected));
    } else if (!this.compileInfo) {
      container.appendChild(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, 'No build yet.'),
          h(
            'p',
            { class: 'muted' },
            'Press Compile to download the compiler (about 10 MB, cached afterwards) and build the example contract.',
          ),
        ),
      );
    }

    return container;
  }

  private selectContract(id: string): void {
    this.selectedContractId = id;
    this.renderPanel();
  }

  private renderAccountSelect(): HTMLSelectElement {
    const accounts = this.chain?.accounts ?? [];
    return selectInput(
      accounts.map((account) => ({
        value: String(account.index),
        label: `${account.label} · ${shortAddress(account.address)}`,
      })),
      String(this.accountIndex),
      (value) => {
        this.accountIndex = Number(value);
      },
      'Account to send from',
    );
  }

  private deploymentFor(contractId: string): Deployment | undefined {
    return [...this.deployments].reverse().find((deployment) => deployment.contractId === contractId);
  }

  private renderDeployForm(contract: CompiledContract): HTMLElement {
    const constructorAbi = contract.abi.find((item) => item.type === 'constructor');
    const inputs =
      constructorAbi && constructorAbi.type === 'constructor' ? (constructorAbi.inputs ?? []) : [];
    const existing = this.deploymentFor(contract.id);
    const libraries = unlinkedLibraries(contract);
    const canDeploy = contract.bytecode !== '0x' && libraries.length === 0;

    const form = h('div', { class: 'deploy-form' });
    form.appendChild(
      h(
        'div',
        { class: 'deploy-head' },
        h('h3', { class: 'section-title' }, `Deploy ${contract.name}`),
        existing
          ? h('span', { class: 'badge badge-ok' }, `live at ${shortAddress(existing.address)}`)
          : null,
      ),
    );

    if (inputs.length > 0) {
      const grid = h('div', { class: 'arg-grid' });
      inputs.forEach((input, index) => {
        const type = 'type' in input ? input.type : 'value';
        grid.appendChild(
          field(
            input.name ? `${input.name} (${type})` : type,
            textInput({
              placeholder: type.includes('[') || type.startsWith('tuple') ? 'JSON, e.g. [1,2]' : type,
              name: `ctor-${index}`,
            }),
          ),
        );
      });
      form.appendChild(grid);
    } else {
      form.appendChild(h('p', { class: 'muted' }, 'No constructor arguments.'));
    }

    const valueInput = textInput({ placeholder: '0', name: 'deploy-value' });
    const accountSelect = this.renderAccountSelect();
    form.appendChild(
      h(
        'div',
        { class: 'arg-grid arg-grid-inline' },
        field('Value (ETH)', valueInput),
        field('From account', accountSelect),
      ),
    );

    const deployButton = button(
      'Deploy to devnet',
      () => void this.deployContract(contract),
      { variant: 'primary', disabled: !canDeploy || this.busy !== null },
    );
    const injected = hasInjectedWallet();
    const walletButton = button(
      injected ? 'Deploy with browser wallet' : 'Deploy with mobile wallet',
      () => void this.deployToWallet(contract),
      {
        variant: 'ghost',
        disabled: !canDeploy || this.busy !== null,
        title: injected
          ? 'Send a real deployment transaction through your wallet'
          : 'Connect a wallet with WalletConnect (QR code on desktop, deep link on a phone), then deploy to a real network',
      },
    );

    form.appendChild(h('div', { class: 'button-row' }, deployButton, walletButton));
    form.appendChild(
      h(
        'p',
        { class: 'hint' },
        libraries.length > 0
          ? 'This contract links external libraries. Inline the library code or deploy and link it manually first.'
          : injected
            ? 'Devnet state lives in this tab: a reload starts a fresh chain. Your wallet deploys to a real network.'
            : 'Devnet state lives in this tab: a reload starts a fresh chain. No browser wallet? The mobile option pairs one over WalletConnect.',
      ),
    );
    return form;
  }

  private readConstructorArguments(container: HTMLElement, contract: CompiledContract): unknown[] {
    const constructorAbi = contract.abi.find((item) => item.type === 'constructor');
    const params = constructorAbi && constructorAbi.type === 'constructor' ? (constructorAbi.inputs ?? []) : [];
    const values = params.map((_param, index) => {
      const input = container.querySelector<HTMLInputElement>(`[name="ctor-${index}"]`);
      return input?.value ?? '';
    });
    return parseArguments(params, values);
  }

  private readValue(container: HTMLElement, name = 'deploy-value'): bigint {
    const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
    const raw = input?.value.trim() ?? '';
    if (!raw) return 0n;
    try {
      return parseEther(raw);
    } catch {
      throw new ArgumentError(`"${raw}" is not a valid ETH amount`);
    }
  }

  private async deployContract(contract: CompiledContract): Promise<void> {
    if (!this.chain || this.busy) return;
    const form = this.panel.querySelector<HTMLElement>('.deploy-form');
    if (!form) return;
    let args: unknown[];
    let value: bigint;
    try {
      args = this.readConstructorArguments(form, contract);
      value = this.readValue(form);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
      return;
    }

    this.setBusy('Deploying…');
    try {
      const result = await this.chain.deploy({
        abi: contract.abi,
        bytecode: contract.bytecode as Hex,
        args,
        value,
        contractId: contract.id,
        contractName: contract.name,
        account: this.chain.accounts[this.accountIndex]?.address,
      });
      this.addDeployment({
        id: `${result.address}-${Date.now()}`,
        name: contract.name,
        address: result.address,
        abi: contract.abi,
        contractId: contract.id,
        via: 'devnet',
        createdAt: Date.now(),
      });
      this.toast(`${contract.name} deployed at ${shortAddress(result.address)}`, 'ok');
      this.selectTab('interact');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.setBusy(null);
      this.renderPanel();
      this.renderStatus();
    }
  }

  private async deployToWallet(contract: CompiledContract): Promise<void> {
    if (this.busy) return;
    const form = this.panel.querySelector<HTMLElement>('.deploy-form');
    if (!form) return;
    let args: unknown[];
    let value: bigint;
    try {
      args = this.readConstructorArguments(form, contract);
      value = this.readValue(form);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
      return;
    }

    this.setBusy(hasInjectedWallet() ? 'Waiting for your wallet…' : 'Opening your wallet…');
    try {
      // Phones have no injected provider; this opens WalletConnect and waits
      // for the pairing before the deployment transaction is prepared.
      const route = await ensureWalletProvider();
      this.setBusy(route === 'injected' ? 'Waiting for your wallet…' : 'Pairing… confirm in your wallet app');
      const result = await deployWithWallet({
        abi: contract.abi,
        bytecode: contract.bytecode as Hex,
        args,
        value,
      });
      this.addDeployment({
        id: `${result.address}-${Date.now()}`,
        name: contract.name,
        address: result.address,
        abi: contract.abi,
        contractId: contract.id,
        via: 'wallet',
        chainId: result.chainId,
        createdAt: Date.now(),
      });
      this.walletChainId = result.chainId;
      this.toast(`Deployed on ${describeChain(result.chainId)} at ${shortAddress(result.address)}`, 'ok');
      this.selectTab('interact');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.setBusy(null);
      this.renderPanel();
      this.renderStatus();
    }
  }

  private addDeployment(deployment: Deployment): void {
    this.deployments = [...this.deployments, deployment];
    this.selectedDeploymentId = deployment.id;
    this.persistWalletDeployments();
  }

  /** Keep real-network deployments across reloads; devnet ones stay ephemeral. */
  private persistWalletDeployments(): void {
    saveWalletDeployments(
      this.deployments
        .filter((deployment) => deployment.via === 'wallet' && deployment.chainId !== undefined)
        .map((deployment) => ({
          id: deployment.id,
          name: deployment.name,
          address: deployment.address,
          abi: deployment.abi,
          contractId: deployment.contractId,
          chainId: deployment.chainId as number,
          createdAt: deployment.createdAt,
        })),
    );
  }

  private renderInteractPanel(): HTMLElement {
    const container = h('div', { class: 'panel-section' });
    container.appendChild(
      this.panelHeader(
        'Interact',
        'Call the deployed contract with auto-generated forms.',
        h(
          'div',
          { class: 'button-row' },
          walletProviderKind() === 'walletconnect'
            ? button('Disconnect wallet', () => void this.disconnectWallet(), {
                variant: 'quiet',
                title: 'End the WalletConnect pairing',
              })
            : null,
          this.deployments.length > 0
            ? button('Reset devnet', () => void this.resetChain(), { variant: 'quiet', title: 'Clear devnet state and devnet deployments' })
            : null,
        ),
      ),
    );

    if (this.deployments.length === 0) {
      container.appendChild(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, 'Nothing deployed yet.'),
          h('p', { class: 'muted' }, 'Compile on the Build tab, then deploy to the in-browser devnet.'),
        ),
      );
      return container;
    }

    const deployment =
      this.deployments.find((item) => item.id === this.selectedDeploymentId) ??
      this.deployments[this.deployments.length - 1];
    this.selectedDeploymentId = deployment.id;

    container.appendChild(
      h(
        'div',
        { class: 'deployment-bar' },
        selectInput(
          this.deployments.map((item) => ({
            value: item.id,
            label: `${item.name} · ${shortAddress(item.address)}${
              item.via === 'wallet'
                ? item.chainId !== undefined
                  ? ` (${describeChain(item.chainId)})`
                  : ' (wallet)'
                : ''
            }`,
          })),
          deployment.id,
          (value) => {
            this.selectedDeploymentId = value;
            this.renderPanel();
          },
          'Deployed contract',
        ),
        h(
          'button',
          {
            class: 'btn btn-quiet',
            type: 'button',
            title: 'Copy contract address',
            on: {
              click: () => {
                void copyText(deployment.address).then((ok) =>
                  this.toast(ok ? 'Address copied' : 'Clipboard unavailable', ok ? 'ok' : 'error'),
                );
              },
            },
          },
          monoId(deployment.address, 8),
        ),
      ),
    );

    const accountSelect = this.renderAccountSelect();
    container.appendChild(
      h(
        'div',
        { class: 'interact-meta' },
        h('span', { class: `badge ${deployment.via === 'wallet' ? 'badge-warn' : 'badge-ok'}` }, deployment.via === 'wallet' ? (deployment.chainId !== undefined ? describeChain(deployment.chainId) : 'Real network') : 'Devnet'),
        h('span', { class: 'muted' }, `Contract: ${deployment.name}`),
        deployment.via === 'wallet'
          ? h('span', { class: 'muted' }, 'Sender: the account you pick in your wallet')
          : h('label', { class: 'control control-inline' }, h('span', {}, 'From'), accountSelect),
      ),
    );

    const functions = listFunctions(deployment.abi);
    const reads = functions.filter((fn) => fn.kind === 'read');
    const writes = functions.filter((fn) => fn.kind === 'write');

    if (reads.length > 0) {
      container.appendChild(h('h3', { class: 'section-title' }, 'Read'));
      const list = h('div', { class: 'fn-list' });
      for (const fn of reads) list.appendChild(this.renderFunctionCard(deployment, fn));
      container.appendChild(list);
    }
    if (writes.length > 0) {
      container.appendChild(h('h3', { class: 'section-title' }, 'Write'));
      const list = h('div', { class: 'fn-list' });
      for (const fn of writes) list.appendChild(this.renderFunctionCard(deployment, fn));
      container.appendChild(list);
    }
    if (functions.length === 0) {
      container.appendChild(h('p', { class: 'muted' }, 'This ABI has no callable functions.'));
    }
    return container;
  }

  private renderFunctionCard(deployment: Deployment, fn: AbiFunctionInfo): HTMLElement {
    const card = h('div', { class: 'fn-card' });
    const inputs = fn.inputs.map((input, index) =>
      textInput({
        placeholder: input.name ? `${input.name}: ${input.type}` : input.type,
        ariaLabel: `${fn.name} argument ${index + 1}`,
        class: 'input-arg',
        name: `arg-${fn.key}-${index}`,
      }),
    );

    const valueInput =
      fn.kind === 'write'
        ? textInput({ placeholder: 'value (ETH)', ariaLabel: `${fn.name} value`, class: 'input-arg input-value', name: `value-${fn.key}` })
        : null;

    const result = h('div', { class: 'fn-result', 'aria-live': 'polite' });

    const call = async () => {
      result.className = 'fn-result';
      clear(result);
      result.appendChild(
        h('span', { class: 'muted' }, fn.kind === 'read' ? 'Calling…' : 'Waiting for your wallet…'),
      );
      try {
        const values = inputs.map((input) => input.value);
        const args = parseArguments(fn.inputs, values);
        if (fn.kind === 'read') {
          if (deployment.via === 'wallet') {
            await ensureWalletProvider();
            const outcome = await readWithWallet({
              address: deployment.address,
              abi: deployment.abi,
              functionName: fn.name,
              args,
              chainId: deployment.chainId,
            });
            clear(result);
            result.appendChild(
              h('div', { class: 'fn-value' }, formatValue(outcome.value) || '(no return value)'),
            );
            return;
          }
          if (!this.chain) throw new Error('Devnet is not ready');
          const outcome = await this.chain.read({
            address: deployment.address,
            abi: deployment.abi,
            functionName: fn.name,
            fn: fn.fn,
            args,
            account: this.chain.accounts[this.accountIndex]?.address,
          });
          clear(result);
          result.appendChild(
            h('div', { class: 'fn-value' }, formatValue(outcome.value) || '(no return value)'),
          );
          if (outcome.value !== undefined && outcome.value !== null) {
            result.appendChild(
              h('div', { class: 'fn-raw muted' }, `raw: ${outcome.raw === '0x' ? '0x' : monoId(outcome.raw, 12)}`),
            );
          }
          return;
        }

        if (deployment.via === 'wallet') {
          await ensureWalletProvider();
          const outcome = await writeWithWallet({
            address: deployment.address,
            abi: deployment.abi,
            functionName: fn.name,
            args,
            value: this.readValue(card, `value-${fn.key}`),
            chainId: deployment.chainId,
          });
          clear(result);
          if (outcome.status === 'reverted') {
            result.appendChild(
              h('div', { class: 'fn-error' }, `Transaction reverted in block ${outcome.blockNumber}`),
            );
          } else {
            result.appendChild(
              h(
                'div',
                { class: 'fn-ok' },
                `✓ block ${outcome.blockNumber} · ${describeChain(outcome.chainId)}`,
              ),
            );
          }
          const explorer = explorerTxUrl(outcome.chainId, outcome.hash);
          result.appendChild(
            explorer
              ? h(
                  'a',
                  {
                    class: 'fn-raw',
                    href: explorer,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                  },
                  `tx ${monoId(outcome.hash, 12)} ↗`,
                )
              : h('div', { class: 'fn-raw muted' }, `tx ${monoId(outcome.hash, 12)}`),
          );
          for (const log of outcome.events) {
            result.appendChild(
              h('div', { class: 'fn-event' }, `event ${log.eventName}(${formatValue(log.args)})`),
            );
          }
          return;
        }

        if (!this.chain) throw new Error('Devnet is not ready');
        const tx = await this.chain.write({
          address: deployment.address,
          abi: deployment.abi,
          functionName: fn.name,
          fn: fn.fn,
          args,
          value: this.readValue(card, `value-${fn.key}`),
          contractId: deployment.contractId,
          contractName: deployment.name,
          account: this.chain.accounts[this.accountIndex]?.address,
        });
        clear(result);
        result.appendChild(
          h('div', { class: 'fn-ok' }, `✓ block ${tx.blockNumber} · gas ${tx.gasUsed.toString()}`),
        );
        for (const log of tx.logs) {
          result.appendChild(
            h('div', { class: 'fn-event' }, `event ${log.eventName}(${formatValue(log.args)})`),
          );
        }
        this.renderStatus();
      } catch (error) {
        clear(result);
        result.appendChild(
          h('div', { class: 'fn-error' }, error instanceof Error ? error.message : String(error)),
        );
      }
    };

    card.appendChild(
      h(
        'div',
        { class: 'fn-head' },
        h('code', { class: 'fn-signature' }, fn.name),
        h('span', { class: 'fn-types', title: fn.signature }, fn.signature.replace(`${fn.name}`, '')),
        h('span', { class: `state-mutability mut-${fn.kind}` }, fn.stateMutability),
      ),
    );
    if (fn.inputs.length > 0) {
      card.appendChild(h('div', { class: 'fn-inputs' }, ...inputs));
    }
    card.appendChild(
      h(
        'div',
        { class: 'fn-actions' },
        valueInput,
        button(fn.kind === 'read' ? 'Call' : 'Send', () => void call(), {
          variant: fn.kind === 'read' ? 'ghost' : 'primary',
        }),
      ),
    );
    card.appendChild(result);
    return card;
  }

  /** Copy a link that carries the project in its fragment. */
  private async shareProject(): Promise<void> {
    let hash: string;
    try {
      hash = encodeProjectHash(this.project);
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
      return;
    }

    const base = `${window.location.origin}${window.location.pathname}`;
    const url = `${base}${hash}`;
    if (await copyText(url)) {
      this.toast('Share link copied', 'ok');
      return;
    }
    // Clipboard blocked: put the link in the address bar so it can be copied.
    window.location.hash = hash;
    this.toast('Share link is in the address bar', 'ok');
  }

  private async disconnectWallet(): Promise<void> {
    const { disconnectWallet } = await import('../lib/walletconnect.ts');
    await disconnectWallet();
    setFallbackProvider(null);
    this.toast('Wallet disconnected', 'ok');
    this.renderPanel();
  }

  private async resetChain(): Promise<void> {
    if (!this.chain) return;
    if (!window.confirm('Reset the devnet? Balances and contracts deployed to it in this tab are cleared. Wallet deployments stay.')) return;
    this.setBusy('Resetting devnet…');
    try {
      await this.chain.reset();
      // Real-network deployments are still valid after a devnet reset.
      this.deployments = this.deployments.filter((deployment) => deployment.via === 'wallet');
      if (!this.deployments.some((deployment) => deployment.id === this.selectedDeploymentId)) {
        this.selectedDeploymentId = this.deployments.at(-1)?.id ?? null;
      }
      this.persistWalletDeployments();
      this.toast('Devnet reset', 'ok');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.setBusy(null);
      this.renderPanel();
      this.renderStatus();
    }
  }

  private renderTestsPanel(): HTMLElement {
    const container = h('div', { class: 'panel-section' });
    const running = this.busy === 'Running tests…';

    container.appendChild(
      this.panelHeader(
        'Tests',
        'Write JavaScript tests against a fresh chain. No extra tooling.',
        button('Run tests', () => void this.runTests(), {
          variant: 'primary',
          disabled: running || this.artifacts.length === 0,
          title: this.artifacts.length === 0 ? 'Compile the project first' : 'Run the test file',
        }),
      ),
    );

    const editorHost = h('div', { class: 'test-editor-host' });
    container.appendChild(editorHost);
    this.testEditor = this.editorFactory(editorHost, {
      value: this.project.tests,
      ariaLabel: 'JavaScript test file',
      placeholder: "test('name', async () => { ... })",
      onChange: (value) => {
        this.project.tests = value;
        this.scheduleSave();
      },
      onRun: () => void this.runTests(),
    });

    container.appendChild(
      h(
        'p',
        { class: 'hint' },
        'Helpers: ',
        h('code', {}, 'test(name, fn)'),
        ', ',
        h('code', {}, 'expect(value).toBe(x)'),
        ', ',
        h('code', {}, 'await deploy("Name", args)'),
        ', ',
        h('code', {}, 'instance.read("fn", args)'),
        ', ',
        h('code', {}, 'instance.write("fn", args)'),
        ', ',
        h('code', {}, 'accounts'),
        ', ',
        h('code', {}, 'chain'),
        '. Each run starts from a clean devnet.',
      ),
    );

    if (this.artifacts.length === 0) {
      container.appendChild(h('div', { class: 'notice notice-warn' }, 'Compile the project before running tests.'));
    }

    if (this.testRun) {
      const run = this.testRun;
      container.appendChild(
        h(
          'div',
          { class: `test-summary ${run.failed > 0 ? 'is-fail' : 'is-pass'}` },
          h('strong', {}, run.failed > 0 ? `${run.failed} failing` : 'All tests passed'),
          h('span', {}, ` · ${run.passed}/${run.total} passed · ${formatDuration(run.durationMs)}`),
        ),
      );
      const list = h('div', { class: 'test-results' });
      for (const result of run.results) {
        list.appendChild(
          h(
            'div',
            { class: `test-case ${result.ok ? 'is-pass' : 'is-fail'}` },
            h('span', { class: 'test-icon', 'aria-hidden': 'true' }, result.ok ? '✓' : '✗'),
            h(
              'div',
              { class: 'test-body' },
              h('div', { class: 'test-name' }, result.name),
              result.error ? h('pre', { class: 'test-error' }, result.error) : null,
            ),
            h('span', { class: 'test-time muted' }, `${result.durationMs} ms`),
          ),
        );
      }
      container.appendChild(list);
      if (run.logs.length > 0) {
        container.appendChild(h('h3', { class: 'section-title' }, 'Console'));
        container.appendChild(h('pre', { class: 'console-out' }, run.logs.join('\n')));
      }
    }

    return container;
  }

  private async runTests(): Promise<void> {
    if (this.busy) return;
    if (this.artifacts.length === 0) {
      this.toast('Compile the project before running tests', 'error');
      return;
    }
    this.setBusy('Running tests…');
    const runButton = this.panel.querySelector<HTMLButtonElement>('.panel-header .btn-primary');
    if (runButton) runButton.disabled = true;
    try {
      this.testRun = await runTestSuite(this.project.tests, this.artifacts);
    } catch (error) {
      this.testRun = {
        total: 1,
        passed: 0,
        failed: 1,
        results: [
          {
            name: 'Test file',
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: 0,
          },
        ],
        logs: [],
        durationMs: 0,
      };
    } finally {
      this.setBusy(null);
    }
    this.renderPanel();
    this.renderStatus();
  }

  private renderLogPanel(): HTMLElement {
    const container = h('div', { class: 'panel-section' });
    const activity = this.chain?.activity ?? [];
    container.appendChild(
      this.panelHeader(
        'Activity',
        'Everything sent to the in-browser devnet in this tab.',
        activity.length > 0
          ? button('Clear', () => void this.resetChain(), { variant: 'quiet' })
          : null,
      ),
    );

    if (activity.length === 0) {
      container.appendChild(
        h('div', { class: 'empty' }, h('p', {}, 'No transactions yet.'), h('p', { class: 'muted' }, 'Deploy or send a transaction and it will show up here.')),
      );
      return container;
    }

    const list = h('div', { class: 'tx-list' });
    for (const tx of activity) list.appendChild(this.renderTx(tx));
    container.appendChild(list);
    return container;
  }

  private renderTx(tx: TxLog): HTMLElement {
    return h(
      'details',
      { class: `tx tx-${tx.status}` },
      h(
        'summary',
        {},
        h('span', { class: `tx-status ${tx.status}` }, tx.status === 'success' ? '✓' : '✗'),
        h('span', { class: 'tx-name' }, tx.kind === 'deploy' ? `deploy ${tx.contractName ?? ''}` : tx.functionName),
        h('span', { class: 'tx-block muted' }, `block ${tx.blockNumber}`),
        h('span', { class: 'tx-gas muted' }, `${tx.gasUsed.toString()} gas`),
      ),
      h(
        'div',
        { class: 'tx-body' },
        h('div', { class: 'tx-row' }, h('span', { class: 'muted' }, 'hash'), h('code', {}, tx.hash)),
        h('div', { class: 'tx-row' }, h('span', { class: 'muted' }, 'from'), h('code', {}, tx.from)),
        tx.to ? h('div', { class: 'tx-row' }, h('span', { class: 'muted' }, 'to'), h('code', {}, tx.to)) : null,
        h(
          'div',
          { class: 'tx-row' },
          h('span', { class: 'muted' }, 'value'),
          h('code', {}, `${formatEth(tx.value)} ETH`),
        ),
        tx.error ? h('pre', { class: 'test-error' }, tx.error) : null,
        tx.logs.length > 0
          ? h(
              'div',
              { class: 'tx-events' },
              ...tx.logs.map((log) =>
                h('div', { class: 'tx-event' }, h('strong', {}, log.eventName), ` ${formatValue(log.args)}`),
              ),
            )
          : null,
      ),
    );
  }

  private renderLearnPanel(): HTMLElement {
    const container = h('div', { class: 'panel-section learn' });
    container.appendChild(
      this.panelHeader('Learn', 'A five-minute path from zero to a deployed contract.'),
    );

    const steps: Array<[string, string]> = [
      ['1. Edit', 'Pick a template or write Solidity in the editor. Use the + button to add files; imports resolve inside the project.'],
      ['2. Compile', 'Press Compile. The official compiler is downloaded once from binaries.soliditylang.org and cached offline.'],
      ['3. Deploy', 'Deploy to the devnet, an EVM that runs entirely in this tab. Accounts, gas, events and reverts are real.'],
      ['4. Interact', 'Forms are generated from the ABI. Read calls are free; writes mine instantly.'],
      ['5. Test', 'Write JavaScript tests that run on a fresh chain, so one failed test cannot poison the next.'],
      ['6. Ship', 'Export the project, deploy to a real network with your wallet (MetaMask on a desktop, WalletConnect on a phone), and share the link. No account, no server, no build step.'],
    ];

    for (const [title, body] of steps) {
      container.appendChild(h('div', { class: 'learn-step' }, h('h3', {}, title), h('p', {}, body)));
    }

    container.appendChild(h('h3', { class: 'section-title' }, 'Good to know'));
    const notes = [
      'The devnet is ephemeral: reloading the page resets balances, blocks and deployments.',
      'Devnet private keys are random and live only in memory. Never send real funds to these addresses.',
      'Contracts can only import files in this project. Vendor dependencies as files, or keep contracts self-contained.',
      'Compiling runs a WebAssembly build of solc in your browser. Nothing is uploaded anywhere.',
      'This is a learning and prototyping tool. Audit and test thoroughly before mainnet.',
    ];
    container.appendChild(h('ul', { class: 'learn-notes' }, ...notes.map((note) => h('li', {}, note))));

    container.appendChild(
      h(
        'div',
        { class: 'learn-links' },
        h('a', { href: 'https://docs.soliditylang.org/', target: '_blank', rel: 'noreferrer' }, 'Solidity docs ↗'),
        h('a', { href: 'https://ethereum.org/en/developers/docs/', target: '_blank', rel: 'noreferrer' }, 'Ethereum developer docs ↗'),
        h('a', { href: 'https://eips.ethereum.org/EIPS/eip-20', target: '_blank', rel: 'noreferrer' }, 'ERC-20 spec ↗'),
        h('a', { href: GITHUB_URL, target: '_blank', rel: 'noreferrer' }, 'Source code ↗'),
      ),
    );
    container.appendChild(
      h(
        'p',
        { class: 'hint' },
        'ChainPad is free and open source. ',
        h('a', { href: SPONSOR_URL, target: '_blank', rel: 'noreferrer' }, 'Sponsor the project ↗'),
      ),
    );
    return container;
  }

  // -------------------------------------------------------------- actions

  private async compile(): Promise<void> {
    if (this.busy) return;
    this.tab = 'build';
    this.mobileView = 'panel';
    this.setBusy('Fetching compiler list…');
    this.renderPanel();
    try {
      const builds = this.versions.length > 0 ? this.versions : await listCompilerVersions();
      this.versions = builds;
      const wanted = this.project.settings.compiler;
      const build = builds.find((candidate) => candidate.version === wanted) ?? builds[0];
      if (!build) throw new Error('No Solidity compiler versions are available offline yet');
      if (build.version !== wanted) {
        this.project.settings.compiler = build.version;
        this.scheduleSave();
      }

      const compiler = await getCompiler(build, (message) => this.setBusy(message));
      this.setBusy('Compiling…');
      const result = compileProject(this.project.files, this.project.settings, compiler);
      this.artifacts = result.contracts;
      this.diagnostics = result.diagnostics;
      this.compileInfo = {
        version: result.compilerVersion,
        durationMs: result.durationMs,
        at: Date.now(),
      };
      if (!this.artifacts.some((artifact) => artifact.id === this.selectedContractId)) {
        const deployable = this.artifacts.find((artifact) => artifact.bytecode !== '0x');
        this.selectedContractId = deployable?.id ?? this.artifacts[0]?.id ?? null;
      }
      const errors = this.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
      if (errors === 0) {
        this.toast(`Compiled ${this.artifacts.length} contract${this.artifacts.length === 1 ? '' : 's'}`, 'ok');
      } else {
        this.toast(`${errors} compile error${errors === 1 ? '' : 's'}`, 'error');
      }
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.setBusy(null);
      this.renderPanel();
      this.renderStatus();
    }
  }

  private setBusy(message: string | null): void {
    this.busy = message;
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-busy]')) {
      element.textContent = message ?? '';
    }
    this.root.classList.toggle('is-busy', message !== null);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      saveProject(this.project);
      this.saveTimer = null;
    }, 400);
  }

  private exportProject(): void {
    const blob = new Blob([serializeProject(this.project)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = h('a', { href: url, download: `${this.project.name.replace(/\s+/g, '-').toLowerCase()}-chainpad.json` });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.toast('Project exported', 'ok');
  }

  private importProject(): void {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.loadProjectFile(file);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  private async loadProjectFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      this.replaceProject(parseProject(text), false);
      this.toast(`Loaded ${this.project.name}`, 'ok');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private replaceProject(project: Project, confirmFirst: boolean): void {
    if (confirmFirst && !window.confirm('Replace the current project? Export it first if you want to keep it.')) {
      return;
    }
    this.project = project;
    this.artifacts = [];
    this.diagnostics = [];
    this.compileInfo = null;
    this.testRun = null;
    this.selectedContractId = null;
    this.selectedDeploymentId = null;
    this.tab = 'build';
    this.mobileView = 'panel';
    this.renderFileBar();
    this.editor?.setValue(this.currentFile()?.content ?? '');
    saveProject(this.project);
    this.renderPanel();
    this.renderStatus();
  }

  private openTemplates(): void {
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Project templates' });
    const close = () => overlay.remove();
    const grid = h('div', { class: 'template-grid' });
    for (const template of TEMPLATES) {
      grid.appendChild(this.renderTemplateCard(template, () => {
        close();
        this.replaceProject(template.project(), true);
      }));
    }
    overlay.appendChild(
      h(
        'div',
        { class: 'modal' },
        h(
          'div',
          { class: 'modal-head' },
          h('h2', {}, 'Start from a template'),
          button('Close', close, { variant: 'quiet' }),
        ),
        h('p', { class: 'muted' }, 'Each template ships with a test file. Replace the current project when you pick one.'),
        grid,
      ),
    );
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onKey);
      }
    });
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>('button')?.focus();
  }

  private renderTemplateCard(template: Template, onUse: () => void): HTMLElement {
    return h(
      'div',
      { class: 'template-card' },
      h('h3', {}, template.name),
      h('p', {}, template.description),
      h('div', { class: 'template-tags' }, ...template.tags.map((tag) => h('span', { class: 'tag' }, tag))),
      button('Use template', onUse, { variant: 'primary' }),
    );
  }

  // ---------------------------------------------------------------- status

  private renderStatus(): void {
    if (!this.status) return;
    clear(this.status);
    const accounts = this.chain?.accounts ?? [];
    const account = accounts[this.accountIndex];
    this.status.append(
      h(
        'div',
        { class: 'status-left' },
        h('span', { class: 'dot', 'aria-hidden': 'true' }),
        h('span', {}, this.chain ? `${CHAIN_NAME} · block ${this.chain.block}` : 'Starting devnet…'),
        account ? h('span', { class: 'muted' }, ` · ${account.label} ${shortAddress(account.address)}`) : null,
      ),
      h(
        'div',
        { class: 'status-right' },
        h('span', { class: 'muted' }, `${this.deployments.length} deployment${this.deployments.length === 1 ? '' : 's'}`),
        this.compileInfo
          ? h('span', { class: 'muted' }, ` · compiler ${this.compileInfo.version.split('+')[0]}`)
          : null,
        walletProviderKind()
          ? h(
              'span',
              { class: 'badge badge-warn status-wallet', title: 'A wallet is connected for real-network calls' },
              this.walletChainId !== null ? describeChain(this.walletChainId) : 'Wallet connected',
            )
          : null,
        h('span', { class: 'muted status-note' }, ' · devnet resets on reload'),
      ),
    );
  }

  private toast(message: string, variant: 'ok' | 'error' = 'ok'): void {
    if (!this.toastHost) return;
    const item = h('div', { class: `toast toast-${variant}` }, message);
    this.toastHost.appendChild(item);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      item.classList.add('is-leaving');
      setTimeout(() => item.remove(), 250);
    }, 4200);
  }

  /** Exposed for tests and debugging. */
  get accounts(): DevAccount[] {
    return this.chain?.accounts ?? [];
  }
}
