/**
 * Shared network utilities for claude-peers
 */

export function isLoopback(host: string): boolean {
  // Strip brackets ([::1] → ::1)
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "127.0.0.1" || h === "localhost") return true;
  // 127.0.0.0/8 entire range
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // IPv6 loopback
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped IPv6 loopback
  if (h === "::ffff:127.0.0.1" || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(h)) return true;
  return false;
}

export function sanitizeForDisplay(s: string): string {
  // Remove control characters except newline and tab
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
