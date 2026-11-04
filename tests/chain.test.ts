import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Abi, AbiFunction, Hex } from 'viem';
import { DevChain } from '../src/lib/chain.ts';
import { compileProject, type CompiledContract } from '../src/lib/compile.ts';
import { createCompiler, type SolcModule } from '../src/lib/solc.ts';
import { TEMPLATES } from '../src/lib/project.ts';

const require = createRequire(import.meta.url);
const compiler = createCompiler(require('solc/soljson.js') as SolcModule);

const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];

let counter: CompiledContract;
let token: CompiledContract;

beforeAll(() => {
  const counterProject = TEMPLATES.find((template) => template.id === 'counter')!.project();
  const counterResult = compileProject(counterProject.files, counterProject.settings, compiler);
  counter = counterResult.contracts.find((contract) => contract.name === 'Counter')!;

  const tokenProject = TEMPLATES.find((template) => template.id === 'erc20')!.project();
  const tokenResult = compileProject(tokenProject.files, tokenProject.settings, compiler);
  token = tokenResult.contracts.find((contract) => contract.name === 'Token')!;
});

function abiFunction(abi: Abi, name: string): AbiFunction {
  const fn = abi.find((item) => item.type === 'function' && item.name === name);
  if (!fn || fn.type !== 'function') throw new Error(`Function ${name} missing from the ABI`);
  return fn;
}

function newChain(): Promise<DevChain> {
  return DevChain.create({ privateKeys: KEYS });
}

describe('in-browser devnet', () => {
  it('creates deterministic accounts with a starting balance', async () => {
    const chain = await newChain();
    expect(chain.accounts).toHaveLength(3);
    expect(chain.accounts[0].address.toLowerCase()).toBe(
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    );
    expect(await chain.balanceOf(chain.accounts[1].address)).toBe(1_000n * 10n ** 18n);
    expect(chain.block).toBe(1);
    expect(chain.activity).toEqual([]);
  });

  it('deploys a contract and reads its constructor state', async () => {
    const chain = await newChain();
    const deployed = await chain.deploy({
      abi: counter.abi,
      bytecode: counter.bytecode as Hex,
      args: [10n],
      contractId: counter.id,
      contractName: 'Counter',
    });
    expect(deployed.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(deployed.tx.kind).toBe('deploy');
    expect(deployed.tx.status).toBe('success');
    expect(deployed.tx.gasUsed).toBeGreaterThan(0n);
    expect(chain.activity[0].contractAddress).toBe(deployed.address);

    const count = await chain.read({
      address: deployed.address,
      abi: counter.abi,
      functionName: 'count',
      fn: abiFunction(counter.abi, 'count'),
    });
    expect(count.value).toBe(10n);
    expect(count.raw).toMatch(/^0x[0-9a-f]+$/);
    expect(chain.block).toBe(2);
  });

  it('commits state-changing calls and decodes events', async () => {
    const chain = await newChain();
    const deployed = await chain.deploy({
      abi: counter.abi,
      bytecode: counter.bytecode as Hex,
      args: [0n],
      contractName: 'Counter',
    });

    const tx = await chain.write({
      address: deployed.address,
      abi: counter.abi,
      functionName: 'add',
      fn: abiFunction(counter.abi, 'add'),
      args: [5n],
      contractName: 'Counter',
    });
    expect(tx.status).toBe('success');
    expect(tx.gasUsed).toBeGreaterThan(0n);
    expect(tx.logs).toHaveLength(1);
    expect(tx.logs[0].eventName).toBe('Changed');
    expect(tx.logs[0].args.value).toBe(5n);
    expect(String(tx.logs[0].args.who).toLowerCase()).toBe(
      chain.accounts[0].address.toLowerCase(),
    );

    const after = await chain.read({
      address: deployed.address,
      abi: counter.abi,
      functionName: 'count',
      fn: abiFunction(counter.abi, 'count'),
    });
    expect(after.value).toBe(5n);
    expect(chain.activity.map((entry) => entry.kind)).toEqual(['write', 'deploy']);
  });

  it('sends writes from the selected account', async () => {
    const chain = await newChain();
    const deployed = await chain.deploy({
      abi: counter.abi,
      bytecode: counter.bytecode as Hex,
      args: [0n],
    });
    const tx = await chain.write({
      address: deployed.address,
      abi: counter.abi,
      functionName: 'increment',
      fn: abiFunction(counter.abi, 'increment'),
      account: chain.accounts[2].address,
    });
    expect(tx.from).toBe(chain.accounts[2].address);
    expect(String(tx.logs[0].args.who).toLowerCase()).toBe(
      chain.accounts[2].address.toLowerCase(),
    );
  });

  it('reverts failed writes and surfaces the Solidity reason', async () => {
    const chain = await newChain();
    const deployed = await chain.deploy({
      abi: token.abi,
      bytecode: token.bytecode as Hex,
      args: ['ChainPad', 'CPAD', 100n],
    });

    await expect(
      chain.write({
        address: deployed.address,
        abi: token.abi,
        functionName: 'transfer',
        fn: abiFunction(token.abi, 'transfer'),
        args: [chain.accounts[1].address, 10n ** 24n],
      }),
    ).rejects.toThrow('insufficient balance');

    expect(chain.activity[0].status).toBe('reverted');
    expect(chain.activity[0].error).toContain('insufficient balance');
  });

  it('records a reverted deployment when the constructor rejects its inputs', async () => {
    const chain = await newChain();
    await expect(
      chain.deploy({
        abi: token.abi,
        bytecode: token.bytecode as Hex,
        // The Token constructor needs three arguments; the EVM rejects the
        // call because the calldata is too short to decode.
        args: [],
      }),
    ).rejects.toThrow(/Deployment reverted/);
    expect(chain.activity).toHaveLength(1);
    expect(chain.activity[0].status).toBe('reverted');
  });

  it('reverts reads instead of changing state', async () => {
    const chain = await newChain();
    const deployed = await chain.deploy({
      abi: token.abi,
      bytecode: token.bytecode as Hex,
      args: ['ChainPad', 'CPAD', 100n],
    });
    const before = await chain.read({
      address: deployed.address,
      abi: token.abi,
      functionName: 'totalSupply',
      fn: abiFunction(token.abi, 'totalSupply'),
    });
    expect(before.value).toBe(100n * 10n ** 18n);

    // Reading a write function through `read()` executes it, then reverts it.
    const result = await chain.read({
      address: deployed.address,
      abi: token.abi,
      functionName: 'transfer',
      fn: abiFunction(token.abi, 'transfer'),
      args: [chain.accounts[1].address, 1n],
    });
    expect(result.value).toBe(true);

    const after = await chain.read({
      address: deployed.address,
      abi: token.abi,
      functionName: 'balanceOf',
      fn: abiFunction(token.abi, 'balanceOf'),
      args: [chain.accounts[1].address],
    });
    expect(after.value).toBe(0n);
  });

  it('resets to a clean chain', async () => {
    const chain = await newChain();
    await chain.deploy({ abi: counter.abi, bytecode: counter.bytecode as Hex, args: [1n] });
    expect(chain.activity).toHaveLength(1);
    await chain.reset();
    expect(chain.activity).toEqual([]);
    expect(chain.block).toBe(1);
    expect(await chain.balanceOf(chain.accounts[0].address)).toBe(1_000n * 10n ** 18n);
  });

  it('refuses to deploy contracts without bytecode', async () => {
    const chain = await newChain();
    await expect(chain.deploy({ abi: counter.abi, bytecode: '0x', args: [] })).rejects.toThrow(
      'no deployment bytecode',
    );
  });
});
