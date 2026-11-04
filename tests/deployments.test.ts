// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Abi, Hex } from 'viem';
import {
  loadWalletDeployments,
  parseStoredDeployments,
  removeWalletDeployment,
  saveWalletDeployments,
  WALLET_DEPLOYMENTS_KEY,
  type StoredDeployment,
} from '../src/lib/deployments.ts';

const ABI = [
  { type: 'function', name: 'count', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as Abi;

function deployment(overrides: Partial<StoredDeployment> = {}): StoredDeployment {
  return {
    id: 'd1',
    name: 'Counter',
    address: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Hex,
    abi: ABI,
    contractId: 'Counter.sol:Counter',
    chainId: 11155111,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('stored wallet deployments', () => {
  it('round-trips a deployment through localStorage', () => {
    saveWalletDeployments([deployment()]);
    const loaded = loadWalletDeployments();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].address).toBe(deployment().address);
    expect(loaded[0].chainId).toBe(11155111);
    expect(loaded[0].abi).toEqual(ABI);
  });

  it('returns an empty list when nothing was stored', () => {
    expect(loadWalletDeployments()).toEqual([]);
    expect(parseStoredDeployments(null)).toEqual([]);
    expect(parseStoredDeployments('')).toEqual([]);
  });

  it('never throws on corrupt data', () => {
    localStorage.setItem(WALLET_DEPLOYMENTS_KEY, '{not json');
    expect(loadWalletDeployments()).toEqual([]);
    localStorage.setItem(WALLET_DEPLOYMENTS_KEY, '{"id":"d1"}');
    expect(loadWalletDeployments()).toEqual([]);
    localStorage.setItem(WALLET_DEPLOYMENTS_KEY, 'null');
    expect(loadWalletDeployments()).toEqual([]);
  });

  it('drops entries that could not be called safely', () => {
    const raw = JSON.stringify([
      deployment(),
      { ...deployment({ id: 'd2' }), address: 'not-an-address' },
      { ...deployment({ id: 'd3' }), abi: 'nope' },
      { ...deployment({ id: 'd4' }), chainId: 0 },
      { ...deployment({ id: 'd5' }), id: '' },
    ]);
    const parsed = parseStoredDeployments(raw);
    expect(parsed.map((item) => item.id)).toEqual(['d1']);
  });

  it('keeps duplicate ids out', () => {
    const parsed = parseStoredDeployments(JSON.stringify([deployment(), deployment()]));
    expect(parsed).toHaveLength(1);
  });

  it('caps the list and keeps the newest entries', () => {
    const many = Array.from({ length: 40 }, (_value, index) =>
      deployment({ id: `d${index}`, createdAt: index }),
    );
    saveWalletDeployments(many);
    const loaded = loadWalletDeployments();
    expect(loaded).toHaveLength(25);
    expect(loaded[0].id).toBe('d15');
    expect(loaded.at(-1)!.id).toBe('d39');
  });

  it('clears the key when the list becomes empty', () => {
    saveWalletDeployments([deployment()]);
    expect(localStorage.getItem(WALLET_DEPLOYMENTS_KEY)).not.toBeNull();
    saveWalletDeployments([]);
    expect(localStorage.getItem(WALLET_DEPLOYMENTS_KEY)).toBeNull();
  });

  it('removes one deployment and leaves the rest', () => {
    saveWalletDeployments([deployment(), deployment({ id: 'd2' })]);
    const remaining = removeWalletDeployment('d1');
    expect(remaining.map((item) => item.id)).toEqual(['d2']);
    expect(loadWalletDeployments().map((item) => item.id)).toEqual(['d2']);
  });

  it('survives a storage that refuses to write', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => saveWalletDeployments([deployment()], failing)).not.toThrow();
    expect(() => saveWalletDeployments([], failing)).not.toThrow();
  });
});
