/**
 * Inbox and ack commands.
 */
/**
 * Inbox command: fetch pending messages.
 */
export declare function cmdInbox(args: string[]): Promise<never>;
/**
 * Ack command: acknowledge processed messages.
 */
export declare function cmdAck(messageIds: string[]): Promise<never>;
