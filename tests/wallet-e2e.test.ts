/*
 * Wallet calls against a real EVM.
 *
 * The other wallet test mocks the JSON-RPC replies. This one does not: it puts
 * an EIP-1193 provider in front of a real `@ethereumjs/vm` instance and runs
 * deploy -> write -> read through `deployWithWallet` / `writeWithWallet` /
 * `readWithWallet`, so viem encoding, transaction sending, receipt waiting and
 * event decoding are all exercised for real.
 */
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { createCustomCommon, Mainnet } from '@ethereumjs/common';
import { createLegacyTx } from '@ethereumjs/tx';
import {
  bytesToHex,
  createAccount,
  createAddressFromString,
  hexToBytes,
  privateToAddress,
  randomBytes,
} from '@ethereumjs/util';
import { createVM, runTx, type VM } from '@ethereumjs/vm';
import type { Abi, Hex } from 'viem';
import { compileProject } from '../src/lib/compile.ts';
import { TEMPLATES } from '../src/lib/project.ts';
import { createCompiler, type SolcModule } from '../src/lib/solc.ts';
import {
  deployWithWallet,
  explorerTxUrl,
  readWithWallet,
  setFallbackProvider,
  walletProviderKind,
  writeWithWallet,
  type Eip1193Provider,
} from '../src/lib/wallet.ts';

const require = createRequire(import.meta.url);
const SOLC = createCompiler(require('solc/soljson.js') as SolcModule);

const CHAIN_ID = 31337;
const GAS_PRICE = 1_000_000_000n;
const GAS_LIMIT = 8_000_000n;

function quantity(value: bigint | number): Hex {
  return `0x${BigInt(value).toString(16)}` as Hex;
}

interface RpcReceipt {
  transactionHash: Hex;
  transactionIndex: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  from: Hex;
  to: Hex | null;
  cumulativeGasUsed: Hex;
  gasUsed: Hex;
  contractAddress: Hex | null;
  logs: Array<Record<string, unknown>>;
  logsBloom: Hex;
  status: Hex;
  type: Hex;
  effectiveGasPrice: Hex;
}

/**
 * A minimal EIP-1193 provider backed by a real VM, with one funded account.
 * Every method a wallet would answer is answered by actually executing.
 */
async function createEvmProvider(): Promise<{
  provider: Eip1193Provider;
  vm: VM;
  address: Hex;
}> {
  // A throwaway key per test run: nothing secret, nothing reused.
  let keyBytes = randomBytes(32);
  while (keyBytes.every((byte) => byte === 0)) keyBytes = randomBytes(32);
  const privateKey = bytesToHex(keyBytes) as Hex;
  const sender = bytesToHex(privateToAddress(hexToBytes(privateKey))) as Hex;

  const common = createCustomCommon({ name: 'Wallet test chain', chainId: CHAIN_ID }, Mainnet);
  const vm = await createVM({ common });
  await vm.stateManager.putAccount(
    createAddressFromString(sender),
    createAccount({ balance: 10n ** 20n }),
  );

  const receipts = new Map<string, RpcReceipt>();
  let blockNumber = 0;
  const blockHash = `0x${'11'.repeat(32)}` as Hex;

  async function send(transaction: {
    from?: string;
    to?: string | null;
    data?: string;
    value?: string;
  }): Promise<Hex> {
    const from = createAddressFromString(sender);
    const account = await vm.stateManager.getAccount(from);
    const tx = createLegacyTx(
      {
        nonce: account?.nonce ?? 0n,
        gasPrice: GAS_PRICE,
        gasLimit: GAS_LIMIT,
        to: transaction.to ? createAddressFromString(transaction.to) : undefined,
        value: transaction.value ? BigInt(transaction.value) : 0n,
        data: hexToBytes((transaction.data ?? '0x') as Hex),
      },
      { common },
    ).sign(hexToBytes(privateKey));

    const result = await runTx(vm, { tx, skipBlockGasLimitValidation: true });
    const hash = bytesToHex(tx.hash()) as Hex;
    blockNumber += 1;
    receipts.set(hash, {
      transactionHash: hash,
      transactionIndex: quantity(0),
      blockHash,
      blockNumber: quantity(blockNumber),
      from: sender,
      to: transaction.to ? (transaction.to as Hex) : null,
      cumulativeGasUsed: quantity(result.totalGasSpent),
      gasUsed: quantity(result.totalGasSpent),
      contractAddress: result.createdAddress
        ? (bytesToHex(result.createdAddress.toBytes()) as Hex)
        : null,
      logs: result.receipt.logs.map((log, index) => ({
        address: bytesToHex(log[0]),
        topics: log[1].map((topic) => bytesToHex(topic)),
        data: bytesToHex(log[2]),
        blockNumber: quantity(blockNumber),
        transactionHash: hash,
        transactionIndex: quantity(0),
        blockHash,
        logIndex: quantity(index),
        removed: false,
      })),
      logsBloom: `0x${'00'.repeat(256)}` as Hex,
      status: result.execResult.exceptionError ? quantity(0) : quantity(1),
      type: quantity(0),
      effectiveGasPrice: quantity(GAS_PRICE),
    });
    return hash;
  }

  async function call(request: { to?: string; data?: string; value?: string }): Promise<Hex> {
    const from = createAddressFromString(sender);
    const account = await vm.stateManager.getAccount(from);
    const tx = createLegacyTx(
      {
        nonce: account?.nonce ?? 0n,
        gasPrice: GAS_PRICE,
        gasLimit: GAS_LIMIT,
        to: createAddressFromString(request.to as string),
        value: request.value ? BigInt(request.value) : 0n,
        data: hexToBytes((request.data ?? '0x') as Hex),
      },
      { common },
    ).sign(hexToBytes(privateKey));

    await vm.stateManager.checkpoint();
    try {
      const result = await runTx(vm, {
        tx,
        skipNonce: true,
        skipBlockGasLimitValidation: true,
      });
      const returned = bytesToHex(result.execResult.returnValue ?? new Uint8Array()) as Hex;
      if (result.execResult.exceptionError) {
        // Mirror what a real node does: `eth_call` fails instead of returning
        // revert data as if it were a result.
        throw Object.assign(new Error('execution reverted'), {
          code: 3,
          data: returned,
        });
      }
      return returned;
    } finally {
      await vm.stateManager.revert();
    }
  }

  const provider: Eip1193Provider = {
    request: async ({ method, params }) => {
      const args = (params ?? []) as unknown[];
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [sender];
        case 'eth_chainId':
          return quantity(CHAIN_ID);
        case 'eth_blockNumber':
          return quantity(blockNumber);
        case 'eth_sendTransaction':
          return send(args[0] as { to?: string; data?: string; value?: string });
        case 'eth_call':
          return call(args[0] as { to?: string; data?: string });
        case 'eth_getTransactionReceipt':
          return receipts.get(args[0] as string) ?? null;
        default:
          throw new Error(`The test provider does not implement ${method}`);
      }
    },
  };

  return { provider, vm, address: sender };
}

afterEach(() => {
  setFallbackProvider(null);
  delete (window as { ethereum?: Eip1193Provider }).ethereum;
});

describe('wallet calls on a real chain', () => {
  it('deploys, writes and reads through WalletConnect-style provider calls', async () => {
    const { provider } = await createEvmProvider();

    // No injected wallet: this is the phone case, so the fallback provider is
    // the one that must be used.
    expect(walletProviderKind()).toBeNull();
    setFallbackProvider(provider);
    expect(walletProviderKind()).toBe('walletconnect');

    const template = TEMPLATES.find((item) => item.id === 'counter')!;
    const compiled = compileProject(template.project().files, { optimizer: true, runs: 200 }, SOLC);
    expect(compiled.diagnostics.filter((error) => error.severity === 'error')).toHaveLength(0);
    const contract = compiled.contracts[0];
    const abi = contract.abi as Abi;

    const deployed = await deployWithWallet({
      abi,
      bytecode: contract.bytecode as Hex,
      args: [5n],
    });
    expect(deployed.chainId).toBe(CHAIN_ID);
    expect(deployed.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const written = await writeWithWallet({
      address: deployed.address,
      abi,
      functionName: 'increment',
      args: [],
      chainId: CHAIN_ID,
    });
    expect(written.status).toBe('success');
    expect(written.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(written.events.map((event) => event.eventName)).toContain('Changed');
    expect(explorerTxUrl(written.chainId, written.hash)).toBeNull();

    const read = await readWithWallet({
      address: deployed.address,
      abi,
      functionName: 'add',
      args: [10n],
      chainId: CHAIN_ID,
    });
    // `add` is a write on the ABI but eth_call simulates it without committing,
    // which is exactly the read path ChainPad uses.
    expect(read.value).toBeUndefined();

    const count = await readWithWallet({
      address: deployed.address,
      abi,
      functionName: 'count',
      args: [],
      chainId: CHAIN_ID,
    });
    expect(count.value).toBe(6n);
  }, 120_000);

  it('refuses to call a contract from the wrong network', async () => {
    const { provider, address } = await createEvmProvider();
    setFallbackProvider(provider);

    await expect(
      readWithWallet({
        address,
        abi: [
          { type: 'function', name: 'count', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
        ] as Abi,
        functionName: 'count',
        chainId: 1,
      }),
    ).rejects.toThrow('Switch networks in your wallet');
  });

  it('reports a revert instead of returning a fake result', async () => {
    const { provider } = await createEvmProvider();
    setFallbackProvider(provider);

    const template = TEMPLATES.find((item) => item.id === 'counter')!;
    const compiled = compileProject(template.project().files, { optimizer: true, runs: 200 }, SOLC);
    const contract = compiled.contracts[0];

    const deployed = await deployWithWallet({
      abi: contract.abi as Abi,
      bytecode: contract.bytecode as Hex,
      args: [6n],
    });

    // 6 + (2^256 - 1) overflows, so Solidity reverts with a Panic.
    await expect(
      readWithWallet({
        address: deployed.address,
        abi: contract.abi as Abi,
        functionName: 'add',
        args: [2n ** 256n - 1n],
        chainId: CHAIN_ID,
      }),
    ).rejects.toThrow(/add\(\) reverted/);
  }, 120_000);
});
