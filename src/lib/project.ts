import type { ProjectFile } from './compile.ts';

export interface ProjectSettings {
  compiler: string;
  optimizer: boolean;
  runs: number;
}

export interface Project {
  name: string;
  files: ProjectFile[];
  activeFile: string;
  settings: ProjectSettings;
  /** JavaScript source for the built-in test runner. */
  tests: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  tags: string[];
  project: () => Project;
}

const STORAGE_KEY = 'chainpad:project:v1';
export const SCHEMA_VERSION = 1;

const COUNTER_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Counter
/// @notice The smallest stateful contract: useful for trying out calls.
contract Counter {
    uint256 public count;

    event Changed(address indexed who, uint256 value);

    constructor(uint256 start) {
        count = start;
    }

    function increment() external {
        count += 1;
        emit Changed(msg.sender, count);
    }

    function add(uint256 amount) external {
        count += amount;
        emit Changed(msg.sender, count);
    }

    function set(uint256 value) external {
        count = value;
        emit Changed(msg.sender, value);
    }
}
`;

const COUNTER_TESTS = `// Tests run against a fresh in-browser chain.
// Available: test, expect, deploy, accounts, chain
test('constructor sets the starting value', async () => {
  const counter = await deploy('Counter', [10n])
  expect(await counter.read('count')).toBe(10n)
})

test('increment changes state', async () => {
  const counter = await deploy('Counter', [0n])
  await counter.write('increment')
  await counter.write('increment')
  expect(await counter.read('count')).toBe(2n)
})

test('events are emitted', async () => {
  const counter = await deploy('Counter', [0n])
  const tx = await counter.write('add', [5n])
  expect(tx.logs.length).toBe(1)
  expect(tx.logs[0].eventName).toBe('Changed')
})
`;

const ERC20_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title A small, dependency-free ERC-20 token.
/// @notice Enough to learn the standard: balances, allowances and transfers.
contract Token {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 initialSupply) {
        name = name_;
        symbol = symbol_;
        totalSupply = initialSupply * 10 ** decimals;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(to != address(0), "transfer to zero address");
        require(balanceOf[from] >= amount, "insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
`;

const ERC20_TESTS = `test('mints the initial supply to the deployer', async () => {
  const token = await deploy('Token', ['ChainPad', 'CPAD', 1_000n])
  expect(await token.read('name')).toBe('ChainPad')
  expect(await token.read('totalSupply')).toBe(1000n * 10n ** 18n)
  expect(await token.read('balanceOf', [accounts[0].address])).toBe(1000n * 10n ** 18n)
})

test('transfers move tokens', async () => {
  const token = await deploy('Token', ['ChainPad', 'CPAD', 1_000n])
  await token.write('transfer', [accounts[1].address, 25n])
  expect(await token.read('balanceOf', [accounts[1].address])).toBe(25n)
})

test('cannot overspend', async () => {
  const token = await deploy('Token', ['ChainPad', 'CPAD', 1_000n])
  await expect(token.write('transfer', [accounts[1].address, 10n ** 24n])).toRevert('insufficient balance')
})
`;

const VOTING_INTERFACE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVoting {
    function vote(uint256 proposalId) external;
    function winner() external view returns (uint256);
    function proposalCount() external view returns (uint256);
}
`;

const VOTING_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IVoting.sol";

/// @title Voting
/// @notice Two-file example: a contract that implements a local interface.
contract Voting is IVoting {
    string[] public proposals;
    mapping(uint256 => uint256) public votes;
    uint256 public proposalCount;

    event Voted(address indexed voter, uint256 indexed proposalId);

    constructor(string[] memory proposalNames) {
        for (uint256 i = 0; i < proposalNames.length; i++) {
            proposals.push(proposalNames[i]);
        }
        proposalCount = proposalNames.length;
    }

    function vote(uint256 proposalId) external {
        require(proposalId < proposalCount, "unknown proposal");
        votes[proposalId] += 1;
        emit Voted(msg.sender, proposalId);
    }

    function winner() external view returns (uint256) {
        uint256 best = 0;
        for (uint256 i = 1; i < proposalCount; i++) {
            if (votes[i] > votes[best]) best = i;
        }
        return best;
    }

    function proposalName(uint256 proposalId) external view returns (string memory) {
        return proposals[proposalId];
    }
}
`;

const VOTING_TESTS = `test('accepts votes from any account', async () => {
  const voting = await deploy('Voting', [['Alpha', 'Beta']])
  expect(await voting.read('proposalCount')).toBe(2n)
  await voting.write('vote', [1n], { from: 1 })
  await voting.write('vote', [1n], { from: 2 })
  expect(await voting.read('winner')).toBe(1n)
  expect(await voting.read('votes', [1n])).toBe(2n)
})

test('unknown proposals revert', async () => {
  const voting = await deploy('Voting', [['Alpha']])
  await expect(voting.write('vote', [7n])).toRevert('unknown proposal')
})
`;

const NFT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TinyNFT
/// @notice A minimal ERC-721-shaped collectible: mint, approve and transfer.
contract TinyNFT {
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;

    uint256 public nextTokenId = 1;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);

    function mint() external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        ownerOf[tokenId] = msg.sender;
        balanceOf[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, tokenId);
    }

    function approve(address approved, uint256 tokenId) external {
        require(ownerOf[tokenId] == msg.sender, "not the owner");
        getApproved[tokenId] = approved;
        emit Approval(msg.sender, approved, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == from, "wrong owner");
        require(to != address(0), "transfer to zero address");
        require(
            msg.sender == from || msg.sender == getApproved[tokenId],
            "not approved"
        );
        delete getApproved[tokenId];
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }
}
`;

const NFT_TESTS = `test('mints sequential token ids', async () => {
  const nft = await deploy('TinyNFT')
  await nft.write('mint')
  const tx = await nft.write('mint')
  expect(tx.logs[0].eventName).toBe('Transfer')
  expect(await nft.read('nextTokenId')).toBe(3n)
  expect(await nft.read('balanceOf', [accounts[0].address])).toBe(2n)
})

test('approved accounts can transfer a token', async () => {
  const nft = await deploy('TinyNFT')
  await nft.write('mint')
  await nft.write('approve', [accounts[1].address, 1n])
  await nft.write('transferFrom', [accounts[0].address, accounts[1].address, 1n], { from: 1 })
  expect(await nft.read('ownerOf', [1n])).toBe(accounts[1].address)
})
`;

export const TEMPLATES: Template[] = [
  {
    id: 'counter',
    name: 'Counter',
    description: 'The classic first contract: storage, events, and a working test file.',
    tags: ['beginner', '1 file', 'tests'],
    project: () => ({
      name: 'Counter',
      files: [{ name: 'Counter.sol', content: COUNTER_SOURCE }],
      activeFile: 'Counter.sol',
      settings: { compiler: '0.8.30', optimizer: true, runs: 200 },
      tests: COUNTER_TESTS,
    }),
  },
  {
    id: 'erc20',
    name: 'ERC-20 token',
    description: 'A dependency-free token with balances, allowances and transfers.',
    tags: ['token', '1 file', 'tests'],
    project: () => ({
      name: 'ChainPad Token',
      files: [{ name: 'Token.sol', content: ERC20_SOURCE }],
      activeFile: 'Token.sol',
      settings: { compiler: '0.8.30', optimizer: true, runs: 200 },
      tests: ERC20_TESTS,
    }),
  },
  {
    id: 'voting',
    name: 'Voting',
    description: 'Two source files and an interface: see how imports work.',
    tags: ['multi-file', 'governance', 'tests'],
    project: () => ({
      name: 'Voting',
      files: [
        { name: 'Voting.sol', content: VOTING_SOURCE },
        { name: 'IVoting.sol', content: VOTING_INTERFACE },
      ],
      activeFile: 'Voting.sol',
      settings: { compiler: '0.8.30', optimizer: true, runs: 200 },
      tests: VOTING_TESTS,
    }),
  },
  {
    id: 'nft',
    name: 'Tiny NFT',
    description: 'Mint, approve and transfer collectible tokens.',
    tags: ['nft', '1 file', 'tests'],
    project: () => ({
      name: 'Tiny NFT',
      files: [{ name: 'TinyNFT.sol', content: NFT_SOURCE }],
      activeFile: 'TinyNFT.sol',
      settings: { compiler: '0.8.30', optimizer: true, runs: 200 },
      tests: NFT_TESTS,
    }),
  },
];

export function defaultProject(): Project {
  return TEMPLATES[0].project();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeProject(input: unknown): Project {
  if (!isRecord(input)) throw new Error('Project must be an object');
  const rawFiles = input.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('Project needs at least one file');
  }
  const files: ProjectFile[] = rawFiles.map((file, index) => {
    if (!isRecord(file) || typeof file.name !== 'string' || typeof file.content !== 'string') {
      throw new Error(`File ${index + 1} is not a valid { name, content } pair`);
    }
    const name = file.name.trim();
    if (!name) throw new Error(`File ${index + 1} has an empty name`);
    return { name, content: file.content };
  });
  const names = new Set<string>();
  for (const file of files) {
    if (names.has(file.name)) throw new Error(`Duplicate file name: ${file.name}`);
    names.add(file.name);
  }

  const settingsRaw = isRecord(input.settings) ? input.settings : {};
  const compiler =
    typeof settingsRaw.compiler === 'string' && settingsRaw.compiler ? settingsRaw.compiler : '0.8.30';
  const optimizer = typeof settingsRaw.optimizer === 'boolean' ? settingsRaw.optimizer : true;
  const runsRaw = typeof settingsRaw.runs === 'number' ? settingsRaw.runs : 200;
  const runs = Number.isFinite(runsRaw) ? Math.min(1_000_000, Math.max(1, Math.round(runsRaw))) : 200;

  const activeFile =
    typeof input.activeFile === 'string' && names.has(input.activeFile)
      ? input.activeFile
      : files[0].name;

  return {
    name:
      typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : 'Untitled',
    files,
    activeFile,
    settings: { compiler, optimizer, runs },
    tests: typeof input.tests === 'string' ? input.tests : '',
  };
}

/** Parse an exported project file. Throws with a readable message when invalid. */
export function parseProject(text: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON');
  }
  if (isRecord(parsed) && isRecord(parsed.project)) return normalizeProject(parsed.project);
  return normalizeProject(parsed);
}

export function serializeProject(project: Project): string {
  return `${JSON.stringify(
    {
      app: 'chainpad',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      project,
    },
    null,
    2,
  )}\n`;
}

export function loadProject(): Project {
  if (typeof localStorage === 'undefined') return defaultProject();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProject();
    return normalizeProject(JSON.parse(raw));
  } catch {
    return defaultProject();
  }
}

export function saveProject(project: Project): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        name: project.name,
        files: project.files,
        activeFile: project.activeFile,
        settings: project.settings,
        tests: project.tests,
      }),
    );
  } catch {
    // Quota or private mode: the project still works in memory.
  }
}

export function clearProject(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}
