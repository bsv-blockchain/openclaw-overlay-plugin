#!/usr/bin/env node
/**
 * BSV Overlay CLI - TypeScript Entry Point
 *
 * This is the command dispatcher that routes commands to the appropriate modules.
 * All business logic is in the lib/ modules.
 */

import { fail } from './lib/output.js';

// Wallet commands
import { cmdSetup, cmdIdentity, cmdAddress } from './lib/wallet/setup.js';
import { cmdBalance, cmdImport, cmdRefund } from './lib/wallet/balance.js';

// Overlay registration commands
import { cmdRegister, cmdUnregister } from './lib/overlay/registration.js';

// Service commands
import { cmdServices, cmdAdvertise, cmdRemove, cmdReadvertise } from './lib/overlay/services.js';

// Discovery commands
import { cmdDiscover } from './lib/overlay/discover.js';

// Payment commands
import { cmdPay, cmdVerify, cmdAccept } from './lib/payment/commands.js';

// Messaging commands
import { cmdSend } from './lib/messaging/send.js';
import { cmdInbox, cmdAck } from './lib/messaging/inbox.js';
import { cmdPoll } from './lib/messaging/poll.js';
import { cmdConnect } from './lib/messaging/connect.js';

// Service request/response commands
import { cmdRequestService } from './lib/services/request.js';
import { cmdRespondService, cmdResearchRespond } from './lib/services/respond.js';
import { cmdServiceQueue, cmdResearchQueue } from './lib/services/queue.js';

// X verification commands
import {
  cmdXVerifyStart,
  cmdXVerifyComplete,
  cmdXVerifications,
  cmdXLookup,
  cmdXEngagementQueue,
  cmdXEngagementFulfill,
} from './lib/x-verification/commands.js';

// Baemail commands
import {
  cmdBaemailSetup,
  cmdBaemailConfig,
  cmdBaemailBlock,
  cmdBaemailUnblock,
  cmdBaemailLog,
  cmdBaemailRefund,
} from './lib/baemail/commands.js';

const [, , command, ...args] = process.argv;

async function main() {
  try {
    switch (command) {
      // Wallet
      case 'setup':
        await cmdSetup();
        break;
      case 'identity':
        await cmdIdentity();
        break;
      case 'address':
        await cmdAddress();
        break;
      case 'balance':
        await cmdBalance();
        break;
      case 'import':
        await cmdImport(args[0], args[1]);
        break;
      case 'refund':
        await cmdRefund(args[0]);
        break;

      // Overlay registration
      case 'register':
        await cmdRegister();
        break;
      case 'unregister':
        await cmdUnregister();
        break;

      // Services
      case 'services':
        await cmdServices();
        break;
      case 'advertise':
        await cmdAdvertise(args[0], args[1], args[2], args[3]);
        break;
      case 'remove':
        await cmdRemove(args[0]);
        break;
      case 'readvertise':
        await cmdReadvertise(args[0], args[1], args[2], args.slice(3).join(' ') || undefined);
        break;

      // Discovery
      case 'discover':
        await cmdDiscover(args);
        break;

      // Payments
      case 'pay':
        await cmdPay(args[0], args[1], args.slice(2).join(' ') || undefined);
        break;
      case 'verify':
        await cmdVerify(args[0]);
        break;
      case 'accept':
        await cmdAccept(args[0], args[1], args[2], args[3], args.slice(4).join(' ') || undefined);
        break;

      // Messaging (relay)
      case 'send':
        await cmdSend(args[0], args[1], args[2]);
        break;
      case 'inbox':
        await cmdInbox(args);
        break;
      case 'ack':
        await cmdAck(args);
        break;
      case 'poll':
        await cmdPoll();
        break;
      case 'connect':
        await cmdConnect();
        break;
      case 'request-service':
        await cmdRequestService(args[0], args[1], args[2], args[3]);
        break;
      case 'research-respond':
        await cmdResearchRespond(args[0]);
        break;
      case 'research-queue':
        await cmdResearchQueue();
        break;
      case 'service-queue':
        await cmdServiceQueue();
        break;
      case 'respond-service':
        await cmdRespondService(args[0], args[1], args[2], args.slice(3).join(' '));
        break;

      // X Account Verification
      case 'x-verify-start':
        await cmdXVerifyStart(args[0]);
        break;
      case 'x-verify-complete':
        await cmdXVerifyComplete(args[0]);
        break;
      case 'x-verifications':
        await cmdXVerifications();
        break;
      case 'x-lookup':
        await cmdXLookup(args[0]);
        break;

      // X Engagement Service
      case 'x-engagement-queue':
        await cmdXEngagementQueue();
        break;
      case 'x-engagement-fulfill':
        await cmdXEngagementFulfill(args[0], args[1]);
        break;

      // Baemail Service
      case 'baemail-setup':
        await cmdBaemailSetup(args[0], args[1], args[2], args[3]);
        break;
      case 'baemail-config':
        await cmdBaemailConfig();
        break;
      case 'baemail-block':
        await cmdBaemailBlock(args[0]);
        break;
      case 'baemail-unblock':
        await cmdBaemailUnblock(args[0]);
        break;
      case 'baemail-log':
        await cmdBaemailLog(args[0]);
        break;
      case 'baemail-refund':
        await cmdBaemailRefund(args[0]);
        break;

      default:
        fail(
          `Unknown command: ${command || '(none)'}. Commands: setup, identity, address, balance, import, refund, ` +
            `register, unregister, services, advertise, readvertise, remove, discover, pay, verify, accept, ` +
            `send, inbox, ack, poll, connect, request-service, research-queue, research-respond, ` +
            `service-queue, respond-service, x-verify-start, x-verify-complete, x-verifications, x-lookup, ` +
            `x-engagement-queue, x-engagement-fulfill, baemail-setup, baemail-config, baemail-block, ` +
            `baemail-unblock, baemail-log, baemail-refund`
        );
    }
  } catch (err: any) {
    fail(err.message || String(err));
  }
}

main();
