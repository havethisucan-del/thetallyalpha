/**
 * Fallbacks for browser APIs that only exist in secure contexts (https or localhost).
 * `pnpm dev:lan` serves plain http on a LAN address, where `crypto.randomUUID` and
 * `navigator.clipboard` are undefined (ADR-0013). `crypto.getRandomValues` works everywhere.
 */

type UuidCrypto = Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string };

/** RFC 4122 version 4 UUID; uses `crypto.randomUUID` when available. */
export function randomUuid(source: UuidCrypto = globalThis.crypto): string {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface ClipboardNavigator {
  clipboard?: Pick<Clipboard, 'writeText'> | undefined;
}

/**
 * The async Clipboard API, or null where the browser does not expose it (insecure context).
 * `nav` is null when there is no navigator at all (non-browser runtimes).
 */
export function clipboardWriter(
  nav: ClipboardNavigator | null = typeof navigator === 'undefined' ? null : navigator,
): ((text: string) => Promise<void>) | null {
  const clipboard = nav?.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') return null;
  return (text) => clipboard.writeText(text);
}
