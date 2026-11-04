// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  connectWallet,
  DEFAULT_PROJECT_ID,
  disconnectWallet,
  PROJECT_ID_KEY,
  walletConnectOptions,
  walletConnectProjectId,
  walletConnectSession,
  WalletConnectError,
  type WalletConnectInit,
  type WalletConnectSession,
} from '../src/lib/walletconnect.ts';
import {
  ensureWalletProvider,
  readWithWallet,
  setFallbackProvider,
  walletProviderKind,
} from '../src/lib/wallet.ts';

const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ABI = [
  {
    type: 'function',
    name: 'count',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

function fakeSession(overrides: Partial<Record<string, unknown>> = {}): {
  session: WalletConnectSession;
  calls: string[];
  disconnect: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const disconnect = vi.fn(async () => {});
  const session: WalletConnectSession = {
    request: async ({ method }) => {
      calls.push(method);
      if (method in overrides) {
        const value = overrides[method];
        if (value instanceof Error) throw value;
        return value;
      }
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [SENDER];
        case 'eth_chainId':
          return '0x1';
        case 'eth_call':
          return `0x${(7).toString(16).padStart(64, '0')}` as Hex;
        default:
          throw new Error(`Unexpected method ${method}`);
      }
    },
    disconnect,
  };
  return { session, calls, disconnect };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await disconnectWallet();
  setFallbackProvider(null);
  vi.restoreAllMocks();
});

describe('walletconnect configuration', () => {
  it('uses the bundled project id by default', () => {
    expect(walletConnectProjectId()).toBe(DEFAULT_PROJECT_ID);
    expect(DEFAULT_PROJECT_ID).toMatch(/^[0-9a-f]{32}$/);
  });

  it('lets a self-hoster point it at their own project id', () => {
    localStorage.setItem(PROJECT_ID_KEY, '  abcdefabcdefabcdefabcdefabcdef12  ');
    expect(walletConnectProjectId()).toBe('abcdefabcdefabcdefabcdefabcdef12');
    expect(walletConnectOptions().projectId).toBe('abcdefabcdefabcdefabcdefabcdef12');
  });

  it('asks for mainnet and a testnet, with an RPC for every offered chain', () => {
    const options = walletConnectOptions('p');
    expect(options.projectId).toBe('p');
    expect(options.chains).toContain(1);
    expect(options.chains).toContain(11155111);
    expect(options.showQrModal).toBe(true);
    for (const chainId of options.optionalChains) {
      expect(options.rpcMap[chainId], `missing RPC for chain ${chainId}`).toMatch(/^https:\/\//);
    }
    expect(options.metadata.name).toBe('ChainPad');
    expect(options.metadata.icons[0].endsWith('/icon.svg')).toBe(true);
  });
});

describe('connecting a mobile wallet', () => {
  it('registers the paired provider as the wallet fallback', async () => {
    const { session, calls } = fakeSession();
    const init = vi.fn<WalletConnectInit>(async () => session);

    expect(walletProviderKind()).toBeNull();
    const connected = await connectWallet({ init });

    expect(connected).toBe(session);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0].projectId).toBe(DEFAULT_PROJECT_ID);
    // It checks the existing session before prompting for accounts.
    expect(calls[0]).toBe('eth_accounts');
  });

  it('shares one pairing attempt between concurrent clicks', async () => {
    const { session } = fakeSession();
    const init = vi.fn<WalletConnectInit>(
      () => new Promise((resolve) => setTimeout(() => resolve(session), 10)),
    );
    const [a, b] = await Promise.all([connectWallet({ init }), connectWallet({ init })]);
    expect(a).toBe(b);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the wallet shares no account', async () => {
    const { session } = fakeSession({ eth_accounts: [], eth_requestAccounts: [] });
    const init = vi.fn<WalletConnectInit>(async () => session);
    await expect(connectWallet({ init })).rejects.toBeInstanceOf(WalletConnectError);
    await expect(connectWallet({ init })).rejects.toThrow(/did not share an account/);
  });

  it('wraps SDK failures with the reason from the SDK', async () => {
    const init = vi.fn<WalletConnectInit>(async () => {
      throw new Error('Project not found');
    });
    await expect(connectWallet({ init })).rejects.toThrow(
      'Could not connect a mobile wallet: Project not found',
    );
  });

  it('forces the pairing prompt when init returns a silent session', async () => {
    const { session, calls } = fakeSession({ eth_accounts: [] });
    const init = vi.fn<WalletConnectInit>(async () => session);
    await connectWallet({ init });
    expect(calls).toEqual(['eth_accounts', 'eth_requestAccounts']);
  });

  it('ends the session and clears the fallback on disconnect', async () => {
    const { session, disconnect } = fakeSession();
    await connectWallet({ init: async () => session });
    expect(walletConnectSession()).toBe(session);
    await disconnectWallet();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(walletConnectSession()).toBeNull();
  });
});

describe('using the paired provider', () => {
  it('routes reads through the fallback when no wallet extension exists', async () => {
    const { session } = fakeSession();
    setFallbackProvider(session);

    expect(await ensureWalletProvider()).toBe('walletconnect');
    const result = await readWithWallet({
      address: CONTRACT,
      abi: ABI as unknown as never,
      functionName: 'count',
      args: [],
      chainId: 1,
    });
    expect(result.value).toBe(7n);
    expect(result.chainId).toBe(1);
  });

  it('prefers an injected wallet over the fallback', async () => {
    setFallbackProvider(fakeSession().session);
    (window as { ethereum?: unknown }).ethereum = {
      request: async () => [],
    };
    expect(await ensureWalletProvider()).toBe('injected');
    expect(walletProviderKind()).toBe('injected');
    delete (window as { ethereum?: unknown }).ethereum;
  });
});
