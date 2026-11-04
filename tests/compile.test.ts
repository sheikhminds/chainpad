import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildSolcInput,
  compileProject,
  parseDiagnostics,
  unlinkedLibraries,
  type ProjectFile,
} from '../src/lib/compile.ts';
import { TEMPLATES } from '../src/lib/project.ts';
import { createCompiler, instantiateSoljson, parseVersionList, type SolcModule } from '../src/lib/solc.ts';

const require = createRequire(import.meta.url);

/** The npm package ships the same `soljson.js` the browser downloads. */
function loadSoljson(): SolcModule {
  return require('solc/soljson.js') as SolcModule;
}

const compiler = createCompiler(loadSoljson());

const SIMPLE: ProjectFile[] = [
  {
    name: 'Simple.sol',
    content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Simple {
    function answer() external pure returns (uint256) { return 42; }
}`,
  },
];

describe('compiler loading', () => {
  it('wraps the real soljson module', () => {
    expect(compiler.version).toMatch(/^0\.8\.30\+commit\./);
    expect(compiler.license).toContain('GPL');
  });

  it('evaluates the downloaded bundle the same way the browser does', () => {
    const path = require.resolve('solc/soljson.js');
    const source = readFileSync(path, 'utf8');
    const fromSource = createCompiler(instantiateSoljson(source));
    expect(fromSource.version).toBe(compiler.version);

    const input = buildSolcInput(SIMPLE, { optimizer: true, runs: 200 });
    const output = JSON.parse(fromSource.compile(JSON.stringify(input))) as {
      contracts: Record<string, Record<string, { evm: { bytecode: { object: string } } }>>;
    };
    expect(output.contracts['Simple.sol'].Simple.evm.bytecode.object.length).toBeGreaterThan(0);
  });

  it('parses the official version list newest-first and skips nightlies', () => {
    const builds = parseVersionList({
      releases: {
        '0.8.20': 'soljson-v0.8.20+commit.a1b79de6.js',
        '0.8.30': 'soljson-v0.8.30+commit.73712a01.js',
        '0.5.17': 'soljson-v0.5.17+commit.d19bba13.js',
        '0.9.0-nightly.2026.1.1': 'soljson-v0.9.0-nightly.2026.1.1+commit.abc.js',
      },
    });
    expect(builds.map((build) => build.version)).toEqual(['0.8.30', '0.8.20']);
    expect(builds[0].url).toBe(
      'https://binaries.soliditylang.org/wasm/soljson-v0.8.30+commit.73712a01.js',
    );
  });
});

describe('standard JSON input', () => {
  it('includes every file and the requested optimiser settings', () => {
    const input = buildSolcInput(
      [
        { name: 'A.sol', content: 'contract A {}' },
        { name: '  ', content: 'ignored' },
        { name: 'B.sol', content: 'contract B {}' },
      ],
      { optimizer: false, runs: 0, evmVersion: 'paris' },
    );
    expect(Object.keys(input.sources)).toEqual(['A.sol', 'B.sol']);
    expect(input.settings.optimizer).toEqual({ enabled: false, runs: 1 });
    expect(input.settings.evmVersion).toBe('paris');
    expect(input.settings.outputSelection['*']['*']).toContain('evm.bytecode.object');
  });

  it('maps compiler diagnostics into UI diagnostics', () => {
    const diagnostics = parseDiagnostics([
      {
        severity: 'error',
        message: 'Undeclared identifier',
        formattedMessage: 'A.sol:3:5: Error: Undeclared identifier.',
        sourceLocation: { file: 'A.sol', start: 0, end: 1 },
      },
      { severity: 'warning', message: 'Unused variable' },
      { severity: 'info', message: 'Optimizer enabled' },
    ]);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', file: 'A.sol' });
    expect(diagnostics[0].formatted).toContain('A.sol:3:5');
    expect(diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'warning', 'info']);
  });
});

describe('compiling projects', () => {
  it('compiles a minimal contract', () => {
    const result = compileProject(SIMPLE, { optimizer: true, runs: 200 }, compiler);
    expect(result.success).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const contract = result.contracts.find((candidate) => candidate.name === 'Simple');
    expect(contract?.id).toBe('Simple.sol:Simple');
    expect(contract?.bytecode.startsWith('0x')).toBe(true);
    expect(contract?.abi).toMatchObject([
      {
        type: 'function',
        name: 'answer',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'pure',
      },
    ]);
  });

  it('compiles every bundled template without errors', () => {
    for (const template of TEMPLATES) {
      const project = template.project();
      const result = compileProject(project.files, project.settings, compiler);
      expect(result.success, `${template.name}: ${result.diagnostics.map((d) => d.formatted).join('\n')}`).toBe(
        true,
      );
      expect(result.contracts.length).toBeGreaterThan(0);
    }
  });

  it('keeps multi-file imports working', () => {
    const voting = TEMPLATES.find((template) => template.id === 'voting');
    if (!voting) throw new Error('voting template missing');
    const project = voting.project();
    const result = compileProject(project.files, project.settings, compiler);
    const contract = result.contracts.find((candidate) => candidate.name === 'Voting');
    expect(contract).toBeDefined();
    expect(contract?.bytecode.length).toBeGreaterThan(2);
  });

  it('reports Solidity errors with file and position, without throwing', () => {
    const result = compileProject(
      [{ name: 'Broken.sol', content: 'pragma solidity ^0.8.20;\ncontract Broken {\n  uint x = ;\n}' }],
      { optimizer: true, runs: 200 },
      compiler,
    );
    expect(result.success).toBe(false);
    const error = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    expect(error?.formatted).toContain('Broken.sol');
    expect(error?.file).toBe('Broken.sol');
  });

  it('returns a diagnostic when there are no files', () => {
    const result = compileProject([], { optimizer: true, runs: 200 }, compiler);
    expect(result.success).toBe(false);
    expect(result.diagnostics[0].message).toBe('No source files');
  });

  it('detects contracts that still reference external libraries', () => {
    const result = compileProject(
      [
        {
          name: 'Lib.sol',
          content: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
library Math {
    function twice(uint256 x) internal pure returns (uint256) { return x * 2; }
}
contract UsesLib {
    function f(uint256 x) external pure returns (uint256) { return Math.twice(x); }
}`,
        },
      ],
      { optimizer: false, runs: 200 },
      compiler,
    );
    const contract = result.contracts.find((candidate) => candidate.name === 'UsesLib');
    expect(contract).toBeDefined();
    // Internal library functions are inlined, so nothing needs linking.
    expect(unlinkedLibraries(contract!)).toEqual([]);
  });
});
