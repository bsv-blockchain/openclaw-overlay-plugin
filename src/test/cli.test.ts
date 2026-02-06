/**
 * CLI test suite — tests the compiled CLI as a subprocess.
 *
 * Uses child_process.execFile to invoke `node dist/cli.js <command>`
 * and validates stdout JSON, stderr, and exit codes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');

// Simple test runner (matches project convention — no external framework)
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${name}`);
      console.log(`    ${msg}`);
      failed++;
    }
  })();
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

/**
 * Run a CLI command, returning parsed JSON output and exit code.
 * For commands that fail (exit 1), we catch the error and parse stderr/stdout.
 */
async function runCli(
  args: string[],
  env?: Record<string, string>
): Promise<{ json: any; exitCode: number; stdout: string; stderr: string }> {
  const mergedEnv = { ...process.env, ...env };
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_PATH, ...args], {
      env: mergedEnv,
      timeout: 30000,
    });
    let json: any = null;
    try {
      json = JSON.parse(stdout.trim());
    } catch { /* not JSON */ }
    return { json, exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    const stdout = (err.stdout || '').trim();
    const stderr = (err.stderr || '').trim();
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch { /* not JSON */ }
    return { json, exitCode: err.code ?? 1, stdout, stderr };
  }
}

/**
 * Create a temporary wallet directory for isolated tests.
 */
function makeTmpWalletDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-test-'));
}

async function run() {
  console.log('CLI tests\n');

  // Verify CLI is compiled
  if (!fs.existsSync(CLI_PATH)) {
    console.error(`CLI not found at ${CLI_PATH}. Run "npm run build" first.`);
    process.exit(1);
  }

  // ── Unknown / missing command ─────────────────────────────────────────

  await test('unknown command exits 1 with JSON error', async () => {
    const { json, exitCode } = await runCli(['nonexistent-command']);
    assert(exitCode !== 0, 'should exit with non-zero code');
    assert(json !== null, 'should output JSON');
    assert(json.success === false, 'success should be false');
    assert(typeof json.error === 'string', 'should have error message');
    assert(json.error.includes('Unknown command'), 'error should mention unknown command');
  });

  await test('no command exits 1 with JSON error', async () => {
    const { json, exitCode } = await runCli([]);
    assert(exitCode !== 0, 'should exit with non-zero code');
    assert(json !== null, 'should output JSON');
    assert(json.success === false, 'success should be false');
  });

  // ── Help command ──────────────────────────────────────────────────────

  await test('--help returns JSON with command list', async () => {
    const { json, exitCode } = await runCli(['--help']);
    assert(exitCode === 0, 'should exit 0');
    assert(json !== null, 'should output JSON');
    assert(json.success === true, 'success should be true');
    assert(typeof json.data.commands === 'object', 'should have commands object');
    assert(Array.isArray(json.data.commands.wallet), 'should have wallet commands');
    assert(typeof json.data.usage === 'string', 'should have usage string');
  });

  await test('help returns same as --help', async () => {
    const { json, exitCode } = await runCli(['help']);
    assert(exitCode === 0, 'should exit 0');
    assert(json.success === true, 'success should be true');
    assert(typeof json.data.commands === 'object', 'should have commands');
  });

  // ── Argument validation ───────────────────────────────────────────────

  await test('import without txid fails with usage message', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['import'], { BSV_WALLET_DIR: tmpDir });
      assert(exitCode !== 0, 'should exit non-zero');
      assert(json.success === false, 'success should be false');
      assert(json.error.toLowerCase().includes('usage'), 'should show usage');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('import with invalid txid fails', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['import', 'not-a-txid'], { BSV_WALLET_DIR: tmpDir });
      assert(exitCode !== 0, 'should exit non-zero');
      assert(json.success === false, 'success should be false');
      assert(json.error.includes('Invalid txid'), 'should mention invalid txid');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('refund without address fails with usage', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['refund'], { BSV_WALLET_DIR: tmpDir });
      assert(exitCode !== 0, 'should exit non-zero');
      assert(json.success === false, 'success should be false');
      assert(json.error.toLowerCase().includes('usage'), 'should show usage');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('pay without args fails with usage', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['pay'], { BSV_WALLET_DIR: tmpDir });
      assert(exitCode !== 0, 'should exit non-zero');
      assert(json.success === false, 'success should be false');
      assert(json.error.toLowerCase().includes('usage'), 'should show usage');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('advertise without args fails with usage', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['advertise'], { BSV_WALLET_DIR: tmpDir });
      assert(exitCode !== 0, 'should exit non-zero');
      assert(json.success === false, 'success should be false');
      assert(json.error.toLowerCase().includes('usage'), 'should show usage');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('send without args fails with usage', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['send'], { BSV_WALLET_DIR: tmpDir });
      assert(exitCode !== 0, 'should exit non-zero');
      assert(json.success === false, 'success should be false');
      assert(json.error.toLowerCase().includes('usage'), 'should show usage');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('verify without args fails with usage', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['verify'], { BSV_WALLET_DIR: tmpDir });
      assert(exitCode !== 0, 'should exit non-zero');
      assert(json.success === false, 'success should be false');
      assert(json.error.toLowerCase().includes('usage'), 'should show usage');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('remove without args fails with usage', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['remove'], { BSV_WALLET_DIR: tmpDir });
      assert(exitCode !== 0, 'should exit non-zero');
      assert(json.success === false, 'success should be false');
      assert(json.error.toLowerCase().includes('usage'), 'should show usage');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Wallet-dependent tests (using temp directory) ─────────────────────

  await test('setup creates wallet in temp dir', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      const { json, exitCode } = await runCli(['setup'], {
        BSV_WALLET_DIR: tmpDir,
        BSV_NETWORK: 'mainnet',
      });
      assert(exitCode === 0, `should exit 0, got ${exitCode}: ${json?.error || ''}`);
      assert(json.success === true, 'success should be true');
      assert(typeof json.data.identityKey === 'string', 'should return identity key');
      assert(json.data.identityKey.length === 66, 'identity key should be 66 hex chars');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('setup is idempotent', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      // First setup
      const first = await runCli(['setup'], { BSV_WALLET_DIR: tmpDir, BSV_NETWORK: 'mainnet' });
      assert(first.exitCode === 0, 'first setup should succeed');

      // Second setup — should return same identity
      const second = await runCli(['setup'], { BSV_WALLET_DIR: tmpDir, BSV_NETWORK: 'mainnet' });
      assert(second.exitCode === 0, 'second setup should succeed');
      assert(
        first.json.data.identityKey === second.json.data.identityKey,
        'identity key should be the same across setups'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('identity returns expected shape after setup', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      await runCli(['setup'], { BSV_WALLET_DIR: tmpDir, BSV_NETWORK: 'mainnet' });
      const { json, exitCode } = await runCli(['identity'], {
        BSV_WALLET_DIR: tmpDir,
        BSV_NETWORK: 'mainnet',
      });
      assert(exitCode === 0, 'should exit 0');
      assert(json.success === true, 'success should be true');
      assert(typeof json.data.identityKey === 'string', 'should have identityKey');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('address returns expected shape after setup', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      await runCli(['setup'], { BSV_WALLET_DIR: tmpDir, BSV_NETWORK: 'mainnet' });
      const { json, exitCode } = await runCli(['address'], {
        BSV_WALLET_DIR: tmpDir,
        BSV_NETWORK: 'mainnet',
      });
      assert(exitCode === 0, 'should exit 0');
      assert(json.success === true, 'success should be true');
      assert(typeof json.data.address === 'string', 'should have address');
      assert(json.data.address.length > 20, 'address should be reasonable length');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('balance returns expected shape after setup', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      await runCli(['setup'], { BSV_WALLET_DIR: tmpDir, BSV_NETWORK: 'mainnet' });
      const { json, exitCode } = await runCli(['balance'], {
        BSV_WALLET_DIR: tmpDir,
        BSV_NETWORK: 'mainnet',
      });
      assert(exitCode === 0, 'should exit 0');
      assert(json.success === true, 'success should be true');
      assert(typeof json.data.walletBalance === 'number', 'should have walletBalance');
      assert(json.data.walletBalance === 0, 'fresh wallet should have 0 balance');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('services returns expected shape', async () => {
    const tmpDir = makeTmpWalletDir();
    try {
      await runCli(['setup'], { BSV_WALLET_DIR: tmpDir, BSV_NETWORK: 'mainnet' });
      const { json, exitCode } = await runCli(['services'], {
        BSV_WALLET_DIR: tmpDir,
        BSV_NETWORK: 'mainnet',
      });
      assert(exitCode === 0, 'should exit 0');
      assert(json.success === true, 'success should be true');
      assert(Array.isArray(json.data.services), 'should have services array');
      assert(typeof json.data.count === 'number', 'should have count');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Output format consistency ─────────────────────────────────────────

  await test('all error outputs have { success: false, error: string }', async () => {
    // Test a few known-bad commands
    const badCommands = [
      ['nonexistent'],
      ['import'],
      ['pay'],
      ['send'],
      ['verify'],
    ];
    for (const args of badCommands) {
      const { json } = await runCli(args);
      assert(json !== null, `${args.join(' ')} should produce JSON`);
      assert(json.success === false, `${args.join(' ')} should have success=false`);
      assert(typeof json.error === 'string', `${args.join(' ')} should have error string`);
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────

  console.log(`\nCLI tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run();
