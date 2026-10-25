/**
 * Readable text for any thrown value. Neutralino rejects with plain `{ code, message }` objects
 * rather than Error instances, which would otherwise print as "[object Object]".
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof message === 'string' && message) return typeof code === 'string' ? `${message} (${code})` : message;
    if (typeof code === 'string') return code;
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return String(error);
}
