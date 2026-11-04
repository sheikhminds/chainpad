import type { Abi } from 'viem';
import type { Compiler } from './solc.ts';

export interface ProjectFile {
  name: string;
  content: string;
}

export interface CompileSettings {
  optimizer: boolean;
  runs: number;
  evmVersion?: string;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  formatted: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface CompiledContract {
  /** Stable key: `file:Name`. */
  id: string;
  file: string;
  name: string;
  abi: Abi;
  /** Deployment bytecode including 0x prefix, or '' for interfaces/abstract contracts. */
  bytecode: string;
  deployedBytecode: string;
  linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>;
}

export interface CompileResult {
  compilerVersion: string;
  contracts: CompiledContract[];
  diagnostics: Diagnostic[];
  /** True when there are no error-level diagnostics. */
  success: boolean;
  /** Wall-clock compile time in milliseconds. */
  durationMs: number;
}

interface SolcError {
  severity?: string;
  message?: string;
  formattedMessage?: string;
  sourceLocation?: { file?: string; start?: number; end?: number };
}

interface SolcOutput {
  errors?: SolcError[];
  contracts?: Record<
    string,
    Record<
      string,
      {
        abi?: Abi;
        evm?: {
          bytecode?: {
            object?: string;
            linkReferences?: Record<string, Record<string, Array<{ start: number; length: number }>>>;
          };
          deployedBytecode?: { object?: string };
        };
      }
    >
  >;
}

interface SolcInput {
  language: 'Solidity';
  sources: Record<string, { content: string }>;
  settings: {
    optimizer: { enabled: boolean; runs: number };
    evmVersion?: string;
    outputSelection: Record<string, Record<string, string[]>>;
  };
}

/** Build the Standard JSON input for a set of files. */
export function buildSolcInput(files: ProjectFile[], settings: CompileSettings): SolcInput {
  const sources: Record<string, { content: string }> = {};
  for (const file of files) {
    const name = file.name.trim();
    if (!name) continue;
    sources[name] = { content: file.content };
  }
  return {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: settings.optimizer, runs: Math.max(1, Math.floor(settings.runs)) },
      ...(settings.evmVersion ? { evmVersion: settings.evmVersion } : {}),
      outputSelection: {
        '*': {
          '*': [
            'abi',
            'evm.bytecode.object',
            'evm.bytecode.linkReferences',
            'evm.deployedBytecode.object',
          ],
        },
      },
    },
  };
}

/**
 * Convert solc diagnostics into the shape the UI renders.
 *
 * solc reports byte offsets, not line numbers. `formattedMessage` already
 * contains a human-readable `file:line:column` pointer, so that is what the UI
 * shows.
 */
export function parseDiagnostics(errors: SolcError[]): Diagnostic[] {
  return errors.map((error) => {
    const severity =
      error.severity === 'error' ? 'error' : error.severity === 'info' ? 'info' : 'warning';
    const formatted = error.formattedMessage ?? error.message ?? 'Unknown compiler problem';
    const location = error.sourceLocation;
    return {
      severity,
      message: error.message ?? formatted,
      formatted: formatted.trim(),
      ...(location?.file ? { file: location.file } : {}),
    };
  });
}

/**
 * Compile a project with a loaded compiler.
 * Throws only when the compiler itself cannot run; Solidity errors are returned
 * as diagnostics so the UI can show them next to the code.
 */
export function compileProject(
  files: ProjectFile[],
  settings: CompileSettings,
  compiler: Compiler,
): CompileResult {
  if (files.length === 0) {
    return {
      compilerVersion: compiler.version,
      contracts: [],
      diagnostics: [
        {
          severity: 'error',
          message: 'No source files',
          formatted: 'No source files. Add a .sol file before compiling.',
        },
      ],
      success: false,
      durationMs: 0,
    };
  }

  const input = buildSolcInput(files, settings);
  const started = performance.now();
  let raw: string;
  try {
    raw = compiler.compile(JSON.stringify(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      compilerVersion: compiler.version,
      contracts: [],
      diagnostics: [
        {
          severity: 'error',
          message,
          formatted: `The compiler crashed: ${message}`,
        },
      ],
      success: false,
      durationMs: Math.round(performance.now() - started),
    };
  }

  let output: SolcOutput;
  try {
    output = JSON.parse(raw) as SolcOutput;
  } catch {
    return {
      compilerVersion: compiler.version,
      contracts: [],
      diagnostics: [
        {
          severity: 'error',
          message: 'Invalid compiler output',
          formatted: 'The compiler returned output that is not valid JSON.',
        },
      ],
      success: false,
      durationMs: Math.round(performance.now() - started),
    };
  }

  const diagnostics = parseDiagnostics(output.errors ?? []);
  const contracts: CompiledContract[] = [];

  for (const [file, fileContracts] of Object.entries(output.contracts ?? {})) {
    for (const [name, contract] of Object.entries(fileContracts)) {
      const abi = contract.abi ?? [];
      const bytecodeObject = contract.evm?.bytecode?.object ?? '';
      contracts.push({
        id: `${file}:${name}`,
        file,
        name,
        abi,
        bytecode: bytecodeObject ? (bytecodeObject.startsWith('0x') ? bytecodeObject : `0x${bytecodeObject}`) : '',
        deployedBytecode: contract.evm?.deployedBytecode?.object
          ? `0x${contract.evm.deployedBytecode.object.replace(/^0x/, '')}`
          : '',
        linkReferences: contract.evm?.bytecode?.linkReferences ?? {},
      });
    }
  }

  contracts.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  return {
    compilerVersion: compiler.version,
    contracts,
    diagnostics,
    success: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    durationMs: Math.round(performance.now() - started),
  };
}

/** Libraries that need external linking cannot be deployed as-is. */
export function unlinkedLibraries(contract: CompiledContract): string[] {
  const names: string[] = [];
  for (const [file, libraries] of Object.entries(contract.linkReferences)) {
    for (const library of Object.keys(libraries)) {
      names.push(`${file}:${library}`);
    }
  }
  return names;
}
