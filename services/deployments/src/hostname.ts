/**
 * Hostnames people bring for their apps: checked, spelled the one way
 * Cloudflare and browsers agree on (lowercase, punycode), and paired with
 * their www or apex twin.
 *
 * Kept free of imports so its tests run on Node as they are.
 */

/** Domains a custom hostname may never be on: g1t's own. */
const RESERVED = ["g1t.page", "g1t.sh", "g1t.dev"];

/**
 * Public suffixes of more than one label, the common ones. A hostname
 * directly under one of these is an apex (`shop.co.uk`), not a subdomain.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "edu.au", "id.au",
  "co.nz", "net.nz", "org.nz",
  "co.jp", "ne.jp", "or.jp",
  "co.za", "org.za",
  "com.br", "net.br", "org.br",
  "com.mx", "org.mx",
  "com.ar", "com.co", "com.tr", "com.sg", "com.hk", "com.tw", "com.cn", "com.my", "com.ph",
  "co.in", "net.in", "org.in", "co.id", "co.il", "co.kr", "or.kr",
  "com.es", "com.pl", "com.ua",
]);

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export type HostnameCheck = { ok: true; hostname: string } | { ok: false; reason: string };

/**
 * `input` as a hostname g1t can serve: lowercase and punycode, with no
 * scheme, path, port or trailing dot; at least two labels, each a valid
 * label; never a wildcard, an IP address or one of g1t's own domains.
 */
export function checkHostname(input: string): HostnameCheck {
  let text = String(input ?? "").trim().toLowerCase();
  // What people paste: a URL, or a hostname with a path or a trailing dot.
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  if (!text) return { ok: false, reason: "Enter a domain, such as example.com or www.example.com." };
  if (text.includes("*")) return { ok: false, reason: "Wildcard domains are not supported yet; add each hostname on its own." };
  if (/:\d+$/.test(text)) return { ok: false, reason: "Leave out the port: apps are served on 443." };
  if (/[\s@:]/.test(text)) return { ok: false, reason: "That is not a domain." };
  let hostname: string;
  try {
    // The URL parser applies IDNA, so `bücher.example` becomes `xn--bcher-kva.example`.
    hostname = new URL(`http://${text}/`).hostname;
  } catch {
    return { ok: false, reason: "That is not a domain." };
  }
  if (/^\[|^\d+(\.\d+){3}$/.test(hostname)) return { ok: false, reason: "Use a domain name, not an IP address." };
  if (hostname.length > 253) return { ok: false, reason: "That domain is too long." };
  const labels = hostname.split(".");
  if (labels.length < 2) return { ok: false, reason: "Include the domain's ending, such as .com or .io." };
  if (labels.some((label) => !LABEL.test(label))) {
    return { ok: false, reason: "Each part of a domain is 1 to 63 letters, digits or hyphens, and does not start or end with a hyphen." };
  }
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, reason: "That is not a domain." };
  for (const reserved of RESERVED) {
    if (hostname === reserved || hostname.endsWith(`.${reserved}`)) {
      return { ok: false, reason: `${reserved} is g1t's own domain; every app already has an address on it.` };
    }
  }
  return { ok: true, hostname };
}

/** The registrable domain `hostname` is under: `example.com` for `www.example.com`. */
export function apexOf(hostname: string): string {
  const labels = hostname.split(".");
  const two = labels.slice(-2).join(".");
  const keep = MULTI_LABEL_SUFFIXES.has(two) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Whether `hostname` is a registrable domain itself, which DNS cannot point with a CNAME. */
export function isApex(hostname: string): boolean {
  return apexOf(hostname) === hostname;
}

/**
 * The other half of a www/apex pair: `www.example.com` for `example.com`
 * and back. Null for any other subdomain.
 */
export function twinOf(hostname: string): string | null {
  if (isApex(hostname)) return `www.${hostname}`;
  if (hostname.startsWith("www.") && isApex(hostname.slice(4))) return hostname.slice(4);
  return null;
}

/** What a hostname's own record is called in its DNS zone: `@` for the apex, else the part before it. */
export function recordName(hostname: string): string {
  const apex = apexOf(hostname);
  return hostname === apex ? "@" : hostname.slice(0, -apex.length - 1);
}
