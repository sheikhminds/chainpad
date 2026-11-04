import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileProject, type CompiledContract } from '../src/lib/compile.ts';
import { createCompiler, type SolcModule } from '../src/lib/solc.ts';
import { TEMPLATES } from '../src/lib/project.ts';
import { runTestSuite } from '../src/lib/tests.ts';

const require = createRequire(import.meta.url);
const compiler = createCompiler(require('solc/soljson.js') as SolcModule);

let artifacts: CompiledContract[];
let counterTests = '';

beforeAll(() => {
  artifacts = [];
  for (const template of TEMPLATES) {
    const project = template.project();
    const result = compileProject(project.files, project.settings, compiler);
    artifacts.push(...result.contracts);
    if (template.id === 'counter') counterTests = project.tests;
  }
});

describe('JavaScript test runner', () => {
  it('runs the bundled Counter tests against a fresh chain', async () => {
    const run = await runTestSuite(counterTests, artifacts);
    expect(run.total).toBe(3);
    expect(run.failed).toBe(0);
    expect(run.passed).toBe(3);
    expect(run.results.every((result) => result.ok)).toBe(true);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports assertion failures without aborting later tests', async () => {
    const run = await runTestSuite(
      `test('first fails', async () => {
  expect(1n).toBe(2n)
})
test('second passes', async () => {
  expect(true).toBeTruthy()
})`,
      artifacts,
    );
    expect(run.total).toBe(2);
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    expect(run.results[0].ok).toBe(false);
    expect(run.results[0].error).toContain('Expected 1n to be 2n');
    expect(run.results[1].ok).toBe(true);
  });

  it('supports toRevert with a reason', async () => {
    const run = await runTestSuite(
      `test('overdraft reverts', async () => {
  const token = await deploy('Token', ['ChainPad', 'CPAD', 1_000n])
  await expect(token.write('transfer', [accounts[1].address, 10n ** 24n])).toRevert('insufficient balance')
})
test('toRevert fails when the call succeeds', async () => {
  const token = await deploy('Token', ['ChainPad', 'CPAD', 1_000n])
  await expect(token.write('transfer', [accounts[1].address, 1n])).toRevert()
})`,
      artifacts,
    );
    expect(run.results[0].ok).toBe(true);
    expect(run.results[1].ok).toBe(false);
    expect(run.results[1].error).toContain('Expected the call to revert');
  });

  it('captures console output from the sandbox', async () => {
    const run = await runTestSuite(
      `console.log('hello', 42n)
test('logs', async () => { console.warn('careful') })`,
      artifacts,
    );
    expect(run.logs).toContain('"hello" 42n');
    expect(run.logs).toContain('warn: "careful"');
  });

  it('isolates every run on a new chain', async () => {
    const code = `test('state starts clean', async () => {
  const counter = await deploy('Counter', [0n])
  expect(await counter.read('count')).toBe(0n)
  await counter.write('increment')
  expect(await counter.read('count')).toBe(1n)
})`;
    const first = await runTestSuite(code, artifacts);
    const second = await runTestSuite(code, artifacts);
    expect(first.passed).toBe(1);
    expect(second.passed).toBe(1);
  });

  it('reports a deploy name that does not exist', async () => {
    const run = await runTestSuite(`test('bad name', async () => { await deploy('Nope') })`, artifacts);
    expect(run.failed).toBe(1);
    expect(run.results[0].error).toContain('No compiled contract named "Nope"');
  });

  it('reports syntax errors in the test file', async () => {
    const run = await runTestSuite(`test('broken', async () => {`, artifacts);
    expect(run.failed).toBe(1);
    expect(run.results[0].name).toBe('Test file');
  });

  it('returns an empty run for an empty file', async () => {
    const run = await runTestSuite('   ', artifacts);
    expect(run).toMatchObject({ total: 0, passed: 0, failed: 0, logs: [] });
  });
});
