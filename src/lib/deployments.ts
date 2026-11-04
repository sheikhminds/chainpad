/**
 * Wallet deployments survive a reload.
 *
 * Devnet contracts die with the tab, but a contract on a real network does not:
 * it would be strange to lose the generated forms just because the page was
 * refreshed. Only wallet deployments are stored, and only the pieces needed to
 * rebuild the UI — never keys, never signatures.
 */

import type { Abi, Hex } from 'viem';

export const WALLET_DEPLOYMENTS_KEY = 'chainpad:wallet-deployments:v1';
const MAX_STORED = 25;

export interface StoredDeployment {
  id: string;
  name: string;
  address: Hex;
  abi: Abi;
  contractId: string;
  chainId: number;
  createdAt: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isDeployment(value: unknown): value is StoredDeployment {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.name === 'string' &&
    typeof record.address === 'string' &&
    ADDRESS.test(record.address) &&
    Array.isArray(record.abi) &&
    typeof record.contractId === 'string' &&
    typeof record.chainId === 'number' &&
    Number.isInteger(record.chainId) &&
    record.chainId > 0 &&
    typeof record.createdAt === 'number'
  );
}

/** Parse whatever is in storage; bad entries are dropped, never thrown. */
export function parseStoredDeployments(raw: string | null): StoredDeployment[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const result: StoredDeployment[] = [];
  for (const entry of parsed) {
    if (!isDeployment(entry)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result.slice(-MAX_STORED);
}

export function loadWalletDeployments(storage: Pick<Storage, 'getItem'> = localStorage): StoredDeployment[] {
  try {
    return parseStoredDeployments(storage.getItem(WALLET_DEPLOYMENTS_KEY));
  } catch {
    return [];
  }
}

/** Store the list, keeping the newest `MAX_STORED` entries. */
export function saveWalletDeployments(
  deployments: readonly StoredDeployment[],
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage,
): void {
  const trimmed = deployments.slice(-MAX_STORED);
  try {
    if (trimmed.length === 0) {
      storage.removeItem(WALLET_DEPLOYMENTS_KEY);
      return;
    }
    storage.setItem(WALLET_DEPLOYMENTS_KEY, JSON.stringify(trimmed));
  } catch {
    // A full or blocked localStorage must not break the deployment flow.
  }
}

/** Forget a single deployment by id (used when the UI removes one). */
export function removeWalletDeployment(id: string, storage: Pick<Storage, 'getItem'> & Pick<Storage, 'setItem' | 'removeItem'> = localStorage): StoredDeployment[] {
  const remaining = loadWalletDeployments(storage).filter((deployment) => deployment.id !== id);
  saveWalletDeployments(remaining, storage);
  return remaining;
}
