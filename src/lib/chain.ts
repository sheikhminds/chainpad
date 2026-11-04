import { bytesToHex, createAccount, createAddressFromString, hexToBytes, privateToAddress } from '@ethereumjs/util';
import { createCustomCommon, Mainnet, type Common } from '@ethereumjs/common';
import { createLegacyTx } from '@ethereumjs/tx';
import { createVM, runTx, type VM } from '@ethereumjs/vm';
import { encodeDeployData, type Abi, type Hex } from 'viem';
import { decodeCallResult, decodeLogs, decodeRevertReason, encodeCall, type DecodedLog } from './abi.ts';

/** Chain ID of the in-browser devnet. 31337 is the usual local-chain ID. */
export const CHAIN_ID = 31337;
export const CHAIN_NAME = 'ChainPad Devnet';

const GAS_PRICE = 1_000_000_000n; // 1 gwei
const GAS_LIMIT = 8_000_000n;
const START_BALANCE = 1_000n * 10n ** 18n; // 1000 ETH per dev account
const MAX_ACTIVITY = 200;

export interface DevAccount {
  index: number;
  label: string;
  address: Hex;
  /** Session-only key. Never reuse this outside the in-browser devnet. */
  privateKey: Hex;
}

export interface TxLog {
  hash: Hex;
  kind: 'deploy' | 'write';
  blockNumber: number;
  from: Hex;
  to?: Hex;
  /** Contract function called, or `constructor` for deployments. */
  functionName: string;
  contractId?: string;
  contractName?: string;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  value: bigint;
  timestamp: number;
  logs: DecodedLog[];
  contractAddress?: Hex;
  error?: string;
}

export interface DeployInput {
  abi: Abi;
  bytecode: Hex;
  args?: unknown[];
  value?: bigint;
  contractId?: string;
  contractName?: string;
  account?: string;
}

export interface DeployResult {
  address: Hex;
  tx: TxLog;
}

export interface CallResult {
  value: unknown;
  raw: Hex;
}

export interface SendInput {
  address: Hex;
  abi: Abi;
  functionName: string;
  /** The exact ABI fragment, so overloaded functions stay unambiguous. */
  fn: Parameters<typeof encodeCall>[0];
  args?: unknown[];
  value?: bigint;
  contractId?: string;
  contractName?: string;
  account?: string;
}

export class ChainError extends Error {
  constructor(
    message: string,
    readonly revertData?: Hex,
  ) {
    super(message);
    this.name = 'ChainError';
  }
}

function randomPrivateKey(): Hex {
  const bytes = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(bytes);
    const candidate = bytesToHex(bytes);
    if (BigInt(candidate) > 0n) return candidate;
  }
}

function addressFromKey(privateKey: Hex): Hex {
  return bytesToHex(privateToAddress(hexToBytes(privateKey)));
}

interface RawLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
}

/**
 * A tiny EVM devnet that lives in the current tab.
 *
 * State is in memory only: reloading the page starts a clean chain. That is a
 * feature for a learning tool, and it is stated in the UI so nobody expects
 * deployed state to survive a refresh.
 */
export class DevChain {
  private vm: VM;
  private common: Common;
  private _accounts: DevAccount[] = [];
  private _activity: TxLog[] = [];
  private blockNumber = 1;
  private constructor(common: Common, vm: VM) {
    this.common = common;
    this.vm = vm;
  }

  static async create(options?: { privateKeys?: Hex[] }): Promise<DevChain> {
    const common = createCustomCommon({ name: CHAIN_NAME, chainId: CHAIN_ID }, Mainnet);
    const vm = await createVM({ common });
    const chain = new DevChain(common, vm);

    const keys = options?.privateKeys;
    const accounts: DevAccount[] = [];
    const count = keys && keys.length > 0 ? keys.length : 3;
    for (let index = 0; index < count; index += 1) {
      const privateKey = keys?.[index] ?? randomPrivateKey();
      accounts.push({
        index,
        label: `Account ${index + 1}`,
        address: addressFromKey(privateKey),
        privateKey,
      });
    }
    chain._accounts = accounts;
    await chain.reset();
    return chain;
  }

  get accounts(): DevAccount[] {
    return this._accounts;
  }

  get activity(): TxLog[] {
    return this._activity;
  }

  get block(): number {
    return this.blockNumber;
  }

  /** Start from a clean state with the same accounts and fresh balances. */
  async reset(): Promise<void> {
    this.vm = await createVM({ common: this.common });
    this._activity = [];
    this.blockNumber = 1;
    for (const account of this._accounts) {
      await this.vm.stateManager.putAccount(
        createAddressFromString(account.address),
        createAccount({ balance: START_BALANCE }),
      );
    }
  }

  async balanceOf(address: string): Promise<bigint> {
    const account = await this.vm.stateManager.getAccount(createAddressFromString(address));
    return account?.balance ?? 0n;
  }

  private accountFor(address?: string): DevAccount {
    if (!address) return this._accounts[0];
    const match = this._accounts.find(
      (account) => account.address.toLowerCase() === address.toLowerCase(),
    );
    return match ?? this._accounts[0];
  }

  private async runTransaction(options: {
    account: DevAccount;
    data: Hex;
    to?: Hex;
    value?: bigint;
    commit: boolean;
    skipNonce?: boolean;
  }): Promise<{
    result: Awaited<ReturnType<typeof runTx>>;
    hash: Hex;
    from: Hex;
  }> {
    const from = options.account.address;
    const sender = createAddressFromString(from);
    const state = await this.vm.stateManager.getAccount(sender);
    const nonce = state?.nonce ?? 0n;
    const tx = createLegacyTx(
      {
        nonce,
        gasPrice: GAS_PRICE,
        gasLimit: GAS_LIMIT,
        to: options.to ? createAddressFromString(options.to) : undefined,
        value: options.value ?? 0n,
        data: hexToBytes(options.data),
      },
      { common: this.common },
    ).sign(hexToBytes(options.account.privateKey));

    await this.vm.stateManager.checkpoint();
    try {
      const result = await runTx(this.vm, {
        tx,
        skipNonce: options.skipNonce ?? false,
        skipBlockGasLimitValidation: true,
      });
      if (result.execResult.exceptionError) {
        await this.vm.stateManager.revert();
      } else if (options.commit) {
        await this.vm.stateManager.commit();
      } else {
        await this.vm.stateManager.revert();
      }
      return { result, hash: bytesToHex(tx.hash()), from };
    } catch (error) {
      await this.vm.stateManager.revert();
      const message = error instanceof Error ? error.message : String(error);
      throw new ChainError(`Transaction failed: ${message}`);
    }
  }

  private record(
    tx: Omit<TxLog, 'blockNumber' | 'timestamp'> & { blockNumber?: number },
  ): TxLog {
    const entry: TxLog = {
      ...tx,
      blockNumber: this.blockNumber,
      timestamp: Date.now(),
    };
    this._activity = [entry, ...this._activity].slice(0, MAX_ACTIVITY);
    return entry;
  }

  private async deployInternal(input: DeployInput, account: DevAccount): Promise<DeployResult> {
    let data: Hex;
    try {
      data = encodeDeployData({
        abi: input.abi,
        bytecode: input.bytecode,
        args: input.args ?? [],
      } as Parameters<typeof encodeDeployData>[0]);
    } catch (error) {
      throw new ChainError(
        `Constructor arguments are not valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const { result, hash } = await this.runTransaction({
      account,
      data,
      value: input.value,
      commit: true,
    });

    const error = result.execResult.exceptionError;
    if (error) {
      const reason = decodeRevertReason(bytesToHex(result.execResult.returnValue ?? new Uint8Array()));
      const message = reason ?? `Deployment reverted (${error.error})`;
      this.record({
        hash,
        kind: 'deploy',
        from: account.address,
        functionName: 'constructor',
        contractId: input.contractId,
        contractName: input.contractName,
        status: 'reverted',
        gasUsed: result.totalGasSpent,
        value: input.value ?? 0n,
        logs: [],
        error: message,
      });
      this.blockNumber += 1;
      throw new ChainError(message);
    }

    if (!result.createdAddress) {
      throw new ChainError('Deployment produced no contract address');
    }
    const address = bytesToHex(result.createdAddress.toBytes()) as Hex;

    const logs = this.rawLogs(result.receipt.logs);
    const tx = this.record({
      hash,
      kind: 'deploy',
      from: account.address,
      to: address,
      functionName: 'constructor',
      contractId: input.contractId,
      contractName: input.contractName,
      status: 'success',
      gasUsed: result.totalGasSpent,
      value: input.value ?? 0n,
      logs: decodeLogs(input.abi, logs),
      contractAddress: address,
    });
    this.blockNumber += 1;
    return { address, tx };
  }

  private rawLogs(logs: ReadonlyArray<readonly [Uint8Array, Uint8Array[], Uint8Array]>): RawLog[] {
    return logs.map((log) => ({
      address: bytesToHex(log[0]),
      topics: log[1].map((topic) => bytesToHex(topic) as Hex),
      data: bytesToHex(log[2]) as Hex,
    }));
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    if (!input.bytecode || input.bytecode === '0x') {
      throw new ChainError('This contract has no deployment bytecode (it is an interface or abstract).');
    }
    const account = this.accountFor(input.account);
    return this.deployInternal(input, account);
  }

  /** Execute a view/pure function without keeping any state change. */
  async read(input: Omit<SendInput, 'value'>): Promise<CallResult> {
    const account = this.accountFor(input.account);
    let data: Hex;
    try {
      data = encodeCall(input.fn, input.args ?? []);
    } catch (error) {
      throw new ChainError(
        `Arguments are not valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const { result } = await this.runTransaction({
      account,
      to: input.address,
      data,
      commit: false,
      skipNonce: true,
    });
    const error = result.execResult.exceptionError;
    const raw = bytesToHex(result.execResult.returnValue ?? new Uint8Array()) as Hex;
    if (error) {
      const reason = decodeRevertReason(raw);
      throw new ChainError(reason ?? `Call reverted (${error.error})`, raw);
    }
    try {
      return { value: decodeCallResult(input.fn, raw), raw };
    } catch (decodeError) {
      throw new ChainError(
        `Could not decode the return value: ${
          decodeError instanceof Error ? decodeError.message : String(decodeError)
        }`,
        raw,
      );
    }
  }

  /** Execute a state-changing function and keep the resulting state. */
  async write(input: SendInput): Promise<TxLog> {
    const account = this.accountFor(input.account);
    let data: Hex;
    try {
      data = encodeCall(input.fn, input.args ?? []);
    } catch (error) {
      throw new ChainError(
        `Arguments are not valid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const { result, hash } = await this.runTransaction({
      account,
      to: input.address,
      data,
      value: input.value,
      commit: true,
    });
    const error = result.execResult.exceptionError;
    if (error) {
      const reason = decodeRevertReason(
        bytesToHex(result.execResult.returnValue ?? new Uint8Array()),
      );
      const message = reason ?? `Transaction reverted (${error.error})`;
      this.record({
        hash,
        kind: 'write',
        from: account.address,
        to: input.address,
        functionName: input.functionName,
        contractId: input.contractId,
        contractName: input.contractName,
        status: 'reverted',
        gasUsed: result.totalGasSpent,
        value: input.value ?? 0n,
        logs: [],
        error: message,
      });
      this.blockNumber += 1;
      throw new ChainError(message);
    }

    const tx = this.record({
      hash,
      kind: 'write',
      from: account.address,
      to: input.address,
      functionName: input.functionName,
      contractId: input.contractId,
      contractName: input.contractName,
      status: 'success',
      gasUsed: result.totalGasSpent,
      value: input.value ?? 0n,
      logs: decodeLogs(input.abi, this.rawLogs(result.receipt.logs)),
    });
    this.blockNumber += 1;
    return tx;
  }
}
