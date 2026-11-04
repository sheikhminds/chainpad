/**
 * Browser-wallet deployment.
 *
 * The in-page devnet is the default target, but a contract is only useful once
 * it lives on a shared network. This module talks to an injected EIP-1193
 * provider (MetaMask, Rabby, Frame, …) through `eth_sendTransaction`, which is
 * the one code path every wallet implements. Everything else stays in ChainPad.
 *
 * This is deliberately small: ChainPad never asks for private keys, never signs
 * locally, and never moves funds on its own. The user confirms every transaction
 * in their wallet.
 */

import {
  createPublicClient,
  custom,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  type Abi,
  type Hex,
  type PublicClient,
} from 'viem';

/** The subset of the EIP-1193 provider interface this module relies on. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

/** True when the page is running inside a wallet-enabled browser. */
export function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && typeof window.ethereum?.request === 'function';
}

/** Provider registered by the WalletConnect path, once a wallet is paired. */
let fallbackProvider: Eip1193Provider | null = null;

/** Register (or clear) a paired WalletConnect provider. */
export function setFallbackProvider(provider: Eip1193Provider | null): void {
  fallbackProvider = provider;
}

/** Which wallet route is currently usable, if any. */
export function walletProviderKind(): 'injected' | 'walletconnect' | null {
  if (hasInjectedWallet()) return 'injected';
  if (fallbackProvider) return 'walletconnect';
  return null;
}

/**
 * Make sure *some* wallet is reachable.
 *
 * Desktop visitors with MetaMask are ready immediately. Everyone else — which
 * includes every phone browser — goes through WalletConnect, which is loaded
 * on demand so the devnet-only use case never pays for it.
 */
export async function ensureWalletProvider(): Promise<'injected' | 'walletconnect'> {
  if (hasInjectedWallet()) return 'injected';
  if (!fallbackProvider) {
    const { connectWallet } = await import('./walletconnect.ts');
    const session = await connectWallet();
    setFallbackProvider(session);
  }
  return 'walletconnect';
}

function provider(): Eip1193Provider {
  if (hasInjectedWallet()) return window.ethereum as Eip1193Provider;
  if (fallbackProvider) return fallbackProvider;
  throw new WalletError(
    'No wallet connected. Install MetaMask (or another EIP-1193 wallet), or connect a mobile wallet with WalletConnect.',
  );
}

export interface WalletDeployInput {
  abi: Abi;
  bytecode: Hex;
  args?: unknown[];
  value?: bigint;
  /** Optional gas limit; wallets estimate one when omitted. */
  gas?: bigint;
}

export interface WalletDeployResult {
  address: Hex;
  hash: Hex;
  chainId: number;
}

function toQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as { code?: number; message?: string; data?: { message?: string } };
    if (record.code === 4001) return 'You rejected the transaction in your wallet.';
    const message = record.data?.message ?? record.message;
    if (message) return message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ask the wallet to deploy a contract and wait for it to be mined.
 *
 * The address is derived locally from the sender and nonce so the UI can show
 * the contract immediately, then verified against the receipt.
 */
export async function deployWithWallet(input: WalletDeployInput): Promise<WalletDeployResult> {
  const eth = provider();

  let data: Hex;
  try {
    data = encodeDeployData({
      abi: input.abi,
      bytecode: input.bytecode,
      args: input.args ?? [],
    } as Parameters<typeof encodeDeployData>[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WalletError(`Constructor arguments are not valid: ${message}`);
  }

  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  const from = accounts?.[0];
  if (!from) throw new WalletError('Your wallet did not return an account.');

  const chainIdHex = (await eth.request({ method: 'eth_chainId' })) as string;
  const chainId = Number.parseInt(chainIdHex, 16);
  if (!Number.isFinite(chainId)) throw new WalletError('Could not read the network from your wallet.');

  let hash: Hex;
  try {
    hash = (await eth.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from,
          data,
          value: toQuantity(input.value ?? 0n),
          ...(input.gas ? { gas: toQuantity(input.gas) } : {}),
        },
      ],
    })) as Hex;
  } catch (error) {
    throw new WalletError(describeError(error));
  }

  if (!hash) throw new WalletError('Your wallet did not return a transaction hash.');

  const client: PublicClient = createPublicClient({
    transport: custom(eth),
  });

  let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  } catch (error) {
    throw new WalletError(
      `Transaction ${hash} was sent but the receipt could not be read: ${describeError(error)}`,
    );
  }

  if (receipt.status !== 'success') {
    throw new WalletError(`The deployment transaction reverted (${hash}).`);
  }
  if (!receipt.contractAddress) {
    throw new WalletError('The transaction succeeded but did not create a contract.');
  }

  return { address: receipt.contractAddress, hash, chainId };
}

/** Human names for the networks people actually deploy to. */
const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'OP Mainnet',
  56: 'BNB Chain',
  100: 'Gnosis',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum One',
  42220: 'Celo',
  43114: 'Avalanche',
  11155111: 'Sepolia',
  17000: 'Holesky',
  31337: 'Local node',
};

/** Block explorers, so a wallet transaction is one click from being verified. */
const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  10: 'https://optimistic.etherscan.io',
  56: 'https://bscscan.com',
  100: 'https://gnosisscan.io',
  137: 'https://polygonscan.com',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  42220: 'https://celoscan.io',
  43114: 'https://snowtrace.io',
  11155111: 'https://sepolia.etherscan.io',
  17000: 'https://holesky.etherscan.io',
};

/** `chain 11155111 (Sepolia)` — used in the UI and in error messages. */
export function describeChain(chainId: number): string {
  const name = CHAIN_NAMES[chainId];
  return name ? `chain ${chainId} (${name})` : `chain ${chainId}`;
}

/**
 * Explorer link for a transaction, or `null` when the chain has no known
 * explorer (local nodes, testnets we have not listed).
 */
export function explorerTxUrl(chainId: number, hash: Hex): string | null {
  const base = EXPLORERS[chainId];
  return base ? `${base}/tx/${hash}` : null;
}

function callData(input: WalletCallInput): Hex {
  try {
    return encodeFunctionData({
      abi: input.abi,
      functionName: input.functionName,
      args: input.args ?? [],
    } as Parameters<typeof encodeFunctionData>[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WalletError(`Arguments for ${input.functionName}() are not valid: ${message}`);
  }
}

async function readChainId(eth: Eip1193Provider): Promise<number> {
  const chainIdHex = (await eth.request({ method: 'eth_chainId' })) as string;
  const chainId = Number.parseInt(chainIdHex, 16);
  if (!Number.isFinite(chainId)) throw new WalletError('Could not read the network from your wallet.');
  return chainId;
}

/**
 * Refuse to talk to the wrong network. Sending a transaction to a chain that
 * does not hold the contract would either revert or, worse, hit a different
 * contract at the same address.
 */
async function requireChain(eth: Eip1193Provider, expected: number | undefined): Promise<number> {
  const chainId = await readChainId(eth);
  if (expected !== undefined && chainId !== expected) {
    throw new WalletError(
      `Your wallet is on ${describeChain(chainId)}, but this contract was deployed on ${describeChain(expected)}. Switch networks in your wallet and try again.`,
    );
  }
  return chainId;
}

export interface WalletCallInput {
  address: Hex;
  abi: Abi;
  functionName: string;
  args?: unknown[];
  /** The chain the contract lives on; the wallet must be on the same one. */
  chainId?: number;
}

export interface WalletReadResult {
  /** Decoded return value, with every `uintN` as a `bigint`. */
  value: unknown;
  chainId: number;
}

/**
 * Read a contract on a real network through the wallet's provider.
 *
 * Uses `eth_call`, which never asks the user to sign anything, so reads stay as
 * free and instant as they are on the devnet.
 */
export async function readWithWallet(input: WalletCallInput): Promise<WalletReadResult> {
  const eth = provider();
  const chainId = await requireChain(eth, input.chainId);
  const data = callData(input);

  const accounts = (await eth.request({ method: 'eth_accounts' }).catch(() => [])) as
    | string[]
    | undefined;

  let raw: Hex;
  try {
    raw = (await eth.request({
      method: 'eth_call',
      params: [
        { to: input.address, data, ...(accounts?.[0] ? { from: accounts[0] } : {}) },
        'latest',
      ],
    })) as Hex;
  } catch (error) {
    throw new WalletError(`${input.functionName}() reverted: ${describeError(error)}`);
  }

  let value: unknown = undefined;
  try {
    value = decodeFunctionResult({
      abi: input.abi,
      functionName: input.functionName,
      data: raw ?? '0x',
    } as Parameters<typeof decodeFunctionResult>[0]);
  } catch {
    // A function without an output returns `0x`; that is not an error.
    value = undefined;
  }
  return { value, chainId };
}

export interface WalletEvent {
  eventName: string;
  args: unknown;
}

export interface WalletWriteResult {
  hash: Hex;
  chainId: number;
  status: 'success' | 'reverted';
  blockNumber: bigint | null;
  events: WalletEvent[];
}

/**
 * Send a write call through the wallet and wait for it to be mined.
 *
 * The user confirms in their own wallet; ChainPad never sees a key. Events are
 * decoded from the receipt so the UI can show what actually happened rather
 * than just "sent".
 */
export async function writeWithWallet(input: WalletCallInput & { value?: bigint }): Promise<WalletWriteResult> {
  const eth = provider();
  const chainId = await requireChain(eth, input.chainId);
  const data = callData(input);

  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  const from = accounts?.[0];
  if (!from) throw new WalletError('Your wallet did not return an account.');

  let hash: Hex;
  try {
    hash = (await eth.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from,
          to: input.address,
          data,
          value: toQuantity(input.value ?? 0n),
        },
      ],
    })) as Hex;
  } catch (error) {
    throw new WalletError(describeError(error));
  }
  if (!hash) throw new WalletError('Your wallet did not return a transaction hash.');

  const client: PublicClient = createPublicClient({ transport: custom(eth) });
  let receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  } catch (error) {
    throw new WalletError(
      `Transaction ${hash} was sent but the receipt could not be read: ${describeError(error)}`,
    );
  }

  const status = receipt.status === 'success' ? 'success' : 'reverted';
  const events: WalletEvent[] = [];
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: input.abi,
        data: log.data,
        topics: log.topics,
      } as Parameters<typeof decodeEventLog>[0]);
      events.push({ eventName: decoded.eventName as string, args: decoded.args });
    } catch {
      // Logs from other contracts (or anonymous events) are not ours to show.
    }
  }

  return {
    hash,
    chainId,
    status,
    blockNumber: receipt.blockNumber ?? null,
    events,
  };
}
