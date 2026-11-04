# ChainPad

**Build, test and deploy smart contracts in your browser.** No install, no account, no server. Works on phones, tablets and desktops, and hosts free on GitHub Pages.

[![CI](https://github.com/sheikhminds/chainpad/actions/workflows/ci.yml/badge.svg)](https://github.com/sheikhminds/chainpad/actions/workflows/ci.yml)
[![Deploy](https://github.com/sheikhminds/chainpad/actions/workflows/deploy.yml/badge.svg)](https://github.com/sheikhminds/chainpad/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Live app:** https://sheikhminds.github.io/chainpad/

ChainPad is a small, complete Solidity playground. It compiles real contracts with the official Solidity compiler (WebAssembly), runs them on an EVM that lives inside the tab, generates forms from the ABI, and can deploy and call those contracts on a real network through a browser or mobile wallet. Everything runs locally: your code never leaves the page.

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
- **Real networks, including from a phone.** Deploy and call contracts through an injected wallet (MetaMask and friends) or pair a mobile wallet with WalletConnect. Reads use `eth_call`, writes are confirmed in your wallet, and every transaction links to a block explorer. ChainPad never sees your keys.
- **Mobile-first UI.** Code and tools switch with one tap; the desktop layout shows both side by side. Dark theme, keyboard shortcuts (`Ctrl/⌘ + Enter` to compile or run tests).
- **Share links with no server.** Press **Share** and the whole project is packed into the URL fragment (`#p=…`). Fragments are never sent to a host, so a shared contract stays as private as the link itself; opening one loads it straight into the editor.
- **Project import/export and autosave.** Download a project as JSON, drag it back in later, or rely on localStorage. Real-network deployments are remembered across reloads so their generated forms come back.
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
| `src/lib/wallet.ts` | Deploy, read and write through an EIP-1193 provider; waits for receipts, decodes events, refuses the wrong chain. |
| `src/lib/walletconnect.ts` | Loads the WalletConnect SDK on demand, pairs a mobile wallet, and supplies the provider above. |
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
- wallet deployment, reads and writes against a **real EVM** behind an EIP-1193 provider, a wrong-chain refusal and a revert,
- WalletConnect pairing, project-id override, shared pairing attempts and fallback routing with a fake SDK,
- the UI shell, and a full **compile → deploy → write → read** flow through the actual app,
- share-link encoding: round-trip, URL-safe alphabet, non-ASCII source, malformed fragments and the size cap,
- the phone layout contract read from the real `src/style.css`: editor/tools switching, the floating Tools button, panel padding, and adjacent 899/900 breakpoints.

CI runs the build and the full suite on every push and pull request.

## Limits

ChainPad is honest about what it is not:

- **The devnet is ephemeral.** Reloading the page clears balances, blocks and devnet deployments. Contracts deployed to a real network are remembered (address and ABI only) so their forms come back. Export the project if you want to keep the code.
- **Devnet keys are random and live in memory.** Never send real funds to devnet addresses.
- **No external imports.** Contracts can import files inside the project only. Vendor dependencies as files or keep contracts self-contained.
- **Wallet sessions depend on your wallet.** Reads, writes and deployments on a real network need the wallet app awake and on the right chain; ChainPad refuses to send to a chain the contract does not live on rather than guessing.
- **WalletConnect adds weight, on demand.** The SDK (~400 KB gzipped) is a separate lazy chunk: only people who tap "Deploy with mobile wallet" download it. Self-hosters can use their own Reown project id with `localStorage.setItem('chainpad:walletconnect-project-id', '…')`.
- **Not a security tool.** The test runner executes JavaScript in the page; it is a convenience, not a sandbox. Do not paste code you do not trust.
- **Not Hardhat or Foundry.** There is no Solidity debugger, gas profiler, fork mode, fuzzing, coverage, script runner or plugin ecosystem.
- **Learning and prototyping only.** Audit and test thoroughly before putting value at risk on a real network.

## Roadmap

- Save and reopen named projects.
- Optional read-only RPC so a deployed contract can be inspected without a wallet session.
- More templates (staking, multisig, minimal proxy).
- Optional gas estimates before sending.

Issues and ideas are welcome. Please keep reports reproducible and include the browser and contract involved.

## Security

- There is no backend, no account and no analytics. Contracts, projects and deployments stay in your browser's storage.
- ChainPad never asks for a private key or seed phrase. Everything signed is confirmed in your wallet.
- The WalletConnect project id in `src/lib/walletconnect.ts` is a public app identifier that ships in the bundle. It is not a credential; self-hosters can substitute their own.
- `npm audit` reports advisories in the WalletConnect SDK's dependency tree (for example `zod`). Those modules are used by the SDK's Node/SSR paths and are **not** in the browser bundle: `grep -r ZodError dist/` finds nothing. They are tracked upstream and will be dropped as soon as the SDK updates.
- A contract deployed to a real network is only as safe as your own review of it. ChainPad is an editor, not an auditor.

## Support the project

ChainPad is free and open source, with no ads and no tracking. If it saved you time:

- ⭐ Star the repo.
- 🐛 Report bugs or suggest features in [Issues](https://github.com/sheikhminds/chainpad/issues).
- 💜 [Sponsor the project on GitHub](https://github.com/sponsors/sheikhminds).

## License

ChainPad is released under the [MIT License](LICENSE).

The Solidity compiler is licensed under GPL-3.0 and is downloaded at runtime from [binaries.soliditylang.org](https://binaries.soliditylang.org/). It is not part of this repository's source or build output.
