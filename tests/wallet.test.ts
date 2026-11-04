// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { Abi, Hex } from 'viem';
import { deployWithWallet, hasInjectedWallet, WalletError, type Eip1193Provider } from '../src/lib/wallet.ts';

const ABI: Abi = [
  { type: 'constructor', inputs: [{ name: 'start', type: 'uint256' }], stateMutability: 'nonpayable' },
];
const BYTECODE = '0x6080604052' as Hex;
const SENDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const HASH = `0x${'ab'.repeat(32)}` as Hex;

interface Calls {
  method: string;
  params?: unknown;
}

function makeProvider(overrides: Partial<Record<string, unknown>> = {}): {
  provider: Eip1193Provider;
  calls: Calls[];
} {
  const calls: Calls[] = [];
  const provider: Eip1193Provider = {
    request: async ({ method, params }) => {
      calls.push({ method, params });
      if (method in overrides) {
        const value = overrides[method];
        if (value instanceof Error) throw value;
        return typeof value === 'function' ? (value as () => unknown)() : value;
      }
      switch (method) {
        case 'eth_requestAccounts':
          return [SENDER];
        case 'eth_chainId':
          return '0x1';
        case 'eth_sendTransaction':
          return HASH;
        case 'eth_blockNumber':
          return '0x10';
        case 'eth_getTransactionReceipt':
          return {
            transactionHash: HASH,
            transactionIndex: '0x0',
            blockHash: `0x${'11'.repeat(32)}`,
            blockNumber: '0x10',
            from: SENDER,
            to: null,
            cumulativeGasUsed: '0x5208',
            gasUsed: '0x5208',
            contractAddress: CONTRACT,
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            type: '0x0',
            effectiveGasPrice: '0x3b9aca00',
          };
        default:
          throw new Error(`Unexpected wallet method ${method}`);
      }
    },
  };
  return { provider, calls };
}

afterEach(() => {
  delete (window as { ethereum?: Eip1193Provider }).ethereum;
});

describe('browser wallet deployment', () => {
  it('detects an injected provider', () => {
    expect(hasInjectedWallet()).toBe(false);
    window.ethereum = makeProvider().provider;
    expect(hasInjectedWallet()).toBe(true);
  });

  it('asks the wallet to deploy and waits for the receipt', async () => {
    const { provider, calls } = makeProvider();
    window.ethereum = provider;

    const result = await deployWithWallet({
      abi: ABI,
      bytecode: BYTECODE,
      args: [7n],
      value: 0n,
    });

    expect(result).toEqual({ address: CONTRACT, hash: HASH, chainId: 1 });
    const sent = calls.find((call) => call.method === 'eth_sendTransaction');
    expect(sent).toBeDefined();
    const [transaction] = sent!.params as Array<Record<string, string>>;
    expect(transaction.from).toBe(SENDER);
    expect(transaction.data.startsWith(BYTECODE)).toBe(true);
    expect(transaction.data).toContain('7'.padStart(64, '0'));
    expect(transaction.value).toBe('0x0');
    expect(calls.some((call) => call.method === 'eth_getTransactionReceipt')).toBe(true);
  });

  it('explains a rejected transaction', async () => {
    const { provider } = makeProvider({
      eth_sendTransaction: Object.assign(new Error('User denied transaction signature'), {
        code: 4001,
      }),
    });
    window.ethereum = provider;
    await expect(deployWithWallet({ abi: ABI, bytecode: BYTECODE, args: [1n] })).rejects.toThrow(
      'You rejected the transaction in your wallet.',
    );
  });

  it('fails clearly when no wallet is installed', async () => {
    await expect(deployWithWallet({ abi: ABI, bytecode: BYTECODE })).rejects.toBeInstanceOf(
      WalletError,
    );
  });

  it('reports a reverted deployment transaction', async () => {
    const { provider } = makeProvider({
      eth_getTransactionReceipt: {
        transactionHash: HASH,
        transactionIndex: '0x0',
        blockHash: `0x${'11'.repeat(32)}`,
        blockNumber: '0x10',
        from: SENDER,
        to: null,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x0',
        type: '0x0',
        effectiveGasPrice: '0x3b9aca00',
      },
    });
    window.ethereum = provider;
    await expect(deployWithWallet({ abi: ABI, bytecode: BYTECODE, args: [1n] })).rejects.toThrow(
      'reverted',
    );
  });
});
