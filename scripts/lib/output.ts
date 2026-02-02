/**
 * JSON output helpers for CLI commands.
 * All CLI output follows the { success, data/error } wrapper format.
 */

/**
 * Output a successful result and exit.
 */
export function ok<T>(data: T): never {
  console.log(JSON.stringify({ success: true, data }));
  process.exit(0);
}

/**
 * Output an error and exit.
 */
export function fail(error: string | Error): never {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ success: false, error: message }));
  process.exit(1);
}
