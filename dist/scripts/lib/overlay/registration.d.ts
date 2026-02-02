/**
 * Overlay registration commands: register, unregister.
 */
/**
 * Register command: register this agent on the overlay network.
 */
export declare function cmdRegister(): Promise<never>;
/**
 * Unregister command: remove local registration (does not delete on-chain records).
 */
export declare function cmdUnregister(): Promise<never>;
