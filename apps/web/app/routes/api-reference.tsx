/**
 * The interactive API reference: Scalar's explorer over g1t's OpenAPI
 * document. It is a standalone page because the explorer brings its own
 * layout.
 */

const CONFIGURATION = {
  theme: "none",
  darkMode: true,
  hideDarkModeToggle: true,
  hideClientButton: true,
  defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
  metaData: { title: "API reference · g1t docs" },
};

// g1t's palette for the explorer.
const STYLES = `
  :root { --scalar-font: "Inter", system-ui, sans-serif; --scalar-font-code: "JetBrains Mono", ui-monospace, monospace; }
  .dark-mode {
    --scalar-background-1: #0e0d0a; --scalar-background-2: #16150f; --scalar-background-3: #1e1c15;
    --scalar-border-color: #2a2820; --scalar-color-1: #f0eee6; --scalar-color-2: #a09c8f; --scalar-color-3: #6e6a5e;
    --scalar-color-accent: #b6f24a; --scalar-background-accent: #b6f24a1f;
    --scalar-button-1: #f0eee6; --scalar-button-1-color: #0e0d0a; --scalar-button-1-hover: #ffffff;
    --scalar-color-green: #b6f24a; --scalar-color-blue: #7cc4ff; --scalar-color-red: #ff7a6b; --scalar-color-orange: #f2c14a;
    --scalar-sidebar-background-1: #0e0d0a; --scalar-sidebar-color-1: #f0eee6; --scalar-sidebar-color-2: #a09c8f;
    --scalar-sidebar-border-color: #2a2820; --scalar-sidebar-item-hover-background: #16150f;
    --scalar-sidebar-item-active-background: #1e1c15; --scalar-sidebar-color-active: #b6f24a;
  }
  .g1t-bar { display: flex; align-items: center; gap: 16px; height: 56px; padding: 0 16px; background: #16150f; border-bottom: 1px solid #2a2820; font: 14px "Inter", system-ui, sans-serif; }
  .g1t-bar a { color: #a09c8f; text-decoration: none; }
  .g1t-bar a:hover { color: #f0eee6; }
  .g1t-bar .brand { font: 600 18px "JetBrains Mono", ui-monospace, monospace; color: #f0eee6; }
  .g1t-bar .brand span { color: #b6f24a; }
`;

export function loader() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API reference · g1t docs</title>
<meta name="description" content="Every g1t API endpoint, with an explorer to call them from the page.">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="canonical" href="https://docs.g1t.sh/api/reference">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>body { margin: 0; background: #0e0d0a; }${STYLES}</style>
</head>
<body>
<header class="g1t-bar">
  <a class="brand" href="https://g1t.sh/">g<span>1</span>t</a>
  <a href="/docs">Docs</a>
  <a href="/docs/api">API overview</a>
  <a href="https://api.g1t.sh/openapi.json">OpenAPI</a>
</header>
<script id="api-reference" data-url="https://api.g1t.sh/openapi.json" data-configuration='${JSON.stringify(CONFIGURATION)}'></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
