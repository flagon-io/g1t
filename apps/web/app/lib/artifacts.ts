/** How big an artifact is, as people read sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** When an artifact goes, from now: "expires today", "expires in 13 days". */
export function expiresIn(at: string | null, now: number = Date.now()): string {
  if (!at) return "";
  const ms = Date.parse(at) - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}
