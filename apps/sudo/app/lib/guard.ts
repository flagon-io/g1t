/**
 * What every sudo response carries, and the page shown to whoever is
 * turned away. No Workers imports, so it can be tested under Node.
 */

/**
 * The pages ship no JavaScript, so no script may run at all; styles and
 * images come only from sudo itself, fonts from Google Fonts, and forms
 * post only back to sudo.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "upgrade-insecure-requests",
].join("; ");

const HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // Same-origin keeps the Referer that the same-origin check falls back on.
  "referrer-policy": "same-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

/** The response with sudo's headers; a policy it already set is kept. */
export function secure(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(HEADERS)) secured.headers.set(name, value);
  if (!secured.headers.has("content-security-policy")) {
    secured.headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  }
  return secured;
}

const DENIED_STYLE = `
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0f11;color:#ededef;
font:15px/1.6 Inter,ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:28rem;padding:2rem 1rem;text-align:center}
.badge{display:inline-block;border:1px solid #b6a8ff66;color:#b6a8ff;background:#b6a8ff1a;border-radius:999px;
padding:.1rem .6rem;font:600 12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em}
h1{margin:1rem 0 .5rem;font-size:1.25rem;letter-spacing:-.01em}
p{margin:0;color:#a0a0a8}code{color:#ededef;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}`;

let styleHash: Promise<string> | null = null;

function hashOfStyle(): Promise<string> {
  styleHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(DENIED_STYLE))
    .then((digest) => btoa(String.fromCharCode(...new Uint8Array(digest))));
  return styleHash;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * A self-contained page for a refusal: its one inline stylesheet is
 * allowed by its hash, and nothing else is.
 */
export async function denied(status: number, title: string, message: string): Promise<Response> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · sudo</title><style>${DENIED_STYLE}</style></head>
<body><main><span class="badge">sudo</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; style-src 'sha256-${await hashOfStyle()}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
  });
}
