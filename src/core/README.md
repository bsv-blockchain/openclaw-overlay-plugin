# @a2a-bsv/core

BSV agent-to-agent payment library. Wraps [`@bsv/sdk`](https://github.com/bsv-blockchain/ts-sdk) and [`@bsv/wallet-toolbox`](https://github.com/bsv-blockchain/wallet-toolbox) to provide exactly the operations AI agents need to pay each other on the BSV blockchain.

## Features

- **BRC-100 compliant wallet** backed by SQLite for local persistence
- **BRC-29 payments** — privacy-preserving key derivation, no address reuse
- **SPV verification** via Atomic BEEF transaction format
- **noSend workflow** — sender builds the transaction, recipient verifies and broadcasts
- **Clean API** — minimal surface area designed for automated agent use

## Installation

```bash
npm install @a2a-bsv/core
```

> Requires Node.js 18+ and SQLite3 (native dependency via `@bsv/wallet-toolbox`).

## Quick Start

```typescript
import { BSVAgentWallet } from '@a2a-bsv/core';

// 1. Create wallets for two agents
const agentA = await BSVAgentWallet.create({
  network: 'testnet',
  storageDir: './wallet-agent-a',
});

const agentB = await BSVAgentWallet.create({
  network: 'testnet',
  storageDir: './wallet-agent-b',
});

const agentBKey = await agentB.getIdentityKey();
console.log('Agent B identity:', agentBKey);

// 2. Agent A builds a payment to Agent B (requires funded wallet)
const payment = await agentA.createPayment({
  to: agentBKey,
  satoshis: 500,
  description: 'Payment for code review',
});

// 3. Agent B verifies the payment
const verification = await agentB.verifyPayment({
  beef: payment.beef,
});

// 4. Agent B accepts (internalizes) the payment
if (verification.valid) {
  const receipt = await agentB.acceptPayment({
    beef: payment.beef,
    derivationPrefix: payment.derivationPrefix,
    derivationSuffix: payment.derivationSuffix,
    senderIdentityKey: payment.senderIdentityKey,
    description: 'Code review payment received',
  });
  console.log('Payment accepted:', receipt.accepted);
}

// 5. Clean up
await agentA.destroy();
await agentB.destroy();
```

## API

### `BSVAgentWallet`

#### Factory Methods

| Method | Description |
|--------|-------------|
| `BSVAgentWallet.create(config)` | Create a new wallet (generates keys, creates SQLite DB) |
| `BSVAgentWallet.load(config)` | Load an existing wallet from storage |

#### `WalletConfig`

```typescript
interface WalletConfig {
  network: 'mainnet' | 'testnet';
  storageDir: string;      // Directory for SQLite DB and identity file
  rootKeyHex?: string;     // Optional: provide your own root key
  taalApiKey?: string;     // Optional: TAAL API key for ARC broadcasting
}
```

#### Wallet Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `getIdentityKey()` | `Promise<string>` | Compressed public key (hex) — share this with other agents |
| `getBalance()` | `Promise<number>` | Balance in satoshis |
| `destroy()` | `Promise<void>` | Close DB connections, stop monitor |

#### Payments (Sender Side)

```typescript
const payment = await wallet.createPayment({
  to: recipientPublicKey,  // Compressed hex pubkey (required)
  satoshis: 500,           // Amount in satoshis
  description: 'Agent task payment',
});
```

Returns a `PaymentResult`:

```typescript
interface PaymentResult {
  beef: string;               // Base64-encoded Atomic BEEF
  txid: string;               // Transaction ID
  satoshis: number;           // Amount paid
  derivationPrefix: string;   // BRC-29 derivation info (send to recipient)
  derivationSuffix: string;   // BRC-29 derivation info (send to recipient)
  senderIdentityKey: string;  // Sender's identity key (send to recipient)
}
```

> **Important:** The `derivationPrefix`, `derivationSuffix`, and `senderIdentityKey` MUST be transmitted to the recipient alongside the `beef`. These are needed for the recipient to claim the payment.

#### Payments (Receiver Side)

**Verify** (includes SPV verification):

```typescript
const result = await wallet.verifyPayment({
  beef: payment.beef,
  expectedSender: senderKey,  // Optional
});
// result.valid, result.txid, result.errors
```

**Accept** (internalize into wallet):

```typescript
const receipt = await wallet.acceptPayment({
  beef: payment.beef,
  vout: 0,                                    // Output index (default: 0)
  derivationPrefix: payment.derivationPrefix,
  derivationSuffix: payment.derivationSuffix,
  senderIdentityKey: payment.senderIdentityKey,
  description: 'Payment received',
});
// receipt.accepted
```

#### Advanced Access

```typescript
// Access underlying wallet-toolbox SetupWallet for advanced operations
const setup = wallet.getSetup();
// setup.wallet — the BRC-100 Wallet instance
// setup.rootKey — the root PrivateKey
// setup.services — network Services
// setup.storage — WalletStorageManager
```

## Architecture

```
BSVAgentWallet
├── Wallet (BRC-100)          — from @bsv/wallet-toolbox
│   ├── CachedKeyDeriver      — BRC-42 key derivation
│   ├── WalletStorageManager   — manages storage providers
│   │   └── StorageKnex       — SQLite via knex
│   ├── Services               — ARC broadcasting, chain tracking
│   └── Monitor                — background task processing
└── ScriptTemplateBRC29        — BRC-29 payment scripts
```

### Payment Flow

```
Agent A (Payer)                          Agent B (Merchant)
─────────────────                        ──────────────────
1. createPayment(to=B, sat=500)
   → builds BRC-29 tx (noSend)
   → returns BEEF + derivation info
                                    ──→
2.                                       verifyPayment(beef)
                                         → structural checks
                                         → returns valid/errors

3.                                       acceptPayment(beef, derivation)
                                         → wallet.internalizeAction()
                                         → SPV verification
                                         → broadcasts to network
                                         → output added to wallet
```

## Key Concepts

### BRC-29 Key Derivation
Each payment uses unique derivation prefixes and suffixes to generate a one-time key. This means:
- No address reuse (privacy preserving)
- Recipient needs the derivation info to claim the payment
- The sender's identity key is also needed for key derivation

### Atomic BEEF
Transactions are packaged as Atomic BEEF (Background Evaluation Extended Format), which includes:
- The payment transaction itself
- All ancestor transactions needed for SPV verification
- Merkle proofs linking to block headers

This allows the recipient to verify the payment without trusting any third party.

### noSend Workflow
The sender builds and signs the transaction but does NOT broadcast it. Instead:
1. The signed transaction (as Atomic BEEF) is sent directly to the recipient
2. The recipient verifies it via SPV
3. The recipient internalizes it (claiming the output and broadcasting)

This is the BRC-100 Direct Instant Payments (DIP) pattern.

## Storage

Each wallet creates:
- `wallet-identity.json` — Contains the root key hex, identity key, and network
- `a2a_agent_wallet.sqlite` — SQLite database with all wallet state

> ⚠️ **Security:** The `wallet-identity.json` file contains the root private key. Guard it carefully in production.

## Known Issues

- **Wallet-toolbox bug:** `Setup.createWalletSQLite` has an internal `randomBytesHex` stub that throws. This library works around it by constructing wallet components manually.
- **Funding required:** `createPayment()` requires the wallet to have spendable UTXOs. On testnet, use the [WitnessOnChain faucet](https://witnessonchain.com/faucet/tbsv) to fund your wallet. Track transactions on [WhatsonChain testnet](https://test.whatsonchain.com/) or [WhatsonChain mainnet](https://whatsonchain.com/).

## Development

```bash
# Type check
npm run check

# Build
npm run build

# Test
npm test
```

## License

MIT
