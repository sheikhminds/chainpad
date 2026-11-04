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
  encodeDeployData,
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

function provider(): Eip1193Provider {
  if (!hasInjectedWallet()) {
    throw new WalletError(
      'No browser wallet found. Install MetaMask (or another EIP-1193 wallet) to deploy to a real network.',
    );
  }
  return window.ethereum as Eip1193Provider;
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
