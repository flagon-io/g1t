/**
 * The parts of g1t the page lists, and how each is checked. Every address
 * comes from the Worker's vars, so an installation of its own names its own
 * hosts; a part whose address is empty is not part of that installation
 * and is left off the page.
 *
 * Checks go over the public internet, as people reach g1t, so they measure
 * what people see. Billing has no public address of its own, so it is the
 * one part checked through a service binding, when there is one.
 */

/** The Worker's vars that say where things are. */
export type Targets = {
  /** The site: `https://g1t.sh`. */
  SITE_URL: string;
  /** The API: `https://api.g1t.sh`. */
  API_URL: string;
  MCP_URL: string;
  DOCS_URL: string;
  /** Where deployed apps live: `https://g1t.page`. */
  PAGES_URL: string;
  MODELS_URL: string;
  /** A public repository that always exists, `owner/name`, to fetch refs of. */
  PROBE_REPO: string;
  /** The site as browsers reach it, when the checks reach it another way. */
  PUBLIC_SITE_URL?: string;
};

/** One request a check makes, and the answer that means the part works. */
export type Step = {
  url: string;
  headers?: Record<string, string>;
  /** The status that means it works; any 2xx when absent. */
  expect?: number;
};

export type Check =
  | { kind: "http"; steps: Step[] }
  /** Billing, through its binding: reading its price book. */
  | { kind: "billing" }
  /** No check yet: the page says so rather than showing green. */
  | { kind: "none" };

export type ComponentInfo = {
  key: string;
  name: string;
  address: string;
  checks: string;
  /** Whether g1t as a whole is down when this is. */
  core: boolean;
  check: Check;
  /** Slower than this, it counts as degraded; `SLOW_MS` when absent. */
  slowMs?: number;
};

/**
 * The page-speed budget the status page holds the site to: the slower of a
 * public project page and Explore, to the first byte of the answer, from a
 * Cloudflare data centre. docs/PERFORMANCE.md has the targets.
 */
export const SPEED_BUDGET_MS = 800;

/** A token no one holds: the API asks identity about it and refuses it. */
export const NO_TOKEN = `g1t_${"0".repeat(40)}`;

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const trim = (url: string | undefined) => (url ?? "").trim().replace(/\/+$/, "");

/** The parts, in the order the page lists them. */
export function components(vars: Partial<Targets>, billing = true): ComponentInfo[] {
  const site = trim(vars.SITE_URL);
  const api = trim(vars.API_URL);
  const mcp = trim(vars.MCP_URL);
  const docs = trim(vars.DOCS_URL);
  const pages = trim(vars.PAGES_URL);
  const models = trim(vars.MODELS_URL);
  const repo = (vars.PROBE_REPO ?? "").trim();
  // What the page shows as the site's address: where people reach it.
  const shown = host(trim(vars.PUBLIC_SITE_URL) || site);
  const list: (ComponentInfo | null)[] = [
    site
      ? {
          key: "site",
          name: "Website and sign-in",
          address: shown,
          checks: api
            ? "The sign-in page loading, and the account service answering an access token through the API."
            : "The sign-in page loading.",
          core: true,
          check: {
            kind: "http",
            steps: [
              { url: `${site}/login` },
              ...(api ? [{ url: `${api}/v1/user`, headers: { authorization: `Bearer ${NO_TOKEN}` }, expect: 401 }] : []),
            ],
          },
        }
      : null,
    api
      ? {
          key: "api",
          name: "API",
          address: host(api),
          checks: "The API's front page.",
          core: true,
          check: { kind: "http", steps: [{ url: `${api}/` }] },
        }
      : null,
    site && repo
      ? {
          key: "git",
          name: "Git and repositories",
          address: `${shown}/<owner>/<repo>.git`,
          checks: "Listing the branches of a public repository over HTTPS, the first step of every clone.",
          core: true,
          check: { kind: "http", steps: [{ url: `${site}/${repo}.git/info/refs?service=git-upload-pack` }] },
        }
      : null,
    site && repo
      ? {
          key: "speed",
          name: "Page speed",
          address: `${shown}/${repo}`,
          checks: `A public project page and Explore each answering within ${SPEED_BUDGET_MS} ms. Slower counts as degraded.`,
          core: false,
          check: { kind: "http", steps: [{ url: `${site}/${repo}` }, { url: `${site}/explore` }] },
          slowMs: SPEED_BUDGET_MS,
        }
      : null,
    mcp
      ? {
          key: "mcp",
          name: "MCP server",
          address: host(mcp),
          checks: "The MCP server's description.",
          core: false,
          check: { kind: "http", steps: [{ url: `${mcp}/`, headers: { accept: "application/json" } }] },
        }
      : null,
    docs
      ? {
          key: "docs",
          name: "Documentation",
          address: host(docs),
          checks: "The documentation's front page.",
          core: false,
          check: { kind: "http", steps: [{ url: `${docs}/` }] },
        }
      : null,
    pages
      ? {
          key: "deployments",
          name: "Deployments",
          address: `*.${host(pages)}`,
          checks: `${host(pages)} answering. Each deployed app is not checked one by one.`,
          core: false,
          check: { kind: "http", steps: [{ url: `${pages}/` }] },
        }
      : null,
    models
      ? {
          key: "agents",
          name: "Agents' model proxy",
          address: host(models),
          checks: "The proxy agents reach their model through. The model providers behind it are not checked.",
          core: false,
          check: { kind: "http", steps: [{ url: `${models}/` }] },
        }
      : null,
    models
      ? {
          key: "sandboxes",
          name: "Sandboxes",
          address: "Agents, checks, workflows and builds",
          checks: "Starting a sandbox costs money and takes seconds, so it is not checked from here yet.",
          core: false,
          check: { kind: "none" },
        }
      : null,
    billing && site
      ? {
          key: "billing",
          name: "Billing",
          address: `${shown}/<workspace>/-/billing`,
          checks: "The billing service reading its price book. Stripe itself is not checked.",
          core: false,
          check: { kind: "billing" },
        }
      : null,
  ];
  return list.filter((c): c is ComponentInfo => c != null);
}
