/**
 * The most useful one-line description of something that was thrown. viem errors carry a terse
 * `shortMessage` alongside a multi-paragraph `message`; anything else falls back to `message`,
 * then to String(). For `catch (e)` blocks, where `e` is `unknown`.
 */
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const { shortMessage, message } = e as { shortMessage?: unknown; message?: unknown };
    if (typeof shortMessage === 'string' && shortMessage) return shortMessage;
    if (typeof message === 'string' && message) return message;
  }
  return String(e);
}
