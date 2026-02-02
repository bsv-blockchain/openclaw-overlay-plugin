/**
 * @a2a-bsv/core — BSVAgentWallet
 *
 * High-level wallet class for AI agent-to-agent BSV payments.
 * Wraps @bsv/wallet-toolbox's Wallet + StorageKnex with a clean,
 * minimal API surface designed for automated agent use.
 */

import { PrivateKey, CachedKeyDeriver } from '@bsv/sdk';
import {
  Wallet,
  WalletStorageManager,
  Services,
  Monitor,
  StorageKnex,
  randomBytesHex,
} from '@bsv/wallet-toolbox';
import type { SetupWallet } from '@bsv/wallet-toolbox';
import knexLib from 'knex';
import * as path from 'node:path';
import * as fs from 'node:fs';

import type {
  WalletConfig,
  WalletIdentity,
  PaymentParams,
  PaymentResult,
  VerifyParams,
  VerifyResult,
  AcceptParams,
  AcceptResult,
} from './types.js';
import { toChain, DEFAULT_TAAL_API_KEYS, DEFAULT_DB_NAME } from './config.js';
import { buildPayment } from './payment.js';
import { verifyPayment, acceptPayment } from './verify.js';

/** Filename for the persisted wallet identity JSON. */
const IDENTITY_FILE = 'wallet-identity.json';

/**
 * BSVAgentWallet — the primary class for agent-to-agent BSV payments.
 *
 * Usage:
 * ```ts
 * // Create a new wallet (generates keys)
 * const wallet = await BSVAgentWallet.create({ network: 'testnet', storageDir: './agent-wallet' });
 *
 * // Load an existing wallet
 * const wallet = await BSVAgentWallet.load({ network: 'testnet', storageDir: './agent-wallet' });
 *
 * // Make a payment
 * const payment = await wallet.createPayment({ to: recipientPubKey, satoshis: 500 });
 *
 * // Verify and accept a payment
 * const verification = wallet.verifyPayment({ beef: payment.beef });
 * if (verification.valid) {
 *   await wallet.acceptPayment({ beef: payment.beef, ...derivationInfo });
 * }
 * ```
 */
export class BSVAgentWallet {
  /** @internal — exposed for advanced operations (e.g. direct internalizeAction) */
  public readonly _setup: SetupWallet;

  private constructor(setup: SetupWallet) {
    this._setup = setup;
  }

  // ---------------------------------------------------------------------------
  // Factory methods
  // ---------------------------------------------------------------------------

  /**
   * Create a new agent wallet. Generates a fresh root key and persists it.
   * The SQLite database and identity file are written to `config.storageDir`.
   */
  static async create(config: WalletConfig): Promise<BSVAgentWallet> {
    // Generate a new root key (or use one provided in config)
    const rootKeyHex = config.rootKeyHex ?? PrivateKey.fromRandom().toHex();
    const rootKey = PrivateKey.fromHex(rootKeyHex);
    const identityKey = rootKey.toPublicKey().toString();

    // Ensure the storage directory exists
    fs.mkdirSync(config.storageDir, { recursive: true });

    // Persist identity for later loading
    const identity: WalletIdentity = {
      rootKeyHex,
      identityKey,
      network: config.network,
    };
    const identityPath = path.join(config.storageDir, IDENTITY_FILE);
    fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf-8');

    // Build the wallet
    const setup = await BSVAgentWallet.buildSetup(config, rootKeyHex);

    return new BSVAgentWallet(setup);
  }

  /**
   * Load an existing agent wallet from its storage directory.
   * Reads the persisted identity file and re-initializes the wallet.
   */
  static async load(config: WalletConfig): Promise<BSVAgentWallet> {
    const identityPath = path.join(config.storageDir, IDENTITY_FILE);
    if (!fs.existsSync(identityPath)) {
      throw new Error(
        `No wallet found at ${config.storageDir}. ` +
        `Use BSVAgentWallet.create() to initialize a new wallet.`
      );
    }

    const identity: WalletIdentity = JSON.parse(
      fs.readFileSync(identityPath, 'utf-8'),
    );

    const rootKeyHex = config.rootKeyHex ?? identity.rootKeyHex;
    const setup = await BSVAgentWallet.buildSetup(config, rootKeyHex);

    return new BSVAgentWallet(setup);
  }

  // ---------------------------------------------------------------------------
  // Wallet lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Get this wallet's public identity key (compressed hex, 33 bytes).
   * This is the key other agents use to send payments to you.
   */
  async getIdentityKey(): Promise<string> {
    return this._setup.identityKey;
  }

  /**
   * Get the wallet's current balance in satoshis.
   *
   * Uses the BRC-100 wallet's balance method which sums spendable outputs
   * in the default basket.
   */
  async getBalance(): Promise<number> {
    return await this._setup.wallet.balance();
  }

  /**
   * Cleanly shut down the wallet, releasing database connections and
   * stopping the background monitor.
   */
  async destroy(): Promise<void> {
    await this._setup.wallet.destroy();
  }

  // ---------------------------------------------------------------------------
  // Payment creation (sender/payer side)
  // ---------------------------------------------------------------------------

  /**
   * Build a BRC-29 payment to another agent.
   *
   * The transaction is created with `noSend: true` — the sender does NOT
   * broadcast it. Instead, the Atomic BEEF and derivation metadata are
   * returned so they can be transmitted to the recipient, who will
   * verify and internalize (broadcast) the payment.
   *
   * @param params.to — Recipient's compressed public key (hex).
   * @param params.satoshis — Amount in satoshis.
   * @param params.description — Optional human-readable note.
   */
  async createPayment(params: PaymentParams): Promise<PaymentResult> {
    return buildPayment(this._setup, params);
  }

  // ---------------------------------------------------------------------------
  // Payment verification & acceptance (receiver/merchant side)
  // ---------------------------------------------------------------------------

  /**
   * Verify an incoming Atomic BEEF payment.
   *
   * This performs structural validation and SPV verification via tx.verify().
   */
  async verifyPayment(params: VerifyParams): Promise<VerifyResult> {
    return await verifyPayment(params);
  }

  /**
   * Accept (internalize) a verified payment into this wallet.
   *
   * Uses the BRC-29 wallet payment protocol to derive the correct key
   * and claim the output. This triggers SPV verification and, if the
   * transaction hasn't been broadcast yet, broadcasts it.
   */
  async acceptPayment(params: AcceptParams): Promise<AcceptResult> {
    return acceptPayment(this._setup, params);
  }

  // ---------------------------------------------------------------------------
  // Access to underlying toolbox objects (for advanced use)
  // ---------------------------------------------------------------------------

  /** Get the underlying wallet-toolbox SetupWallet for advanced operations. */
  getSetup(): SetupWallet {
    return this._setup;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Internal: manually construct a BRC-100 wallet backed by SQLite.
   *
   * We build this by hand instead of using Setup.createWalletSQLite because
   * the toolbox has a bug where its internal randomBytesHex is a stub.
   * We use the same components but wire them up correctly.
   */
  private static async buildSetup(
    config: WalletConfig,
    rootKeyHex: string,
  ): Promise<SetupWallet> {
    const chain = toChain(config.network);
    const taalApiKey = config.taalApiKey ?? DEFAULT_TAAL_API_KEYS[chain];

    const rootKey = PrivateKey.fromHex(rootKeyHex);
    const identityKey = rootKey.toPublicKey().toString();

    // 1. Key derivation
    const keyDeriver = new CachedKeyDeriver(rootKey);

    // 2. Storage manager (empty initially)
    const storage = new WalletStorageManager(identityKey);

    // 3. Network services (ARC broadcasting, chain tracking, etc.)
    const serviceOptions = Services.createDefaultOptions(chain);
    serviceOptions.taalApiKey = taalApiKey;
    const services = new Services(serviceOptions);

    // 4. Background monitor
    const monopts = Monitor.createDefaultWalletMonitorOptions(chain, storage, services);
    const monitor = new Monitor(monopts);
    monitor.addDefaultTasks();

    // 5. The BRC-100 Wallet
    const wallet = new Wallet({ chain, keyDeriver, storage, services, monitor });

    // 6. SQLite storage via knex
    const filePath = path.join(config.storageDir, `${DEFAULT_DB_NAME}.sqlite`);
    const knex = knexLib({
      client: 'sqlite3',
      connection: { filename: filePath },
      useNullAsDefault: true,
    });

    // Fee model: configurable via BSV_FEE_MODEL env var (default: 100 sat/KB)
    const feeModelValue = config.feeModel ?? 
      (process.env.BSV_FEE_MODEL ? parseInt(process.env.BSV_FEE_MODEL, 10) : 100);

    const activeStorage = new StorageKnex({
      chain,
      knex,
      commissionSatoshis: 0,
      commissionPubKeyHex: undefined,
      feeModel: { model: 'sat/kb', value: feeModelValue },
    });

    await activeStorage.migrate(DEFAULT_DB_NAME, randomBytesHex(33));
    await activeStorage.makeAvailable();
    await storage.addWalletStorageProvider(activeStorage);
    await activeStorage.findOrInsertUser(identityKey);

    return {
      rootKey,
      identityKey,
      keyDeriver,
      chain,
      storage,
      services,
      monitor,
      wallet,
    };
  }
}
