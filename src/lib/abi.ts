import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  isAddress,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Hex,
} from 'viem';

export type FunctionKind = 'read' | 'write';

export interface AbiFunctionInfo {
  fn: AbiFunction;
  name: string;
  signature: string;
  kind: FunctionKind;
  inputs: readonly AbiParameter[];
  outputs: readonly AbiParameter[];
  stateMutability: string;
  /** Most functions have unique names; overloads are disambiguated by the signature. */
  key: string;
}

/** Canonical Solidity type for a parameter, expanding tuple components. */
export function canonicalType(param: AbiParameter): string {
  const type = param.type;
  if (type.startsWith('tuple')) {
    const components = ('components' in param ? param.components : undefined) ?? [];
    const inner = components.map(canonicalType).join(',');
    return `(${inner})${type.slice('tuple'.length)}`;
  }
  return type;
}

export function signatureOf(fn: AbiFunction): string {
  return `${fn.name}(${fn.inputs.map(canonicalType).join(',')})`;
}

/** Split an ABI into callable functions, marking view/pure as reads. */
export function listFunctions(abi: Abi): AbiFunctionInfo[] {
  const functions: AbiFunctionInfo[] = [];
  for (const item of abi) {
    if (item.type !== 'function') continue;
    const stateMutability = item.stateMutability ?? 'nonpayable';
    const kind: FunctionKind = stateMutability === 'view' || stateMutability === 'pure' ? 'read' : 'write';
    const signature = signatureOf(item);
    functions.push({
      fn: item,
      name: item.name,
      signature,
      kind,
      inputs: item.inputs ?? [],
      outputs: item.outputs ?? [],
      stateMutability,
      key: signature,
    });
  }
  return functions;
}

/** The constructor fragment of an ABI, if the contract declares one. */
export type AbiConstructorInfo = Extract<Abi[number], { type: 'constructor' }>;

export function findConstructor(abi: Abi): AbiConstructorInfo | null {
  for (const item of abi) {
    if (item.type === 'constructor') return item;
  }
  return null;
}

export class ArgumentError extends Error {
  constructor(
    message: string,
    readonly argument?: string,
  ) {
    super(message);
    this.name = 'ArgumentError';
  }
}

function parseJsonArgument(param: AbiParameter, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ArgumentError(
      `Argument "${param.name || param.type}" expects JSON for ${canonicalType(param)}`,
      param.name,
    );
  }
}

/**
 * Convert a text field value into the JavaScript value viem expects.
 * Arrays and structs are entered as JSON, which keeps the form simple and
 * predictable for nested types.
 */
export function parseArgument(param: AbiParameter, raw: string): unknown {
  const value = raw.trim();
  const type = canonicalType(param);
  const label = param.name || type;

  if (type.endsWith(']') || type.startsWith('(')) return parseJsonArgument(param, value);
  if (type === 'bool') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new ArgumentError(`Argument "${label}" expects true or false`, param.name);
  }
  if (type.startsWith('uint') || type.startsWith('int')) {
    try {
      const parsed = BigInt(value);
      if (type.startsWith('uint') && parsed < 0n) {
        throw new Error('negative');
      }
      return parsed;
    } catch {
      throw new ArgumentError(`Argument "${label}" expects an integer`, param.name);
    }
  }
  if (type === 'address') {
    if (!isAddress(value, { strict: false })) {
      throw new ArgumentError(`Argument "${label}" expects a 0x-prefixed address`, param.name);
    }
    return value;
  }
  if (type.startsWith('bytes')) {
    if (value === '') return '0x';
    if (!value.startsWith('0x')) {
      throw new ArgumentError(`Argument "${label}" expects 0x-prefixed hex`, param.name);
    }
    return value;
  }
  if (type === 'string') return raw;
  return value;
}

export function parseArguments(params: readonly AbiParameter[], values: string[]): unknown[] {
  return params.map((param, index) => parseArgument(param, values[index] ?? ''));
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Human-readable rendering of a decoded value. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return JSON.stringify(value, replacer);
  if (typeof value === 'object') return JSON.stringify(value, replacer, 2);
  return String(value);
}

export function encodeCall(fn: AbiFunction, args: unknown[]): Hex {
  return encodeFunctionData({
    abi: [fn],
    functionName: fn.name,
    args,
  } as Parameters<typeof encodeFunctionData>[0]);
}

export function decodeCallResult(fn: AbiFunction, data: Hex): unknown {
  if (!data || data === '0x') {
    if (fn.outputs.length === 0) return undefined;
    throw new Error('Call returned no data');
  }
  const decoded = decodeFunctionResult({
    abi: [fn],
    functionName: fn.name,
    data,
  } as Parameters<typeof decodeFunctionResult>[0]);
  return decoded;
}

/** Decode the return data of a reverted call into a readable reason. */
export function decodeRevertReason(data?: Hex): string | undefined {
  if (!data || data === '0x') return undefined;
  if (data.startsWith('0x08c379a0')) {
    try {
      const [reason] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}` as Hex);
      return typeof reason === 'string' ? reason : undefined;
    } catch {
      return undefined;
    }
  }
  if (data.startsWith('0x4e487b71')) {
    try {
      const [code] = decodeAbiParameters([{ type: 'uint256' }], `0x${data.slice(10)}` as Hex);
      const value = typeof code === 'bigint' ? code.toString() : String(code);
      const panics: Record<string, string> = {
        '1': 'assert failed',
        '17': 'arithmetic overflow or underflow',
        '18': 'division by zero',
        '33': 'invalid enum value',
        '34': 'invalid storage byte array encoding',
        '49': 'out of memory',
        '50': 'invalid internal function call',
        '65': 'allocation too large',
      };
      return `Panic(0x${BigInt(value).toString(16)}): ${panics[value] ?? 'execution failed'}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface DecodedLog {
  address: string;
  eventName: string;
  args: Record<string, unknown>;
  raw: {
    topics: readonly Hex[];
    data: Hex;
  };
}

/** Decode emitted logs with the contract ABI, falling back to raw data. */
export function decodeLogs(
  abi: Abi,
  logs: ReadonlyArray<{
    address: string;
    topics: readonly Hex[];
    data: Hex;
  }>,
): DecodedLog[] {
  return logs.map((log) => {
    try {
      const decoded = decodeEventLog({
        abi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      return {
        address: log.address,
        eventName: decoded.eventName ?? 'Anonymous',
        args: (decoded.args ?? {}) as Record<string, unknown>,
        raw: { topics: log.topics, data: log.data },
      };
    } catch {
      return {
        address: log.address,
        eventName: 'Unknown event',
        args: {},
        raw: { topics: log.topics, data: log.data },
      };
    }
  });
}

/** Shorten addresses and hashes for dense UI rows. */
export function shortHex(value: string, size = 4): string {
  if (!value) return '';
  if (value.length <= 2 + size * 2) return value;
  return `${value.slice(0, 2 + size)}…${value.slice(-size)}`;
}

export function shortAddress(value: string): string {
  return shortHex(value, 4);
}
