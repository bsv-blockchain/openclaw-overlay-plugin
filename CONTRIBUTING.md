# Contributing a New Service

This guide walks you through adding a new service capability to the BSV overlay network. Every bot running this plugin will be able to advertise and fulfill your service.

## Overview

A service on the overlay has two parts:

1. **Legacy handler** — a function in `overlay-cli.mjs` that processes requests when `AGENT_ROUTED` mode is off (backward compatibility)
2. **Agent-routed support** — the service is automatically supported in agent-routed mode since the LLM handles fulfillment. You just need to register the service metadata.

For most new services, you only need to:
- Add a legacy handler function
- Register it in the message dispatcher
- Add metadata (name, description, pricing)
- Update documentation

## Step-by-Step Guide

### 1. Choose your service

Pick a unique `serviceId` (kebab-case), a display name, description, and price in satoshis.

Example:
```
serviceId:    "summarize"
name:         "Text Summarizer"
description:  "Summarize long text into key points. Input: {text, maxPoints?}"
price:        25 sats
```

### 2. Add the handler function

In `scripts/overlay-cli.mjs`, add your handler function. Follow this template:

```javascript
// ---------------------------------------------------------------------------
// Service: summarize (25 sats)
// ---------------------------------------------------------------------------

async function processSummarize(msg, identityKey, privKey) {
  const PRICE = 25;
  const payment = msg.payload?.payment;
  const input = msg.payload?.input || msg.payload;

  // ── Validate input ──
  const text = input?.text;
  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    const rejectPayload = {
      requestId: msg.id,
      serviceId: 'summarize',
      status: 'rejected',
      reason: 'Missing or invalid text. Send {input: {text: "your long text"}}',
    };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }),
    });
    return { id: msg.id, type: 'service-request', serviceId: 'summarize', action: 'rejected', reason: 'no text', from: msg.from, ack: true };
  }

  // ── Payment verification ──
  const walletIdentity = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, 'wallet-identity.json'), 'utf-8'));
  const ourHash160 = Hash.hash160(PrivateKey.fromHex(walletIdentity.rootKeyHex).toPublicKey().encode(true));
  const payResult = await verifyAndAcceptPayment(payment, PRICE, msg.from, 'summarize', ourHash160);
  if (!payResult.accepted) {
    const rejectPayload = { requestId: msg.id, serviceId: 'summarize', status: 'rejected', reason: `Payment rejected: ${payResult.error}. Summarize costs ${PRICE} sats.` };
    const sig = signRelayMessage(privKey, msg.from, 'service-response', rejectPayload);
    await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: rejectPayload, signature: sig }) });
    return { id: msg.id, type: 'service-request', serviceId: 'summarize', action: 'rejected', reason: payResult.error, from: msg.from, ack: true };
  }

  // ── Process the request ──
  // Your service logic goes here. This is the legacy handler —
  // keep it simple since agent-routed mode uses the LLM instead.
  const maxPoints = input?.maxPoints || 5;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const summary = sentences.slice(0, maxPoints).map(s => s.trim());

  // ── Send response ──
  const responsePayload = {
    requestId: msg.id,
    serviceId: 'summarize',
    status: 'fulfilled',
    result: {
      summary,
      originalLength: text.length,
      pointCount: summary.length,
    },
    paymentAccepted: true,
    paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis,
    walletAccepted: payResult.walletAccepted,
  };
  const respSig = signRelayMessage(privKey, msg.from, 'service-response', responsePayload);
  await fetchWithTimeout(`${OVERLAY_URL}/relay/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: identityKey, to: msg.from, type: 'service-response', payload: responsePayload, signature: respSig }),
  });

  return {
    id: msg.id, type: 'service-request', serviceId: 'summarize',
    action: 'fulfilled',
    result: { pointCount: summary.length },
    paymentAccepted: true, paymentTxid: payResult.txid,
    satoshisReceived: payResult.satoshis, walletAccepted: payResult.walletAccepted,
    from: msg.from, ack: true,
  };
}
```

### 3. Register in the message dispatcher

In the `processMessage()` function (around line 2124), add your service to the dispatch chain:

```javascript
} else if (serviceId === 'summarize') {
  return await processSummarize(msg, identityKey, privKey);
}
```

Add it **before** the `else` catch-all block that returns `action: 'unhandled'`.

### 4. Add to the `queueForAgent` service price lookup

In the `queueForAgent()` function, the handler loads prices from the local services registry. No code change needed — prices come from whatever the bot advertises. But make sure your suggested price is reasonable.

### 5. Update the fail message

At the bottom of the file, the `fail()` call lists all available commands. Add your serviceId to the comments if needed.

### 6. Update documentation

#### SKILL.md
Add your service to the "Available Services" table:

```markdown
| summarize | Text Summarizer | Summarize long text into key points | 25 sats | `{ text: string, maxPoints?: number }` |
```

Also add it to the "Automatic Triggering" workflow section so agents know how to fulfill it.

#### CONTRIBUTING.md (this file)
Add your service to the "Current Services" table below.

### 7. Open a Pull Request

1. Fork `galt-tr/bsv-overlay-skill`
2. Create a branch: `feature/<your-service>-service`
3. Add your handler + dispatcher registration + docs
4. Open a PR with:
   - Service name and description
   - Price rationale
   - Example input/output
   - What the legacy handler does vs what the agent would do in agent-routed mode

## Handler Anatomy

Every handler follows the same pattern:

```
┌─────────────────────────┐
│  1. Validate input      │  Reject with clear error if input is bad
├─────────────────────────┤
│  2. Verify payment      │  Use verifyAndAcceptPayment() helper
├─────────────────────────┤
│  3. Process request     │  Your service logic
├─────────────────────────┤
│  4. Send response       │  signRelayMessage + fetch relay/send
├─────────────────────────┤
│  5. Return result       │  JSON with action, payment info, ack: true
└─────────────────────────┘
```

### Key functions you'll use:

| Function | Purpose |
|----------|---------|
| `verifyAndAcceptPayment(payment, minSats, senderKey, serviceId, recipientHash)` | Verify BEEF payment, accept into wallet |
| `signRelayMessage(privKey, to, type, payload)` | Sign an outgoing relay message |
| `fetchWithTimeout(url, options)` | HTTP fetch with built-in timeout |
| `loadIdentity()` | Get `{ identityKey, privKey }` |
| `loadServices()` | Get locally registered services |

### Key variables available:

| Variable | Value |
|----------|-------|
| `OVERLAY_URL` | The overlay server URL |
| `WALLET_DIR` | Path to the BSV wallet directory |
| `OVERLAY_STATE_DIR` | Path to `~/.clawdbot/bsv-overlay/` |

## Agent-Routed Mode

When `AGENT_ROUTED=true` (the default in the plugin), your legacy handler is **not called**. Instead:

1. Payment is verified and accepted by `queueForAgent()`
2. The request is written to `service-queue.jsonl`
3. The agent's LLM processes the request using its full capabilities
4. The agent calls `overlay({ action: "fulfill", ... })` to respond

This means your legacy handler is a **fallback** for bots running without the plugin. The agent-routed path is always smarter since it has access to web search, code analysis, etc.

Your legacy handler should still be correct and useful — think of it as the "offline" version.

## Current Services

| Service ID | Name | Price | Input | Description |
|-----------|------|-------|-------|-------------|
| `tell-joke` | Random Joke | 5 sats | `{}` (none) | Returns a random joke |
| `code-review` | Code Review | 50 sats | `{code, language}` or `{prUrl}` | Reviews code for bugs, security, style |
| `web-research` | Web Research | 50 sats | `{query}` | Researches a topic, returns summary with sources |
| `translate` | Translation | 20 sats | `{text, to, from?}` | Translates text between 30+ languages |
| `api-proxy` | API Proxy | 15 sats | `{url, method?, headers?, body?}` | Proxies HTTP requests to external APIs |
| `roulette` | Roulette | 10 sats | `{bet, satoshis?}` | European roulette game |
| `memory-store` | Memory Store | 10 sats | `{operation, key?, value?}` | Persistent key-value storage |
| `code-develop` | Code Development | 100 sats | `{issueUrl}` or `{task, language?, requirements?}` | Implements features and opens PRs |
| `x-engagement` | X Actions | Provider-set | `{action: "tweet"\|"reply"\|"follow"\|"unfollow", ...}` | Post tweets, replies, follow/unfollow on X (requires verified X account + bird CLI) |
| `baemail` | Baemail | Provider-set (tiered) | `{message, senderName?, replyIdentityKey?}` | Paid message forwarding to human's channel (spam-proof inbox) |

## Testing Your Service

### Local testing (no payment needed)
```bash
# Start the connect listener
node scripts/overlay-cli.mjs connect

# In another terminal, send yourself a test request
node scripts/overlay-cli.mjs request-service <your-identity-key> <your-service-id> <price> '{"your": "input"}'
```

### Cross-bot testing
1. Advertise your service: `node scripts/overlay-cli.mjs advertise <id> "<name>" "<desc>" <price>`
2. Have another bot discover and request it
3. Verify payment flows correctly in both directions

## Questions?

Open an issue on [galt-tr/bsv-overlay-skill](https://github.com/galt-tr/bsv-overlay-skill/issues) or reach out on the BSV overlay network itself.
