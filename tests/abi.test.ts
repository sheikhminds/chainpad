import { describe, expect, it } from 'vitest';
import {
  ArgumentError,
  canonicalType,
  decodeRevertReason,
  formatValue,
  listFunctions,
  parseArgument,
  parseArguments,
  shortAddress,
  shortHex,
  signatureOf,
} from '../src/lib/abi.ts';
import type { Abi, AbiFunction, AbiParameter } from 'viem';

const counterAbi: Abi = [
  { type: 'constructor', inputs: [{ name: 'start', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'event', name: 'Changed', inputs: [
    { name: 'who', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ], anonymous: false },
  {
    type: 'function',
    name: 'count',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'set',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
];

describe('ABI helpers', () => {
  it('expands tuple types into canonical signatures', () => {
    const param: AbiParameter = {
      name: 'order',
      type: 'tuple',
      components: [
        { name: 'id', type: 'uint256' },
        { name: 'tags', type: 'string[]' },
      ],
    };
    expect(canonicalType(param)).toBe('(uint256,string[])');
    expect(canonicalType({ name: 'fixed', type: 'tuple[2]', components: [{ name: 'a', type: 'bool' }] })).toBe(
      '(bool)[2]',
    );
  });

  it('builds canonical signatures', () => {
    const fn = counterAbi.find((item) => item.type === 'function' && item.name === 'transfer') as AbiFunction;
    expect(signatureOf(fn)).toBe('transfer(address,uint256)');
  });

  it('splits reads and writes', () => {
    const functions = listFunctions(counterAbi);
    expect(functions.map((fn) => fn.name).sort()).toEqual(['count', 'set', 'transfer']);
    expect(functions.find((fn) => fn.name === 'count')?.kind).toBe('read');
    expect(functions.find((fn) => fn.name === 'set')?.kind).toBe('write');
  });

  it('parses scalar argument types', () => {
    expect(parseArgument({ name: 'a', type: 'uint256' }, ' 42 ')).toBe(42n);
    expect(parseArgument({ name: 'a', type: 'int256' }, '-7')).toBe(-7n);
    expect(parseArgument({ name: 'a', type: 'bool' }, 'true')).toBe(true);
    expect(parseArgument({ name: 'a', type: 'bool' }, '0')).toBe(false);
    expect(parseArgument({ name: 'a', type: 'string' }, ' hello ')).toBe(' hello ');
    expect(parseArgument({ name: 'a', type: 'bytes32' }, '0x')).toBe('0x');
  });

  it('parses arrays and structs as JSON', () => {
    const arrayParam: AbiParameter = { name: 'names', type: 'string[]' };
    expect(parseArgument(arrayParam, '["a","b"]')).toEqual(['a', 'b']);
    const tupleParam: AbiParameter = {
      name: 'order',
      type: 'tuple',
      components: [
        { name: 'id', type: 'uint256' },
        { name: 'ok', type: 'bool' },
      ],
    };
    expect(parseArgument(tupleParam, '{"id":1,"ok":true}')).toEqual({ id: 1, ok: true });
  });

  it('rejects malformed arguments with readable messages', () => {
    expect(() => parseArgument({ name: 'a', type: 'uint256' }, 'nope')).toThrow(ArgumentError);
    expect(() => parseArgument({ name: 'a', type: 'uint256' }, '-1')).toThrow(/expects an integer/);
    expect(() => parseArgument({ name: 'a', type: 'bool' }, 'yes')).toThrow(/expects true or false/);
    expect(() => parseArgument({ name: 'a', type: 'address' }, '0x123')).toThrow(/0x-prefixed address/);
    expect(() => parseArgument({ name: 'a', type: 'bytes' }, 'abcd')).toThrow(/0x-prefixed hex/);
    expect(() => parseArgument({ name: 'a', type: 'string[]' }, 'not-json')).toThrow(/expects JSON/);
  });

  it('parses argument lists positionally', () => {
    const params: AbiParameter[] = [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ];
    expect(parseArguments(params, ['0x000000000000000000000000000000000000dEaD', '5'])).toEqual([
      '0x000000000000000000000000000000000000dEaD',
      5n,
    ]);
  });

  it('formats values without losing bigint precision', () => {
    expect(formatValue(123n)).toBe('123');
    expect(formatValue(true)).toBe('true');
    expect(formatValue(['a', 1n])).toBe('["a","1"]');
    expect(formatValue({ total: 10n })).toBe('{\n  "total": "10"\n}');
    expect(formatValue(undefined)).toBe('');
  });

  it('decodes Error(string) and Panic(uint256) revert payloads', () => {
    // Error("insufficient balance")
    const reason =
      '0x08c379a0' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000014' +
      '696e73756666696369656e742062616c616e6365000000000000000000000000';
    expect(decodeRevertReason(reason as `0x${string}`)).toBe('insufficient balance');

    // Panic(0x11): arithmetic overflow
    const panic =
      '0x4e487b71' + '0000000000000000000000000000000000000000000000000000000000000011';
    expect(decodeRevertReason(panic as `0x${string}`)).toBe(
      'Panic(0x11): arithmetic overflow or underflow',
    );
    expect(decodeRevertReason('0x')).toBeUndefined();
    expect(decodeRevertReason('0xdeadbeef')).toBeUndefined();
  });

  it('shortens identifiers', () => {
    expect(shortHex('0x1234567890abcdef')).toBe('0x1234…cdef');
    expect(shortAddress('0x1234567890abcdef')).toBe('0x1234…cdef');
    expect(shortHex('0x12')).toBe('0x12');
  });
});
