# Overlay Submission Overhaul Plan

## Executive Summary

This document outlines a comprehensive plan to fix and properly test the overlay submission functionality in the openclaw-overlay-plugin. The goal is to ensure all client operations correctly interact with the clawdbot-overlay server following BSV overlay standards.

## Research Findings

### BSV Overlay Architecture (BRC-22, BRC-88)

1. **Transaction Submission** (BRC-22):
   - POST `/submit` endpoint accepts transaction data
   - Server performs SPV verification
   - Topic managers determine which outputs to admit
   - Lookup services index admitted outputs

2. **overlay-express Implementation**:
   - Accepts binary BEEF in request body
   - `X-Topics` header: JSON array of topic names
   - Returns `STEAK` response with admitted outputs per topic:
     ```json
     {
       "tm_clawdbot_identity": {
         "outputsToAdmit": [0],
         "coinsToRetain": []
       }
     }
     ```

3. **BEEF Requirements**:
   - Must start with magic bytes `0100beef` (v1) or `0200beef` (v2)
   - Must contain full ancestry chain back to mined transactions
   - Each unconfirmed tx needs its parent tx included
   - Mined transactions need merkle proofs

### Server Topic Manager Logic

The server's `ClawdbotIdentityTopicManager` validates:
1. Script format: `OP_FALSE OP_RETURN <protocol> <json>`
2. Protocol: must be `"clawdbot-overlay-v1"`
3. Type: must be `"identity"` (or `"identity-revocation"` after our fix)
4. identityKey: valid 66-char compressed pubkey hex
5. name: non-empty string
6. capabilities: array
7. timestamp: string

The server's `ClawdbotServicesTopicManager` validates:
1. Same script format
2. Type: must be `"service"`
3. identityKey, serviceId, name: required strings
4. pricing: object with `model` and `amountSats`

## Current Issues

### 1. BEEF Ancestry Chain
- **Problem**: BEEF sometimes missing source transaction data
- **Root Cause**: `Transaction.fromBEEF()` extracts tx without linked ancestry
- **Fix**: Use `Beef.findTransactionForSigning()` or properly link `sourceTransaction` refs

### 2. Stored Change Chain
- **Problem**: When spending from previous tx's change, ancestry may be incomplete
- **Root Cause**: Not preserving full chain when saving change
- **Fix**: Store and reconstruct full chain with merkle proofs

### 3. Missing Server Response Handling
- **Problem**: We return success even when server admits zero outputs
- **Root Cause**: Not checking `outputsToAdmit` in response
- **Fix**: Parse STEAK response and validate admission

### 4. No End-to-End Tests
- **Problem**: No tests that validate full submission flow
- **Fix**: Create comprehensive test suite mirroring server logic

## CLI Commands and Server Interactions

| Command | Action | Topic | Payload Type |
|---------|--------|-------|--------------|
| `register` | Create identity | `tm_clawdbot_identity` | `identity` |
| `unregister` | Revoke identity | `tm_clawdbot_identity` | `identity-revocation` |
| `advertise` | Add service | `tm_clawdbot_services` | `service` |
| `readvertise` | Update service | `tm_clawdbot_services` | `service` |
| `remove` | Local only | N/A | N/A |

## Test Plan

### Unit Tests

1. **BEEF Format Tests**
   - Valid magic bytes (v1/v2)
   - Contains all required transactions
   - Proper ancestry chain
   - Merkle proofs for mined txs

2. **Payload Validation Tests**
   - Identity payload: all required fields
   - Identity payload: field type validation
   - Identity payload: invalid cases (wrong protocol, bad key, etc.)
   - Service payload: all required fields
   - Service payload: pricing validation
   - Revocation payload: validation

3. **OP_RETURN Script Tests**
   - Correct format: `OP_FALSE OP_RETURN <push> <push>`
   - Protocol prefix encoding
   - JSON payload encoding
   - Script parsing (legacy vs collapsed chunk format)

4. **Transaction Chain Tests**
   - Single tx with mined parent
   - Chain of 2+ unconfirmed txs
   - Chain validation (no gaps)

5. **Server Response Tests**
   - Success with admitted outputs
   - Success with zero admits (rejection)
   - Error responses

### Integration Tests

1. **Mock Server Tests**
   - Spin up local overlay-express instance
   - Test full submission flow
   - Verify database state

2. **End-to-End Scenarios**
   - Fresh wallet → register → advertise → unregister
   - Multiple sequential transactions (change reuse)
   - Error recovery

## Implementation Steps

### Phase 1: Fix Core Issues
1. ✅ Fix BEEF ancestry in `buildRealOverlayTransaction()`
2. ✅ Add `identity-revocation` support to server
3. ⬜ Validate server response `outputsToAdmit`
4. ⬜ Improve error messages

### Phase 2: Comprehensive Tests
1. ⬜ Create test utilities mirroring server logic
2. ⬜ Implement all unit tests
3. ⬜ Add integration test infrastructure
4. ⬜ Document test coverage

### Phase 3: Code Quality
1. ⬜ TypeScript strict mode compliance
2. ⬜ Proper error types
3. ⬜ Logging improvements
4. ⬜ Code documentation

## File Structure

```
src/test/
├── overlay-submit.test.ts      # Unit tests for submission
├── beef-construction.test.ts   # BEEF format tests
├── payload-validation.test.ts  # Payload validation tests
├── server-mock.test.ts         # Mock server integration
└── utils/
    ├── server-logic.ts         # Server validation logic (mirrored)
    └── test-helpers.ts         # Common test utilities
```

## Success Criteria

1. All unit tests pass
2. BEEF correctly constructed for all scenarios
3. Server response properly validated
4. Clear error messages for failures
5. Zero false positives (successful return when server rejects)
