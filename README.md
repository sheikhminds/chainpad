# ChainPad

**Build, test and deploy smart contracts in your browser.** No install, no account, no server. Works on phones, tablets and desktops, and hosts free on GitHub Pages.

[![CI](https://github.com/sheikhminds/chainpad/actions/workflows/ci.yml/badge.svg)](https://github.com/sheikhminds/chainpad/actions/workflows/ci.yml)
[![Deploy](https://github.com/sheikhminds/chainpad/actions/workflows/deploy.yml/badge.svg)](https://github.com/sheikhminds/chainpad/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Live app:** https://sheikhminds.github.io/chainpad/

ChainPad is a small, complete Solidity playground. It compiles real contracts with the official Solidity compiler (WebAssembly), runs them on an EVM that lives inside the tab, generates forms from the ABI, and lets you send a real deployment through your browser wallet. Everything runs locally: your code never leaves the page.

> Built and maintained by an autonomous AI agent. Code is written, tested and shipped without a human in the loop.

---

## Why

Learning Solidity usually starts with a wall of tooling: Node, npm, Hardhat or Foundry, a wallet, a testnet faucet. ChainPad removes that wall. Open the link, edit a contract, press **Compile**, press **Deploy**, and you have a live contract in under a minute — on a phone if that is what you have.

It is aimed at learning, prototyping and quick demos. It is not a replacement for a full development framework; see [Limits](#limits).

## Features

- **Real compiler, no server.** The official `solc` WebAssembly build is downloaded once from `binaries.soliditylang.org` and cached in the browser, so later compiles work offline. Pick any stable version from 0.6.0 up.
- **Multi-file projects.** Add, rename and remove `.sol` files; relative imports resolve inside the project.
- **A real EVM devnet.** Deploy and call contracts on an in-tab Ethereum chain (chain ID 31337). Gas, nonces, events, reverts and `msg.sender` behave like a real chain. State resets on reload, by design.
- **Generated interaction forms.** Read and write functions are rendered from the ABI, including arrays, structs (JSON input), payable values and overloads.
- **JavaScript test runner.** Write tests with `test`, `expect`, `deploy`, `accounts` and `chain`. Every run starts on a fresh chain, so one failure cannot poison the next test. Matchers include `toBe`, `toEqual`, `toContain`, `toBeGreaterThan` and `await expect(promise).toRevert('reason')`.
- **Four working templates.** Counter, ERC-20 token, a two-file Voting contract, and a Tiny NFT — each with a passing test file.
- **Deploy with a browser wallet.** Optionally send the deployment transaction through MetaMask or another EIP-1193 wallet to a real network. ChainPad never sees your keys.
- **Mobile-first UI.** Code and tools switch with one tap; the desktop layout shows both side by side. Dark theme, keyboard shortcuts (`Ctrl/⌘ + Enter` to compile or run tests).
- **Project import/export and autosave.** Download a project as JSON, drag it back in later, or rely on localStorage.
- **Installable PWA.** Add it to your home screen; the shell and cached compiler work offline.
- **No telemetry, no accounts, no backend.**

## Quick start

### Use the hosted app

Open https://sheikhminds.github.io/chainpad/, pick a template, and press **Compile**.

### Run locally

```bash
git clone https://github.com/sheikhminds/chainpad.git
cd chainpad
npm install
npm run dev
```

Open the printed URL. The first compile downloads about 10 MB of compiler; after that it is cached.

### Build a static site

```bash
npm run build
npm run preview
```

The output in `dist/` is plain static files with relative asset paths, so it works from any subdirectory.

### Host your own copy on GitHub Pages

1. Fork this repository.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`. The `Deploy to GitHub Pages` workflow builds, tests and publishes the site.

No secrets or environment variables are required.

## How it works

| Piece | What it does |
| --- | --- |
| `src/lib/solc.ts` | Fetches `soljson-vX.Y.Z.js`, caches it with the Cache API, and wraps `solidity_compile` in a small compiler API. |
| `src/lib/compile.ts` | Builds Standard JSON input, runs the compiler, normalises diagnostics, contracts, bytecode and library links. |
| `src/lib/chain.ts` | An in-memory EVM (`@ethereumjs/vm`) with three funded accounts. Reads execute against a checkpoint and are reverted; writes commit. |
| `src/lib/abi.ts` | Argument parsing, calldata encoding, return-value and event decoding, revert-reason decoding (all via `viem`). |
| `src/lib/tests.ts` | A tiny test runner that executes your JavaScript against a fresh devnet. |
| `src/lib/wallet.ts` | Sends an `eth_sendTransaction` deployment through an injected EIP-1193 provider and waits for the receipt. |
| `src/lib/project.ts` | Templates, validation, serialisation and localStorage persistence. |
| `src/ui/` | Framework-free DOM UI and a CodeMirror 6 Solidity editor. |

The compiler is **not** bundled in this repository. It is GPL-3.0 software downloaded at runtime from the official Solidity binary repository and never redistributed by ChainPad.

## Templates

| Template | What it teaches |
| --- | --- |
| Counter | Storage, events, constructor arguments, the smallest possible read/write loop. |
| ERC-20 token | Balances, allowances, `transfer`/`transferFrom`, custom revert reasons. |
| Voting | Two source files, a local interface, an import, votes from several accounts. |
| Tiny NFT | Minting, approvals, transfers and indexed event topics. |

Each template ships with tests that pass on the in-browser devnet.

## Testing

```bash
npm test
```

The suite runs with Vitest and covers:

- compiler loading and the production `soljson` evaluation path,
- all four templates compiling without errors,
- deploy, read, write, events, reverts, balances and chain reset on the real EVM,
- ABI parsing and formatting, including tuples, arrays and revert payloads,
- the JavaScript test runner (passing, failing, `toRevert`, console capture, isolation),
- browser-wallet deployment with a mocked EIP-1193 provider,
- the UI shell, and a full **compile → deploy → write → read** flow through the actual app.

CI runs the build and the full suite on every push and pull request.

## Limits

ChainPad is honest about what it is not:

- **The devnet is ephemeral.** Reloading the page clears balances, blocks and deployments. Export the project if you want to keep the code.
- **Devnet keys are random and live in memory.** Never send real funds to devnet addresses.
- **No external imports.** Contracts can import files inside the project only. Vendor dependencies as files or keep contracts self-contained.
- **Wallet support is deploy-only.** You can deploy through a browser wallet, but writing to wallet-deployed contracts from ChainPad is not wired up yet; use the wallet's own interface or a block explorer.
- **Not a security tool.** The test runner executes JavaScript in the page; it is a convenience, not a sandbox. Do not paste code you do not trust.
- **Not Hardhat or Foundry.** There is no Solidity debugger, gas profiler, fork mode, fuzzing, coverage, script runner or plugin ecosystem.
- **Learning and prototyping only.** Audit and test thoroughly before putting value at risk on a real network.

## Roadmap

- Wallet writes (not just deployments) for contracts on real networks.
- Save and reopen named projects.
- More templates (staking, multisig, minimal proxy).
- Shareable read-only links that embed a project in the URL.
- Optional gas estimates before sending.

Issues and ideas are welcome. Please keep reports reproducible and include the browser and contract involved.

## Support the project

ChainPad is free and open source, with no ads and no tracking. If it saved you time:

- ⭐ Star the repo.
- 🐛 Report bugs or suggest features in [Issues](https://github.com/sheikhminds/chainpad/issues).
- 💜 [Sponsor the project on GitHub](https://github.com/sponsors/sheikhminds).

## License

ChainPad is released under the [MIT License](LICENSE).

The Solidity compiler is licensed under GPL-3.0 and is downloaded at runtime from [binaries.soliditylang.org](https://binaries.soliditylang.org/). It is not part of this repository's source or build output.
