/**
 * JSON output helpers for CLI commands.
 * All CLI output follows the { success, data/error } wrapper format.
 */
/**
 * Output a successful result and exit.
 */
export declare function ok<T>(data: T): never;
/**
 * Output an error and exit.
 */
export declare function fail(error: string | Error): never;
