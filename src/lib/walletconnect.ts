/**
 * Mobile wallet connection through WalletConnect.
 *
 * On a phone there is no injected provider, so the desktop-only path
 * (`window.ethereum`) leaves most of ChainPad's audience unable to deploy to a
 * real network. WalletConnect fixes that: it shows a QR code on a laptop and
 * deep-links straight into a wallet app on a phone, then hands back a normal
 * EIP-1193 provider.
 *
 * The SDK is large, so it is loaded with a dynamic `import()` only when someone
 * actually clicks deploy. Visitors who stay on the devnet never download it.
 */

import type { Eip1193Provider } from './wallet.ts';

/**
 * Public Reown/WalletConnect project id. It identifies the app to the relay, it
 * is not a secret, and it ships in the bundle. Self-hosters can point ChainPad
 * at their own project with:
 *   localStorage.setItem('chainpad:walletconnect-project-id', '…')
 */
export const DEFAULT_PROJECT_ID = '6cfd555f7501e9645fe329e0af01dcfc';

export const PROJECT_ID_KEY = 'chainpad:walletconnect-project-id';

/** Chains offered in the wallet picker. */
const CHAINS = [1, 11155111] as const;
const OPTIONAL_CHAINS = [1, 10, 56, 100, 137, 8453, 42161, 42220, 43114, 11155111] as const;

/** Public RPC endpoints, used by the relay for chains the wallet does not know. */
const RPC_MAP: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
  100: 'https://gnosis-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  42220: 'https://celo-rpc.publicnode.com',
  43114: 'https://avalanche-c-chain-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
};

export interface WalletConnectOptions {
  projectId: string;
  chains: number[];
  optionalChains: number[];
  rpcMap: Record<number, string>;
  showQrModal: boolean;
  metadata: {
    name: string;
    description: string;
    url: string;
    icons: string[];
  };
}

/** A connected WalletConnect provider; `disconnect` is optional for tests. */
export interface WalletConnectSession extends Eip1193Provider {
  disconnect?: () => Promise<void>;
}

export type WalletConnectInit = (options: WalletConnectOptions) => Promise<WalletConnectSession>;

export class WalletConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletConnectError';
  }
}

/** The project id in use: the stored override when present, else the default. */
export function walletConnectProjectId(): string {
  try {
    const stored = localStorage.getItem(PROJECT_ID_KEY)?.trim();
    if (stored) return stored;
  } catch {
    // Private mode can make localStorage throw; the default still works.
  }
  return DEFAULT_PROJECT_ID;
}

function metadata(): WalletConnectOptions['metadata'] {
  const origin = typeof location !== 'undefined' ? location.origin + location.pathname : 'https://sheikhminds.github.io/chainpad/';
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  return {
    name: 'ChainPad',
    description: 'Compile, test and deploy Solidity contracts in your browser.',
    url: base,
    icons: [`${base}icon.svg`],
  };
}

/** Options passed to the SDK; exported so the wiring can be unit tested. */
export function walletConnectOptions(projectId = walletConnectProjectId()): WalletConnectOptions {
  return {
    projectId,
    chains: [...CHAINS],
    optionalChains: [...OPTIONAL_CHAINS],
    rpcMap: { ...RPC_MAP },
    showQrModal: true,
    metadata: metadata(),
  };
}

/** Default initialiser: the real SDK, loaded lazily. */
async function defaultInit(options: WalletConnectOptions): Promise<WalletConnectSession> {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  return EthereumProvider.init(options as Parameters<typeof EthereumProvider.init>[0]);
}

let session: WalletConnectSession | null = null;
let connecting: Promise<WalletConnectSession> | null = null;

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { message?: string };
    if (record.message) return record.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the WalletConnect modal and return a provider once a wallet is paired.
 *
 * Concurrent calls share one attempt, so a double tap cannot open two modals.
 */
export async function connectWallet(input: { init?: WalletConnectInit; projectId?: string } = {}): Promise<WalletConnectSession> {
  if (session) return session;
  if (connecting) return connecting;

  const init = input.init ?? defaultInit;
  const options = walletConnectOptions(input.projectId);

  connecting = (async () => {
    try {
      const provider = await init(options);
      const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
      if (!Array.isArray(accounts) || accounts.length === 0) {
        // `enable()` is what actually pairs the wallet when `init` is silent.
        const requested = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
        if (!requested || requested.length === 0) {
          throw new WalletConnectError('The wallet connected but did not share an account.');
        }
      }
      session = provider;
      return provider;
    } catch (error) {
      throw error instanceof WalletConnectError
        ? error
        : new WalletConnectError(`Could not connect a mobile wallet: ${describe(error)}`);
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/** The paired provider, if any. */
export function walletConnectSession(): WalletConnectSession | null {
  return session;
}

/** Forget the pairing and end the relay session. */
export async function disconnectWallet(): Promise<void> {
  const current = session;
  session = null;
  connecting = null;
  if (!current) return;
  try {
    await current.disconnect?.();
  } catch {
    // A dead relay session is already disconnected; nothing useful to report.
  }
}
