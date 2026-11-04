import type { Abi, Hex } from 'viem';
import { listFunctions, type AbiFunctionInfo } from './abi.ts';
import { DevChain, type TxLog } from './chain.ts';
import type { CompiledContract } from './compile.ts';

export interface TestCaseResult {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface TestRun {
  total: number;
  passed: number;
  failed: number;
  results: TestCaseResult[];
  logs: string[];
  durationMs: number;
}

export interface ContractInstance {
  name: string;
  address: Hex;
  abi: Abi;
  read(functionName: string, args?: unknown[], options?: { from?: number }): Promise<unknown>;
  write(functionName: string, args?: unknown[], options?: { from?: number }): Promise<TxLog>;
  balance(): Promise<bigint>;
}

export interface TestAccount {
  index: number;
  label: string;
  address: Hex;
}

const TIMEOUT_MS = 15_000;

function deepEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return String(a) === String(b);
  }
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function preview(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(preview).join(', ')}]`;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint' ? `${item}n` : item,
      );
    } catch {
      return String(value);
    }
  }
  return String(value);
}

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(expected: unknown): void;
  toBeGreaterThan(expected: bigint | number): void;
  /** Resolves when the promise rejects; fails when it succeeds. */
  toRevert(reason?: string): Promise<void>;
}

function createExpect(actual: unknown): Matchers {
  return {
    toBe(expected) {
      if (!deepEqual(actual, expected)) {
        throw new Error(`Expected ${preview(actual)} to be ${preview(expected)}`);
      }
    },
    toEqual(expected) {
      if (!deepEqual(actual, expected)) {
        throw new Error(`Expected ${preview(actual)} to equal ${preview(expected)}`);
      }
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected ${preview(actual)} to be truthy`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected ${preview(actual)} to be falsy`);
    },
    toContain(expected) {
      const haystack = Array.isArray(actual) ? actual : String(actual);
      if (Array.isArray(haystack)) {
        if (!haystack.some((item) => deepEqual(item, expected))) {
          throw new Error(`Expected ${preview(actual)} to contain ${preview(expected)}`);
        }
        return;
      }
      if (!haystack.includes(String(expected))) {
        throw new Error(`Expected ${preview(actual)} to contain ${preview(expected)}`);
      }
    },
    toBeGreaterThan(expected) {
      const left = typeof actual === 'bigint' ? actual : Number(actual);
      const right = typeof expected === 'bigint' ? expected : BigInt(expected);
      if (!(left > right)) {
        throw new Error(`Expected ${preview(actual)} to be greater than ${preview(expected)}`);
      }
    },
    async toRevert(reason) {
      try {
        await actual;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (reason && !message.toLowerCase().includes(reason.toLowerCase())) {
          throw new Error(`Reverted with "${message}", expected a reason containing "${reason}"`);
        }
        return;
      }
      throw new Error('Expected the call to revert, but it succeeded');
    },
  };
}

function resolveFunction(abi: Abi, requested: string): AbiFunctionInfo {
  const functions = listFunctions(abi);
  const exact = functions.find((fn) => fn.key === requested || fn.signature === requested);
  if (exact) return exact;
  const byName = functions.filter((fn) => fn.name === requested);
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) throw new Error(`Function ${requested} is not in the ABI`);
  throw new Error(
    `${requested} is overloaded, use a signature: ${byName.map((fn) => fn.signature).join(', ')}`,
  );
}

function makeInstance(
  chain: DevChain,
  contract: CompiledContract,
  address: Hex,
): ContractInstance {
  const account = (index?: number) => {
    if (index === undefined) return undefined;
    return chain.accounts[index]?.address;
  };

  return {
    name: contract.name,
    address,
    abi: contract.abi,
    async read(functionName, args = [], options = {}) {
      const fn = resolveFunction(contract.abi, functionName);
      if (fn.kind !== 'read') {
        throw new Error(`${functionName} changes state, use write() instead`);
      }
      const result = await chain.read({
        address,
        abi: contract.abi,
        functionName: fn.name,
        fn: fn.fn,
        args,
        account: account(options.from),
      });
      return result.value;
    },
    async write(functionName, args = [], options = {}) {
      const fn = resolveFunction(contract.abi, functionName);
      if (fn.kind !== 'write') {
        throw new Error(`${functionName} does not change state, use read() instead`);
      }
      return chain.write({
        address,
        abi: contract.abi,
        functionName: fn.name,
        fn: fn.fn,
        args,
        account: account(options.from),
      });
    },
    balance() {
      return chain.balanceOf(address);
    },
  };
}

/**
 * Execute a user test file against a fresh devnet.
 *
 * The sandbox is intentionally small: a fresh chain, the compiled contracts,
 * and a handful of helpers. It is not a security boundary (the code runs in
 * the page, like the browser console) but it is deterministic and isolated
 * from the deployments in the main UI.
 */
export async function runTestSuite(
  code: string,
  contracts: CompiledContract[],
): Promise<TestRun> {
  const started = performance.now();
  const chain = await DevChain.create();
  const logs: string[] = [];

  const cases: Array<{ name: string; run: () => Promise<void> }> = [];
  const sandboxConsole = {
    log: (...args: unknown[]) => logs.push(args.map(preview).join(' ')),
    info: (...args: unknown[]) => logs.push(args.map(preview).join(' ')),
    warn: (...args: unknown[]) => logs.push(`warn: ${args.map(preview).join(' ')}`),
    error: (...args: unknown[]) => logs.push(`error: ${args.map(preview).join(' ')}`),
  };

  const accounts: TestAccount[] = chain.accounts.map((account) => ({
    index: account.index,
    label: account.label,
    address: account.address,
  }));

  const test = (name: string, run: () => Promise<void> | void) => {
    cases.push({ name: String(name), run: async () => run() });
  };

  const deploy = async (
    contractName: string,
    args: unknown[] = [],
    options: { from?: number } = {},
  ): Promise<ContractInstance> => {
    const contract = contracts.find(
      (candidate) => candidate.name === contractName && candidate.bytecode !== '0x',
    );
    if (!contract) {
      throw new Error(
        `No compiled contract named "${contractName}". Compile the project first, and check the contract has bytecode.`,
      );
    }
    const result = await chain.deploy({
      abi: contract.abi,
      bytecode: contract.bytecode as Hex,
      args,
      contractId: contract.id,
      contractName: contract.name,
      account: options.from === undefined ? undefined : chain.accounts[options.from]?.address,
    });
    return makeInstance(chain, contract, result.address);
  };

  if (!code.trim()) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      results: [],
      logs: [],
      durationMs: 0,
    };
  }

  const AsyncFunction = Object.getPrototypeOf(async function noop() {
    /* prototype access */
  }).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<unknown>;

  let setupError: string | undefined;
  try {
    const run = new AsyncFunction('test', 'expect', 'deploy', 'accounts', 'console', 'chain', code);
    await run(test, createExpect, deploy, accounts, sandboxConsole, chain);
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  }

  const results: TestCaseResult[] = [];
  if (setupError) {
    results.push({
      name: 'Test file',
      ok: false,
      error: setupError,
      durationMs: 0,
    });
  }

  for (const testCase of cases) {
    const caseStarted = performance.now();
    try {
      await Promise.race([
        testCase.run(),
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
        }),
      ]);
      results.push({
        name: testCase.name,
        ok: true,
        durationMs: Math.round(performance.now() - caseStarted),
      });
    } catch (error) {
      results.push({
        name: testCase.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - caseStarted),
      });
    }
  }

  const passed = results.filter((result) => result.ok).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    logs,
    durationMs: Math.round(performance.now() - started),
  };
}
