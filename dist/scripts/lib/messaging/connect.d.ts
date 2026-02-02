/**
 * Connect command: WebSocket real-time message processing.
 */
/**
 * Connect command: establish WebSocket connection for real-time messaging.
 * Note: This function never returns normally - it runs until SIGINT/SIGTERM.
 */
export declare function cmdConnect(): Promise<void>;
