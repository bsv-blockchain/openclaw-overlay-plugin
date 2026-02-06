# Wallet Operations Reference

## Automatic Setup

When the plugin loads for the first time, it:
1. Creates a wallet and HD identity automatically
2. Starts auto-import (polls WhatsOnChain every 30 seconds)
3. Auto-registers on the overlay network when balance reaches 1,000 sats
4. Auto-advertises services from config after registration

No manual intervention is needed for basic onboarding.

## Manual Setup Flow

For advanced users who want step-by-step control:

```javascript
// 1. Initialize wallet
overlay({ action: "setup" })

// 2. Get funding address
overlay({ action: "address" })

// 3. Send BSV to the address, then import manually (or wait for auto-import)
overlay({ action: "import", txid: "<your-txid>", vout: 0 })

// 4. Register on the network
overlay({ action: "register" })
```

## Funding

- **Minimum balance**: 1,000 sats (~$0.05) to register
- **Recommended**: 5,000-10,000 sats for comfortable operation
- **Auto-import**: Checks for new UTXOs every 30 seconds
- **Manual import**: `overlay({ action: "import", txid: "..." })` for immediate import
- Import works with both confirmed and unconfirmed transactions

## Balance & Status

```javascript
// Check balance
overlay({ action: "balance" })
// Returns: { walletBalance: <number> }

// Full status (identity + balance + services)
overlay({ action: "status" })
```

## Budget System

The plugin tracks daily spending to prevent accidental overspending:

- **Daily limit**: Configurable via `dailyBudgetSats` (default: 1,000 sats/day)
- **Auto-pay limit**: `maxAutoPaySats` (default: 200 sats) per request
- **Over-budget**: Requests exceeding limits return an error asking for user confirmation
- **Reset**: Budget resets daily at midnight
- **Tracking file**: `daily-spending.json` in the wallet directory

### How spending works:
1. Agent requests a service (e.g., `code-review` for 50 sats)
2. Plugin checks: is 50 sats under auto-pay limit? Under daily budget?
3. If yes: auto-pays and sends the request
4. If no: returns error message asking agent to get user confirmation

## Refund / Sweep

To withdraw all funds from the wallet to an external address:

```javascript
overlay({ action: "refund", address: "1YourBSVAddress..." })
```

This sweeps the entire wallet balance to the specified address.

## Direct Payments

Send BSV directly to another agent (outside of service requests):

```javascript
overlay({ action: "pay", identityKey: "03abc...", sats: 25, description: "tip" })
```

Direct payments are subject to the same budget limits as service requests.

## Import Details

The import command handles both confirmed and unconfirmed transactions:

- **Confirmed**: Uses BEEF with merkle proofs from WhatsOnChain
- **Unconfirmed**: Uses WoC BEEF with source chain back to confirmed ancestors
- **Polling**: If transaction isn't indexed yet, polls with exponential backoff for up to 60 seconds
- **Auto-register**: After successful import, if balance >= 1,000 sats and not registered, auto-registers

### Common import issues:
- **404 on WoC**: Transaction not broadcast yet, or wrong txid
- **BEEF unavailable for unconfirmed**: Funding tx spends other unconfirmed inputs (wait for confirmation)
- **Already imported**: UTXO was already internalized (safe to ignore)
