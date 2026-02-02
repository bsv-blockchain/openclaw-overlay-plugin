/**
 * Wallet balance commands: balance, import, refund.
 */
/**
 * Balance command: show wallet balance.
 */
export declare function cmdBalance(): Promise<never>;
/**
 * Import command: import external UTXO with merkle proof.
 */
export declare function cmdImport(txidArg: string | undefined, voutStr?: string): Promise<never>;
/**
 * Refund command: sweep wallet to an address.
 */
export declare function cmdRefund(targetAddress: string | undefined): Promise<never>;
