import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

// Track background process for proper lifecycle management
let backgroundProcess: ChildProcess | null = null;
let serviceRunning = false;

// Confirmation tokens for destructive actions — maps token → { action, details, expiresAt }
const pendingConfirmations: Map<string, { action: string; details: any; expiresAt: number }> = new Map();

// Auto-import tracking
let autoImportInterval: any = null;
let knownTxids: Set<string> = new Set();

// Budget tracking
const BUDGET_FILE = 'daily-spending.json';

interface DailySpending {
  date: string; // YYYY-MM-DD
  totalSats: number;
  transactions: Array<{ ts: number; sats: number; service: string; provider: string }>;
}

function getBudgetPath(walletDir: string): string {
  return path.join(walletDir, BUDGET_FILE);
}

function loadDailySpending(walletDir: string): DailySpending {
  const today = new Date().toISOString().slice(0, 10);
  const budgetPath = getBudgetPath(walletDir);
  try {
    const data = JSON.parse(fs.readFileSync(budgetPath, 'utf-8'));
    if (data.date === today) return data;
  } catch {
    // Ignore parse errors - return fresh daily spending for corrupted/missing file
  }
  return { date: today, totalSats: 0, transactions: [] };
}

function writeActivityEvent(event) {
  const alertDir = path.join(process.env.HOME || '', '.clawdbot', 'bsv-overlay');
  try {
    fs.mkdirSync(alertDir, { recursive: true });
    fs.appendFileSync(path.join(alertDir, 'activity-feed.jsonl'), JSON.stringify({ ...event, ts: Date.now() }) + '\n');
  } catch {}
}

function recordSpend(walletDir: string, sats: number, service: string, provider: string) {
  const spending = loadDailySpending(walletDir);
  spending.totalSats += sats;
  spending.transactions.push({ ts: Date.now(), sats, service, provider });
  fs.writeFileSync(getBudgetPath(walletDir), JSON.stringify(spending, null, 2));
}

function checkBudget(walletDir: string, requestedSats: number, dailyLimit: number): { allowed: boolean; remaining: number; spent: number } {
  const spending = loadDailySpending(walletDir);
  const remaining = dailyLimit - spending.totalSats;
  return {
    allowed: remaining >= requestedSats,
    remaining,
    spent: spending.totalSats
  };
}

async function startAutoImport(env, cliPath, logger) {
  // Get our address
  try {
    const addrResult = await execFileAsync('node', [cliPath, 'address'], { env });
    const addrOutput = parseCliOutput(addrResult.stdout);
    if (!addrOutput.success) return;
    const address = addrOutput.data?.address;
    if (!address) return;
    
    // Load known txids from wallet state
    const balResult = await execFileAsync('node', [cliPath, 'balance'], { env });
    const balOutput = parseCliOutput(balResult.stdout);
    // Track what we already have
    
    autoImportInterval = setInterval(async () => {
      try {
        const network = env.BSV_NETWORK === 'testnet' ? 'test' : 'main';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/address/${address}/unspent`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) return;
        const utxos = await resp.json();
        
        for (const utxo of utxos) {
          const key = `${utxo.tx_hash}:${utxo.tx_pos}`;
          if (knownTxids.has(key)) continue;
          if (utxo.value < 200) continue; // skip dust
          
          logger?.info?.(`[bsv-overlay] Auto-importing UTXO: ${utxo.tx_hash}:${utxo.tx_pos} (${utxo.value} sats)`);
          try {
            const importResult = await execFileAsync('node', [cliPath, 'import', utxo.tx_hash, String(utxo.tx_pos)], { env });
            const importOutput = parseCliOutput(importResult.stdout);
            if (importOutput.success) {
              knownTxids.add(key);
              logger?.info?.(`[bsv-overlay] Auto-imported ${utxo.value} sats from ${utxo.tx_hash}`);
              
              // Check if registered, auto-register if not
              try {
                const regPath = path.join(process.env.HOME || '', '.clawdbot', 'bsv-overlay', 'registration.json');
                if (!fs.existsSync(regPath)) {
                  logger?.info?.('[bsv-overlay] Not yet registered — auto-registering...');
                  const regResult = await execFileAsync('node', [cliPath, 'register'], { env, timeout: 60000 });
                  const regOutput = parseCliOutput(regResult.stdout);
                  if (regOutput.success) {
                    logger?.info?.('[bsv-overlay] Auto-registered on overlay network!');
                  }
                }
              } catch (err) {
                logger?.warn?.('[bsv-overlay] Auto-registration failed:', err.message);
              }
            }
          } catch (err) {
            // Already imported or error — track it so we don't retry
            knownTxids.add(key);
          }
        }
      } catch (err) {
        // WoC API error — just skip this cycle
      }
    }, 60000); // Check every 60 seconds
  } catch (err) {
    logger?.warn?.('[bsv-overlay] Auto-import setup failed:', err.message);
  }
}

function stopAutoImport() {
  if (autoImportInterval) {
    clearInterval(autoImportInterval);
    autoImportInterval = null;
  }
}

// Auto-enable hooks in Clawdbot config if not already configured.
// Returns true if config was modified (gateway restart needed to activate).
function autoEnableHooks(api: any): boolean {
  try {
    const configPaths = [
      path.join(process.env.HOME || '', '.clawdbot', 'clawdbot.json'),
      path.join(process.env.HOME || '', '.openclaw', 'openclaw.json'),
    ];

    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue;

      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);

      // Check if hooks are already enabled with a token
      if (config?.hooks?.enabled && config?.hooks?.token) {
        api?.log?.debug?.('[bsv-overlay] Hooks already configured.');
        return false;
      }

      // Generate a random token
      const tokenBytes = new Uint8Array(24);
      for (let i = 0; i < 24; i++) tokenBytes[i] = Math.floor(Math.random() * 256);
      const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

      // Merge hooks config — preserve existing hooks.internal etc.
      config.hooks = {
        ...config.hooks,
        enabled: true,
        token: config.hooks?.token || token,
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      api?.log?.info?.(`[bsv-overlay] Auto-enabled hooks in config (${configPath}). Gateway restart needed to activate.`);
      return true;
    }
  } catch (err: any) {
    api?.log?.warn?.(`[bsv-overlay] Failed to auto-enable hooks: ${err.message}`);
  }
  return false;
}

// Discover the gateway HTTP port from environment
function getGatewayPort(): string {
  return process.env.CLAWDBOT_GATEWAY_PORT || process.env.OPENCLAW_GATEWAY_PORT || '18789';
}

// Read tokens from env vars or config files.
// Returns { hooksToken, gatewayToken } — hooksToken is preferred for HTTP wake.
function getTokens(): { hooksToken: string | null; gatewayToken: string | null } {
  let hooksToken: string | null = process.env.CLAWDBOT_HOOKS_TOKEN || process.env.OPENCLAW_HOOKS_TOKEN || null;
  let gatewayToken: string | null = process.env.CLAWDBOT_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || null;

  try {
    const configPaths = [
      path.join(process.env.HOME || '', '.openclaw', 'openclaw.json'),
      path.join(process.env.HOME || '', '.clawdbot', 'clawdbot.json'),
    ];
    for (const p of configPaths) {
      if (!fs.existsSync(p)) continue;
      const config = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!hooksToken) hooksToken = config?.hooks?.token || null;
      if (!gatewayToken) gatewayToken = config?.gateway?.auth?.token || null;
      if (hooksToken && gatewayToken) break;
    }
  } catch {}
  return { hooksToken, gatewayToken };
}

// Wake the agent via /hooks/agent — runs an isolated agent turn with the
// message as the actual prompt, so the agent sees the request and can act.
// NOTE: /hooks/wake only triggers a heartbeat (reads HEARTBEAT.md) which
// won't surface the overlay request to the agent. /hooks/agent is required.
function wakeAgent(text: string, logger?: any, opts?: { sessionKey?: string }) {
  const { hooksToken, gatewayToken } = getTokens();
  const port = getGatewayPort();
  const httpToken = hooksToken || gatewayToken;

  if (!httpToken) {
    logger?.warn?.('[bsv-overlay] No gateway/hooks token available — cannot invoke agent');
    return;
  }

  const url = `http://127.0.0.1:${port}/hooks/agent`;
  const sessionKey = opts?.sessionKey || `hook:bsv-overlay:${Date.now()}`;

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${httpToken}`,
      'x-clawdbot-token': httpToken,
    },
    body: JSON.stringify({
      message: text,
      name: 'BSV Overlay',
      sessionKey,
      wakeMode: 'now',
      deliver: true,
      channel: 'last',
    }),
  })
    .then(async (res) => {
      if (res.ok) {
        logger?.info?.(`[bsv-overlay] Agent invoked via /hooks/agent (session: ${sessionKey})`);
      } else {
        const body = await res.text().catch(() => '');
        logger?.warn?.(`[bsv-overlay] /hooks/agent failed: ${res.status} ${body}`);
      }
    })
    .catch((err) => {
      logger?.warn?.('[bsv-overlay] /hooks/agent error:', err.message);
    });
}

// NOTE: WebSocket wake fallback removed — it used cron.wake which triggers
// a heartbeat (same problem as /hooks/wake). /hooks/agent is the correct
// approach for invoking the agent with a specific prompt.

// Categorize WebSocket events into notification types
function categorizeEvent(event) {
  const base = { ts: Date.now(), from: event.from?.slice(0, 16), fullFrom: event.from };
  
  // 💰 Incoming payment — someone paid us for a service
  if (event.action === 'queued-for-agent' && event.satoshisReceived) {
    return { ...base, type: 'incoming_payment', emoji: '💰', serviceId: event.serviceId, sats: event.satoshisReceived, requestId: event.id, message: `Received ${event.satoshisReceived} sats for ${event.serviceId}` };
  }
  if (event.action === 'fulfilled' && event.satoshisReceived) {
    return { ...base, type: 'incoming_payment', emoji: '💰', serviceId: event.serviceId, sats: event.satoshisReceived, message: `Received ${event.satoshisReceived} sats for ${event.serviceId} (auto-fulfilled)` };
  }
  
  // 📬 Response received — a service we requested came back
  // Fields come directly from the CLI event, not nested under .payload
  if (event.type === 'service-response' && event.action === 'received') {
    return {
      ...base, type: 'response_received', emoji: '📬',
      serviceId: event.serviceId, status: event.status,
      result: event.result, requestId: event.requestId,
      formatted: event.formatted,
      message: event.formatted || `Response received for ${event.serviceId}: ${event.status}`,
    };
  }
  
  // ❌ Request rejected
  if (event.action === 'rejected' && event.serviceId) {
    return { ...base, type: 'request_rejected', emoji: '❌', serviceId: event.serviceId, reason: event.reason, message: `Rejected ${event.serviceId} request: ${event.reason}` };
  }
  
  // Skip pings/pongs and other noise
  return null;
}

function startBackgroundService(env, cliPath, logger) {
  if (backgroundProcess) return;
  serviceRunning = true;
  
  function spawnConnect() {
    if (!serviceRunning) return;
    
    const proc = spawn('node', [cliPath, 'connect'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    backgroundProcess = proc;
    
    proc.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          logger?.debug?.(`[bsv-overlay] ${event.event || event.type || 'message'}:`, JSON.stringify(event).slice(0, 200));
          
          const alertDir = path.join(process.env.HOME || '', '.clawdbot', 'bsv-overlay');
          fs.mkdirSync(alertDir, { recursive: true });
          
          // Detect queued-for-agent events — invoke agent via /hooks/agent
          // This is the PROVIDER side: someone requested our service
          if (event.action === 'queued-for-agent' && event.serviceId) {
            logger?.info?.(`[bsv-overlay] ⚡ Incoming ${event.serviceId} request from ${event.from?.slice(0, 12)}...`);
            const wakeText = `⚡ Incoming overlay service request!\n\nService: ${event.serviceId}\nFrom: ${event.from}\nPaid: ${event.satoshisReceived || '?'} sats\n\nFulfill it now:\n1. overlay({ action: "pending-requests" })\n2. Process the ${event.serviceId} request using your capabilities\n3. overlay({ action: "fulfill", requestId: "${event.id}", recipientKey: "${event.from}", serviceId: "${event.serviceId}", result: { ... } })`;
            wakeAgent(wakeText, logger, { sessionKey: `hook:bsv-overlay:${event.id || Date.now()}` });
          }
          
          // Detect service-response events — invoke agent to notify user
          // This is the REQUESTER side: we requested a service, response came back
          if (event.type === 'service-response' && event.action === 'received') {
            const svcId = event.serviceId || 'unknown';
            const status = event.status || 'unknown';
            const from = event.from || 'unknown';
            const formatted = event.formatted || '';
            const resultJson = event.result ? JSON.stringify(event.result, null, 2) : '(no result data)';
            
            logger?.info?.(`[bsv-overlay] 📬 Response received for ${svcId} from ${from?.slice(0, 12)}... — status: ${status}`);
            const wakeText = `📬 Overlay service response received!\n\nService: ${svcId}\nFrom: ${from}\nStatus: ${status}\n${formatted ? `\nSummary: ${formatted}` : ''}\n\nFull result:\n${resultJson}\n\nNotify the user of this response in a clear, human-readable format.`;
            wakeAgent(wakeText, logger, { sessionKey: `hook:bsv-overlay:resp-${event.requestId || Date.now()}` });
          }
          
          // Write payment/activity notifications for ALL significant events
          const notifEvent = categorizeEvent(event);
          if (notifEvent) {
            try {
              fs.appendFileSync(path.join(alertDir, 'activity-feed.jsonl'), JSON.stringify(notifEvent) + '\n');
            } catch {}
          }
        } catch {}
      }
    });
    
    proc.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'connected') {
            logger?.info?.('[bsv-overlay] WebSocket relay connected');
          } else if (event.event === 'disconnected') {
            logger?.warn?.('[bsv-overlay] WebSocket disconnected, reconnecting...');
          }
        } catch {
          logger?.debug?.(`[bsv-overlay] ${line}`);
        }
      }
    });
    
    proc.on('exit', (code) => {
      backgroundProcess = null;
      if (serviceRunning) {
        logger?.warn?.(`[bsv-overlay] Background service exited (code ${code}), restarting in 5s...`);
        setTimeout(spawnConnect, 5000);
      }
    });
  }
  
  spawnConnect();
}

function stopBackgroundService() {
  serviceRunning = false;
  if (backgroundProcess) {
    backgroundProcess.kill('SIGTERM');
    backgroundProcess = null;
  }
  stopAutoImport();
}

export default function register(api) {
  // Capture config at registration time (api.getConfig may not be available later)
  const pluginConfig = api.getConfig?.()?.plugins?.entries?.['bsv-overlay']?.config || api.config || {};

  // Register the overlay agent tool
  api.registerTool({
    name: "overlay",
    description: "Access the BSV agent marketplace - discover agents and exchange BSV micropayments for services",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "request", "discover", "balance", "status", "pay", 
            "setup", "address", "import", "register", "advertise", 
            "readvertise", "remove", "send", "inbox", "services", "refund",
            "onboard", "pending-requests", "fulfill",
            "unregister", "remove-service"
          ],
          description: "Action to perform"
        },
        service: {
          type: "string",
          description: "Service ID for request/discover"
        },
        input: {
          type: "object",
          description: "Service-specific input data"
        },
        maxPrice: {
          type: "number",
          description: "Max sats willing to pay"
        },
        identityKey: {
          type: "string",
          description: "Target agent key for direct pay/send"
        },
        sats: {
          type: "number",
          description: "Amount for direct pay"
        },
        description: {
          type: "string"
        },
        agent: {
          type: "string",
          description: "Agent name filter for discover"
        },
        // Import parameters
        txid: {
          type: "string",
          description: "Transaction ID for import"
        },
        vout: {
          type: "number",
          description: "Output index for import (optional)"
        },
        // Service management parameters
        serviceId: {
          type: "string",
          description: "Service ID for advertise/readvertise/remove"
        },
        name: {
          type: "string",
          description: "Service name for advertise/readvertise"
        },
        priceSats: {
          type: "number",
          description: "Price in satoshis for advertise"
        },
        newPrice: {
          type: "number",
          description: "New price for readvertise"
        },
        newName: {
          type: "string",
          description: "New name for readvertise (optional)"
        },
        newDesc: {
          type: "string",
          description: "New description for readvertise (optional)"
        },
        // Messaging parameters
        messageType: {
          type: "string",
          description: "Message type for send"
        },
        payload: {
          type: "object",
          description: "Message payload for send"
        },
        // Refund parameters
        address: {
          type: "string",
          description: "Destination address for refund"
        },
        // Confirmation token for destructive actions (unregister, remove-service)
        confirmToken: {
          type: "string",
          description: "Confirmation token from a previous preview call — required to execute destructive actions"
        },
        // Fulfill parameters
        requestId: {
          type: "string",
          description: "Request ID for fulfill"
        },
        recipientKey: {
          type: "string",
          description: "Recipient identity key for fulfill"
        },
        result: {
          type: "object",
          description: "Service result for fulfill"
        }
      },
      required: ["action"]
    },
    async execute(id, params) {
      const config = pluginConfig;
      
      try {
        const result = await executeOverlayAction(params, config, api);
        return { 
          content: [{ 
            type: "text", 
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }] 
        };
      } catch (error) {
        return { 
          content: [{ 
            type: "text", 
            text: `Error: ${error.message}` 
          }] 
        };
      }
    }
  });

  // Register background service for WebSocket relay
  api.registerService({
    id: "bsv-overlay-relay",
    start: async () => {
      api.logger.info("Starting BSV overlay WebSocket relay...");
      try {
        const config = pluginConfig;
        const env = buildEnvironment(config);
        const cliPath = path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js');
        
        // Use the improved background service
        startBackgroundService(env, cliPath, api.logger);
        
        // Start auto-import
        startAutoImport(env, cliPath, api.logger);

        api.logger.info("BSV overlay WebSocket relay started");
      } catch (error) {
        api.logger.error(`Failed to start BSV overlay relay: ${error.message}`);
      }
    },
    stop: async () => {
      api.logger.info("Stopping BSV overlay WebSocket relay...");
      stopBackgroundService();
      api.logger.info("BSV overlay WebSocket relay stopped");
    }
  });

  // Register CLI commands
  api.registerCli(({ program }) => {
    const overlay = program.command("overlay").description("BSV Overlay Network commands");
    
    overlay.command("status")
      .description("Show identity, balance, registration, and services")
      .action(async () => {
        try {
          const config = pluginConfig;
          const result = await handleStatus(buildEnvironment(config), path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js'));
          console.log("BSV Overlay Status:");
          console.log("Identity:", result.identity);
          console.log("Balance:", result.balance);
          console.log("Services:", result.services);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
    
    overlay.command("balance")
      .description("Show wallet balance")
      .action(async () => {
        try {
          const config = pluginConfig;
          const result = await handleBalance(buildEnvironment(config), path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js'));
          console.log("Balance:", result);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });

    overlay.command("address")
      .description("Show receive address")
      .action(async () => {
        try {
          const config = pluginConfig;
          const result = await handleAddress(buildEnvironment(config), path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js'));
          console.log("Address:", result);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });

    overlay.command("discover")
      .description("List agents and services on the network")
      .option("--service <type>", "Filter by service type")
      .option("--agent <name>", "Filter by agent name")
      .action(async (options) => {
        try {
          const config = pluginConfig;
          const result = await handleDiscover(options, buildEnvironment(config), path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js'));
          console.log("Discovery results:");
          console.log(`Overlay URL: ${result.overlayUrl}`);
          console.log(`Agents: ${result.agentCount}, Services: ${result.serviceCount}`);
          if (result.agents?.length > 0) {
            console.log("\nAgents:");
            result.agents.forEach(agent => {
              console.log(`  ${agent.agentName} (${agent.identityKey})`);
            });
          }
          if (result.services?.length > 0) {
            console.log("\nServices:");
            result.services.forEach(service => {
              console.log(`  ${service.serviceId} - ${service.name} (${service.pricing?.amountSats || 0} sats) by ${service.agentName}`);
            });
          }
        } catch (error) {
          console.error("Error:", error.message);
        }
      });

    overlay.command("services")
      .description("List our advertised services")
      .action(async () => {
        try {
          const config = pluginConfig;
          const result = await handleServices(buildEnvironment(config), path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js'));
          console.log("Our services:", result);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
    
    overlay.command("setup")
      .description("Run initial wallet setup")
      .action(async () => {
        try {
          const config = pluginConfig;
          const env = buildEnvironment(config);
          const cliPath = path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js');
          
          const result = await execFileAsync('node', [cliPath, 'setup'], { env });
          const output = parseCliOutput(result.stdout);
          console.log("Setup result:", output);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
    
    overlay.command("register")
      .description("Register with the overlay network")
      .action(async () => {
        try {
          const config = pluginConfig;
          const env = buildEnvironment(config);
          const cliPath = path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js');
          
          const result = await execFileAsync('node', [cliPath, 'register'], { env });
          const output = parseCliOutput(result.stdout);
          console.log("Registration result:", output);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
  }, { commands: ["overlay"] });

  // ---------------------------------------------------------------------------
  // Auto-setup + onboarding (best-effort, non-fatal, fire-and-forget)
  // ---------------------------------------------------------------------------
  (async () => {
    try {
      const config = pluginConfig;
      const walletDir = config?.walletDir || path.join(process.env.HOME || '', '.clawdbot', 'bsv-wallet');
      const identityFile = path.join(walletDir, 'wallet-identity.json');
      const env = buildEnvironment(config || {});
      const cliPath = path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js');

      // Step 0: Auto-enable hooks if not configured
      // The plugin needs hooks.enabled + hooks.token for async wake-ups via /hooks/agent
      const hooksAutoConfigured = autoEnableHooks(api);

      // Step 1: Create wallet if missing
      let walletJustCreated = false;
      if (!fs.existsSync(identityFile)) {
        api.log?.info?.('[bsv-overlay] No wallet found — running auto-setup...');
        await execFileAsync('node', [cliPath, 'setup'], { env });
        api.log?.info?.('[bsv-overlay] Wallet initialized.');
        walletJustCreated = true;
      }

      // Step 2: Get wallet address for onboarding message
      let walletAddress = '';
      try {
        const addrResult = await execFileAsync('node', [cliPath, 'address'], { env });
        const addrOutput = parseCliOutput(addrResult.stdout);
        walletAddress = addrOutput?.data?.address || '';
      } catch {}

      // Step 3: Check registration and balance state
      const regPath = path.join(process.env.HOME || '', '.clawdbot', 'bsv-overlay', 'registration.json');
      const isRegistered = fs.existsSync(regPath);
      let balance = 0;
      try {
        const balResult = await execFileAsync('node', [cliPath, 'balance'], { env });
        const balOutput = parseCliOutput(balResult.stdout);
        balance = balOutput?.data?.walletBalance || 0;
      } catch {}

      // Step 4: If funded and not registered → auto-register
      if (!isRegistered && balance >= 1000) {
        api.log?.info?.('[bsv-overlay] Wallet funded but not registered — auto-registering...');
        const regResult = await execFileAsync('node', [cliPath, 'register'], { env, timeout: 60000 });
        const regOutput = parseCliOutput(regResult.stdout);
        if (regOutput.success) {
          api.log?.info?.('[bsv-overlay] Auto-registered on overlay network!');
          const wakeText = `🎉 **BSV Overlay: Registered on the network!**\n\nNotify the user that their agent is now live on the OpenClaw Overlay Network.\n\nNext steps to present to the user:\n1. **Choose an agent name**: Current name is "${env.AGENT_NAME}". To change it, set \`agentName\` in the plugin config and re-register.\n2. **Advertise services**: Ask the user which services they want to offer. Use overlay({ action: "services" }) to see current services, and overlay({ action: "advertise", ... }) to add new ones.\n\nAvailable service types include: code-review, web-research, translate, tell-joke, roulette, and custom services.`;
          wakeAgent(wakeText, api.log);
          return; // Registered — done with onboarding
        }
      }

      // Step 5: If already registered, nothing to onboard
      if (isRegistered) return;

      // Step 6: Not registered + not funded → send onboarding message
      // This runs on first startup after plugin install (wallet just created or exists but empty)
      const needsRestart = hooksAutoConfigured;
      let onboardingMsg = `🔌 **BSV Overlay Plugin — Setup**\n\nThe OpenClaw Overlay Network plugin is installed and your BSV wallet has been initialized.\n\n`;

      if (needsRestart) {
        onboardingMsg += `✅ **Hooks auto-configured** — async wake-ups are enabled. A gateway restart is needed to activate them. Run: \`clawdbot daemon restart\` or \`/restart\`\n\n`;
      }

      onboardingMsg += `**To join the network, your wallet needs funding.**\n\n`;
      onboardingMsg += `📬 **Wallet address**: \`${walletAddress}\`\n`;
      onboardingMsg += `💰 **Amount needed**: 1,000–10,000 sats (~$0.05–$0.50)\n\n`;
      onboardingMsg += `Send BSV from any wallet (HandCash, Centbee, etc.) to the address above. After the transaction confirms (~10 min), import it:\n`;
      onboardingMsg += `\`overlay({ action: "import", txid: "<your-txid>" })\`\n\n`;
      onboardingMsg += `Once funded, the plugin will auto-register your agent on the next startup.\n\n`;
      onboardingMsg += `Present this information clearly to the user and help them through the process.`;

      wakeAgent(onboardingMsg, api.log, { sessionKey: 'hook:bsv-overlay:onboarding' });

    } catch (err: any) {
      api.log?.debug?.('[bsv-overlay] Auto-setup/onboarding skipped:', err.message);
    }
  })();
}

async function executeOverlayAction(params, config, api) {
  const { action } = params;
  const env = buildEnvironment(config);
  const cliPath = path.join(__dirname, 'dist', 'scripts', 'overlay-cli.js');

  switch (action) {
    case "request":
      return await handleServiceRequest(params, env, cliPath, config, api);
    
    case "discover":
      return await handleDiscover(params, env, cliPath);
    
    case "balance":
      return await handleBalance(env, cliPath);
    
    case "status":
      return await handleStatus(env, cliPath);
    
    case "pay":
      return await handleDirectPay(params, env, cliPath, config);

    case "setup":
      return await handleSetup(env, cliPath);

    case "address":
      return await handleAddress(env, cliPath);

    case "import":
      return await handleImport(params, env, cliPath);

    case "register":
      return await handleRegister(env, cliPath);

    case "advertise":
      return await handleAdvertise(params, env, cliPath);

    case "readvertise":
      return await handleReadvertise(params, env, cliPath);

    case "remove":
      return await handleRemove(params, env, cliPath);

    case "send":
      return await handleSend(params, env, cliPath);

    case "inbox":
      return await handleInbox(env, cliPath);

    case "services":
      return await handleServices(env, cliPath);

    case "refund":
      return await handleRefund(params, env, cliPath);

    case "onboard":
      return await handleOnboard(env, cliPath);
    
    case "pending-requests":
      return await handlePendingRequests(env, cliPath);
    
    case "activity":
      return handleActivity();
    
    case "fulfill":
      return await handleFulfill(params, env, cliPath);
    
    case "unregister":
      return await handleUnregister(params, env, cliPath);

    case "remove-service":
      return await handleRemoveService(params, env, cliPath);
    
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function handleServiceRequest(params, env, cliPath, config, api) {
  const { service, identityKey: targetKey, input, maxPrice } = params;
  const walletDir = config?.walletDir || path.join(process.env.HOME || '', '.clawdbot', 'bsv-wallet');
  
  if (!service) {
    throw new Error("Service is required for request action");
  }

  // 1. Discover providers for the service
  const discoverResult = await execFileAsync('node', [cliPath, 'discover', '--service', service], { env });
  const discoverOutput = parseCliOutput(discoverResult.stdout);
  
  if (!discoverOutput.success) {
    throw new Error(`Discovery failed: ${discoverOutput.error}`);
  }

  // FIX: Use discoverOutput.data.services instead of treating data as flat array
  const providers = discoverOutput.data.services;
  if (!providers || providers.length === 0) {
    throw new Error(`No providers found for service: ${service}`);
  }

  // 2. Filter out our own identity key
  const identityResult = await execFileAsync('node', [cliPath, 'identity'], { env });
  const identityOutput = parseCliOutput(identityResult.stdout);
  const ourKey = identityOutput.data?.identityKey;
  
  let externalProviders = providers.filter(p => p.identityKey !== ourKey);
  if (externalProviders.length === 0) {
    throw new Error("No external providers available (only found our own services)");
  }

  // 2b. If caller specified a target identityKey, route to that provider specifically
  if (targetKey) {
    const targeted = externalProviders.filter(p => p.identityKey === targetKey);
    if (targeted.length === 0) {
      throw new Error(`Specified provider ${targetKey} not found or is our own key. Available: ${externalProviders.map(p => p.identityKey).join(', ')}`);
    }
    externalProviders = targeted;
  }

  // 3. Sort by price - FIX: Use pricing.amountSats instead of pricingSats
  externalProviders.sort((a, b) => (a.pricing?.amountSats || 0) - (b.pricing?.amountSats || 0));
  
  const bestProvider = externalProviders[0];
  const price = bestProvider.pricing?.amountSats || 0;

  // 4. Check price limits
  const maxAutoPaySats = config.maxAutoPaySats || 200;
  const userMaxPrice = maxPrice || maxAutoPaySats;
  
  if (price > userMaxPrice) {
    throw new Error(`Service price (${price} sats) exceeds limit (${userMaxPrice} sats)`);
  }

  // 5. Check daily budget
  const dailyLimit = config.dailyBudgetSats || 1000;
  const budgetCheck = checkBudget(walletDir, price, dailyLimit);
  if (!budgetCheck.allowed) {
    throw new Error(`Service request would exceed daily budget. Spent: ${budgetCheck.spent} sats, Remaining: ${budgetCheck.remaining} sats, Requested: ${price} sats. Please confirm with user.`);
  }

  api.logger.info(`Requesting service ${service} from ${bestProvider.name} for ${price} sats`);

  // 6. Request the service
  const requestArgs = [cliPath, 'request-service', bestProvider.identityKey, service, price.toString()];
  if (input) {
    requestArgs.push(JSON.stringify(input));
  }
  
  const requestResult = await execFileAsync('node', requestArgs, { env });
  const requestOutput = parseCliOutput(requestResult.stdout);
  
  if (!requestOutput.success) {
    throw new Error(`Service request failed: ${requestOutput.error}`);
  }

  // 7. Return immediately — no polling.
  // The WebSocket background service handles incoming responses
  // asynchronously and wakes the agent via /hooks/agent when a
  // response arrives. This avoids blocking for up to 120s.
  recordSpend(walletDir, price, service, bestProvider.name);
  writeActivityEvent({ type: 'outgoing_payment', emoji: '💸', sats: price, service, provider: bestProvider.name, message: `Paid ${price} sats to ${bestProvider.name} for ${service}` });
  
  return {
    provider: bestProvider.name,
    providerKey: bestProvider.identityKey,
    cost: price,
    status: "sent",
    requestId: requestOutput.data?.messageId,
    message: `Request sent and paid (${price} sats) to ${bestProvider.name}. The response will be delivered asynchronously when the provider fulfills it.`,
  };
}

// ---------------------------------------------------------------------------
// Confirmation-gated destructive actions
// ---------------------------------------------------------------------------

function generateConfirmToken(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanExpiredTokens() {
  const now = Date.now();
  for (const [token, entry] of pendingConfirmations) {
    if (entry.expiresAt < now) pendingConfirmations.delete(token);
  }
}

function validateConfirmToken(token: string, expectedAction: string): { valid: boolean; details?: any; error?: string } {
  cleanExpiredTokens();
  const entry = pendingConfirmations.get(token);
  if (!entry) return { valid: false, error: 'Invalid or expired confirmation token. Run the action without confirmToken first to get a preview and new token.' };
  if (entry.action !== expectedAction) return { valid: false, error: `Token is for action '${entry.action}', not '${expectedAction}'.` };
  pendingConfirmations.delete(token); // one-time use
  return { valid: true, details: entry.details };
}

async function handleUnregister(params, env, cliPath) {
  const { confirmToken } = params;

  // Load current registration to show what will be deleted
  const regPath = path.join(process.env.HOME || '', '.clawdbot', 'bsv-overlay', 'registration.json');
  let registration: any = null;
  try {
    if (fs.existsSync(regPath)) {
      registration = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    }
  } catch {}

  if (!registration) {
    throw new Error('No registration found — agent is not registered on the overlay network.');
  }

  // Load services that will also become orphaned
  const servicesResult = await execFileAsync('node', [cliPath, 'services'], { env });
  const servicesOutput = parseCliOutput(servicesResult.stdout);
  const services = servicesOutput?.data?.services || [];

  // Step 1: No token → preview + generate confirmation token
  if (!confirmToken) {
    const token = generateConfirmToken();
    pendingConfirmations.set(token, {
      action: 'unregister',
      details: { registration, services },
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minute expiry
    });

    return {
      status: 'confirmation_required',
      confirmToken: token,
      warning: '⚠️ DESTRUCTIVE ACTION — This will remove the agent from the overlay network.',
      message: 'You MUST get explicit human confirmation before proceeding. Show the user what will be deleted and ask them to confirm.',
      willDelete: {
        identity: {
          name: registration.name || registration.agentName,
          identityKey: registration.identityKey,
          txid: registration.txid,
          registeredAt: registration.registeredAt || registration.timestamp,
        },
        services: services.map((s: any) => ({
          serviceId: s.serviceId,
          name: s.name,
          priceSats: s.priceSats,
          txid: s.txid,
        })),
        serviceCount: services.length,
      },
      instructions: `To confirm: call overlay({ action: "unregister", confirmToken: "${token}" }). Token expires in 5 minutes.`,
    };
  }

  // Step 2: Token provided → validate and execute
  const validation = validateConfirmToken(confirmToken, 'unregister');
  if (!validation.valid) {
    throw new Error(validation.error!);
  }

  // Execute the unregister via CLI
  const result = await execFileAsync('node', [cliPath, 'unregister'], { env, timeout: 60000 });
  const output = parseCliOutput(result.stdout);

  if (!output.success) {
    throw new Error(`Unregister failed: ${output.error}`);
  }

  writeActivityEvent({
    type: 'agent_unregistered', emoji: '🗑️',
    message: `Agent unregistered from overlay network. Identity and ${services.length} services removed.`,
  });

  return {
    status: 'unregistered',
    message: `Agent has been removed from the overlay network. ${services.length} service(s) are no longer discoverable.`,
    ...output.data,
  };
}

async function handleRemoveService(params, env, cliPath) {
  const { serviceId, confirmToken } = params;

  if (!serviceId) {
    throw new Error('serviceId is required for remove-service action');
  }

  // Load the service details
  const servicesResult = await execFileAsync('node', [cliPath, 'services'], { env });
  const servicesOutput = parseCliOutput(servicesResult.stdout);
  const services = servicesOutput?.data?.services || [];
  const target = services.find((s: any) => s.serviceId === serviceId);

  if (!target) {
    throw new Error(`Service '${serviceId}' not found in local registry. Available: ${services.map((s: any) => s.serviceId).join(', ')}`);
  }

  // Step 1: No token → preview + generate confirmation token
  if (!confirmToken) {
    const token = generateConfirmToken();
    pendingConfirmations.set(token, {
      action: 'remove-service',
      details: { serviceId, target },
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return {
      status: 'confirmation_required',
      confirmToken: token,
      warning: `⚠️ DESTRUCTIVE ACTION — This will remove the '${serviceId}' service from the overlay network.`,
      message: 'You MUST get explicit human confirmation before proceeding. Show the user what will be deleted and ask them to confirm.',
      willDelete: {
        serviceId: target.serviceId,
        name: target.name,
        description: target.description,
        priceSats: target.priceSats,
        txid: target.txid,
        registeredAt: target.registeredAt,
      },
      instructions: `To confirm: call overlay({ action: "remove-service", serviceId: "${serviceId}", confirmToken: "${token}" }). Token expires in 5 minutes.`,
    };
  }

  // Step 2: Token provided → validate and execute
  const validation = validateConfirmToken(confirmToken, 'remove-service');
  if (!validation.valid) {
    throw new Error(validation.error!);
  }

  // Execute the remove via CLI (which now does on-chain deletion)
  const result = await execFileAsync('node', [cliPath, 'remove', serviceId], { env, timeout: 60000 });
  const output = parseCliOutput(result.stdout);

  if (!output.success) {
    throw new Error(`Remove service failed: ${output.error}`);
  }

  writeActivityEvent({
    type: 'service_removed', emoji: '🗑️',
    serviceId, message: `Service '${serviceId}' removed from overlay network.`,
  });

  return {
    status: 'removed',
    message: `Service '${serviceId}' has been removed from the overlay network and is no longer discoverable.`,
    ...output.data,
  };
}

async function handleDiscover(params, env, cliPath) {
  const { service, agent } = params;
  const args = [cliPath, 'discover'];
  
  if (service) {
    args.push('--service', service);
  }
  if (agent) {
    args.push('--agent', agent);
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Discovery failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleBalance(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'balance'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Balance check failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleStatus(env, cliPath) {
  try {
    // Get identity
    const identityResult = await execFileAsync('node', [cliPath, 'identity'], { env });
    const identity = parseCliOutput(identityResult.stdout);
    
    // Get balance
    const balanceResult = await execFileAsync('node', [cliPath, 'balance'], { env });
    const balance = parseCliOutput(balanceResult.stdout);
    
    // Get services
    const servicesResult = await execFileAsync('node', [cliPath, 'services'], { env });
    const services = parseCliOutput(servicesResult.stdout);
    
    return {
      identity: identity.data,
      balance: balance.data,
      services: services.data
    };
  } catch (error) {
    throw new Error(`Status check failed: ${error.message}`);
  }
}

async function handleDirectPay(params, env, cliPath, config) {
  const { identityKey, sats, description } = params;
  const walletDir = config?.walletDir || path.join(process.env.HOME || '', '.clawdbot', 'bsv-wallet');
  
  if (!identityKey || !sats) {
    throw new Error("identityKey and sats are required for pay action");
  }

  // Check daily budget
  const dailyLimit = config?.dailyBudgetSats || 1000;
  const budgetCheck = checkBudget(walletDir, sats, dailyLimit);
  if (!budgetCheck.allowed) {
    throw new Error(`Payment would exceed daily budget. Spent: ${budgetCheck.spent} sats, Remaining: ${budgetCheck.remaining} sats, Requested: ${sats} sats. Please confirm with user.`);
  }
  
  const args = [cliPath, 'pay', identityKey, sats.toString()];
  if (description) {
    args.push(description);
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Payment failed: ${output.error}`);
  }

  // Record the spending
  recordSpend(walletDir, sats, 'direct-payment', identityKey);
  writeActivityEvent({ type: 'outgoing_payment', emoji: '💸', sats, service: 'direct-payment', provider: identityKey?.slice(0, 16), message: `Direct payment: ${sats} sats sent` });
  
  return output.data;
}

async function handleSetup(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'setup'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Setup failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleAddress(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'address'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Address failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleImport(params, env, cliPath) {
  const { txid, vout } = params;
  
  if (!txid) {
    throw new Error("txid is required for import action");
  }
  
  const args = [cliPath, 'import', txid];
  if (vout !== undefined) {
    args.push(vout.toString());
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Import failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleRegister(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'register'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Registration failed: ${output.error}`);
  }
  
  return {
    ...output.data,
    registered: true,
    availableServices: [
      { serviceId: "tell-joke", name: "Random Joke", description: "Get a random joke", suggestedPrice: 5 },
      { serviceId: "code-review", name: "Code Review", description: "Review code for bugs, security, and style", suggestedPrice: 50 },
      { serviceId: "web-research", name: "Web Research", description: "Research a topic using web sources", suggestedPrice: 50 },
      { serviceId: "translate", name: "Translation", description: "Translate text between languages", suggestedPrice: 20 },
      { serviceId: "api-proxy", name: "API Proxy", description: "Proxy requests to public APIs", suggestedPrice: 15 },
      { serviceId: "roulette", name: "Roulette", description: "Casino-style roulette game", suggestedPrice: 10 },
      { serviceId: "memory-store", name: "Memory Store", description: "Key-value storage for agents", suggestedPrice: 10 },
      { serviceId: "code-develop", name: "Code Development", description: "Generate code from requirements", suggestedPrice: 100 }
    ],
    nextStep: "Choose which services to advertise. Call overlay({ action: 'advertise', ... }) for each."
  };
}

async function handleAdvertise(params, env, cliPath) {
  const { serviceId, name, description, priceSats } = params;
  
  if (!serviceId || !name || !description || priceSats === undefined) {
    throw new Error("serviceId, name, description, and priceSats are required for advertise action");
  }
  
  const result = await execFileAsync('node', [cliPath, 'advertise', serviceId, name, description, priceSats.toString()], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Advertise failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleReadvertise(params, env, cliPath) {
  const { serviceId, newPrice, newName, newDesc } = params;
  
  if (!serviceId || newPrice === undefined) {
    throw new Error("serviceId and newPrice are required for readvertise action");
  }
  
  const args = [cliPath, 'readvertise', serviceId, newPrice.toString()];
  if (newName) {
    args.push(newName);
  }
  if (newDesc) {
    args.push(newDesc);
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Readvertise failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleRemove(params, env, cliPath) {
  const { serviceId } = params;
  
  if (!serviceId) {
    throw new Error("serviceId is required for remove action");
  }
  
  const result = await execFileAsync('node', [cliPath, 'remove', serviceId], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Remove failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleSend(params, env, cliPath) {
  const { identityKey, messageType, payload } = params;
  
  if (!identityKey || !messageType || !payload) {
    throw new Error("identityKey, messageType, and payload are required for send action");
  }
  
  const result = await execFileAsync('node', [cliPath, 'send', identityKey, messageType, JSON.stringify(payload)], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Send failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleInbox(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'inbox'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Inbox failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleServices(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'services'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Services failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleRefund(params, env, cliPath) {
  const { address } = params;
  
  if (!address) {
    throw new Error("address is required for refund action");
  }
  
  const result = await execFileAsync('node', [cliPath, 'refund', address], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Refund failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleOnboard(env, cliPath) {
  const steps = [];
  
  // Step 1: Setup wallet
  try {
    const setup = await execFileAsync('node', [cliPath, 'setup'], { env });
    const setupOutput = parseCliOutput(setup.stdout);
    steps.push({ step: 'setup', success: true, identityKey: setupOutput.data?.identityKey });
  } catch (err) {
    steps.push({ step: 'setup', success: false, error: err.message });
    return { steps, nextStep: 'Fix wallet setup error and try again' };
  }
  
  // Step 2: Get address
  try {
    const addr = await execFileAsync('node', [cliPath, 'address'], { env });
    const addrOutput = parseCliOutput(addr.stdout);
    steps.push({ step: 'address', success: true, address: addrOutput.data?.address });
  } catch (err) {
    steps.push({ step: 'address', success: false, error: err.message });
  }
  
  // Step 3: Check balance
  try {
    const bal = await execFileAsync('node', [cliPath, 'balance'], { env });
    const balOutput = parseCliOutput(bal.stdout);
    const balance = balOutput.data?.walletBalance || balOutput.data?.onChain?.confirmed || 0;
    steps.push({ step: 'balance', success: true, balance });
    
    if (balance < 1000) {
      return {
        steps,
        funded: false,
        nextStep: `Fund your wallet with at least 1,000 sats. Send BSV to: ${steps[1]?.address}. Auto-import is running — once funded, run overlay({ action: "onboard" }) again.`
      };
    }
  } catch (err) {
    steps.push({ step: 'balance', success: false, error: err.message });
  }
  
  // Step 4: Register
  try {
    const reg = await execFileAsync('node', [cliPath, 'register'], { env, timeout: 60000 });
    const regOutput = parseCliOutput(reg.stdout);
    steps.push({ step: 'register', success: regOutput.success, data: regOutput.data });
  } catch (err) {
    steps.push({ step: 'register', success: false, error: err.message });
  }
  
  return {
    steps,
    funded: true,
    registered: true,
    availableServices: [
      { serviceId: "tell-joke", name: "Random Joke", description: "Get a random joke", suggestedPrice: 5 },
      { serviceId: "code-review", name: "Code Review", description: "Review code for bugs, security, and style", suggestedPrice: 50 },
      { serviceId: "web-research", name: "Web Research", description: "Research a topic using web sources", suggestedPrice: 50 },
      { serviceId: "translate", name: "Translation", description: "Translate text between languages", suggestedPrice: 20 },
      { serviceId: "api-proxy", name: "API Proxy", description: "Proxy requests to public APIs", suggestedPrice: 15 },
      { serviceId: "roulette", name: "Roulette", description: "Casino-style roulette game", suggestedPrice: 10 },
      { serviceId: "memory-store", name: "Memory Store", description: "Key-value storage for agents", suggestedPrice: 10 },
      { serviceId: "code-develop", name: "Code Development", description: "Generate code from requirements", suggestedPrice: 100 }
    ],
    nextStep: "Choose which services to advertise. Call overlay({ action: 'advertise', ... }) for each.",
    message: 'Onboarding complete! Your agent is registered on the BSV overlay network. The background service will handle incoming requests.'
  };
}

async function handlePendingRequests(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'service-queue'], { env });
  const output = parseCliOutput(result.stdout);
  if (!output.success) throw new Error(`Queue check failed: ${output.error}`);
  
  // Clear the alert file since we're checking now
  const alertPath = path.join(process.env.HOME || '', '.clawdbot', 'bsv-overlay', 'pending-alert.jsonl');
  try { if (fs.existsSync(alertPath)) fs.unlinkSync(alertPath); } catch {}
  
  return output.data;
}

function handleActivity() {
  const feedPath = path.join(process.env.HOME || '', '.clawdbot', 'bsv-overlay', 'activity-feed.jsonl');
  if (!fs.existsSync(feedPath)) return { events: [], count: 0 };
  
  const lines = fs.readFileSync(feedPath, 'utf-8').trim().split('\n').filter(Boolean);
  const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  
  // Clear the feed after reading
  fs.writeFileSync(feedPath, '');
  
  return { events, count: events.length };
}

async function handleFulfill(params, env, cliPath) {
  const { requestId, recipientKey, serviceId, result } = params;
  if (!requestId || !recipientKey || !serviceId || !result) {
    throw new Error("requestId, recipientKey, serviceId, and result are required");
  }
  
  const cliResult = await execFileAsync('node', [
    cliPath, 'respond-service', requestId, recipientKey, serviceId, JSON.stringify(result)
  ], { env });
  const output = parseCliOutput(cliResult.stdout);
  if (!output.success) throw new Error(`Fulfill failed: ${output.error}`);
  
  writeActivityEvent({ type: 'service_fulfilled', emoji: '✅', serviceId, recipientKey: recipientKey?.slice(0, 16), message: `Fulfilled ${serviceId} request — response sent` });
  
  return output.data;
}

function buildEnvironment(config) {
  const env = { ...process.env };
  
  if (config.walletDir) {
    env.BSV_WALLET_DIR = config.walletDir;
  }
  if (config.overlayUrl) {
    env.OVERLAY_URL = config.overlayUrl;
  } else if (!env.OVERLAY_URL) {
    env.OVERLAY_URL = 'https://clawoverlay.com';
  }
  
  // Set defaults
  env.BSV_NETWORK = env.BSV_NETWORK || 'mainnet';
  if (config.agentName) {
    env.AGENT_NAME = config.agentName;
  } else if (!env.AGENT_NAME) {
    env.AGENT_NAME = 'clawdbot-agent';
  }
  if (config.agentDescription) {
    env.AGENT_DESCRIPTION = config.agentDescription;
  }
  env.AGENT_ROUTED = 'true'; // Route service requests through the agent
  
  return env;
}

function parseCliOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Failed to parse CLI output: ${error.message}`);
  }
}

// sleep() removed — no longer needed since polling loop was removed