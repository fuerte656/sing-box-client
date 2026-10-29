/** Fields of a non-Error object thrown or rejected with (Neutralino errors have both). */
interface ErrorLike {
  code?: unknown;
  message?: unknown;
}

/**
 * Readable text for any thrown value. Neutralino rejects with plain `{ code, message }` objects
 * rather than Error instances, which would otherwise print as "[object Object]".
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const { code, message }: ErrorLike = error as ErrorLike;
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
