/**
 * The site's footer: the logo, what g1t is and its accounts elsewhere as
 * icons beside a few links worth having, then who makes g1t, and a row of
 * the trust pages with the live status dot, the account, and the legal
 * line. Marketing and signed-out pages show it; the app's account menu
 * has its own rows (components/shell.tsx).
 */
import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import type { User } from "@g1t/contracts";

import { useAsksFirst } from "./analytics-consent";
import { Logo, Mark } from "./logo";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { choose } from "../lib/analytics-consent";
import { COMPANY, MAKER_PRODUCTS, SOCIAL, copyright, listed } from "../lib/legal";
import { type OverallState, STATUS_JSON_URL, STATUS_URL, STATUS_WORDS, type StatusReport, dotClass } from "../lib/status";

/** How long one fetched report is reused across the pages of one visit. */
const STATUS_REUSE_MS = 60_000;
let lastStatus: { report: StatusReport; at: number } | null = null;
let pendingStatus: Promise<StatusReport | null> | null = null;

function fetchStatus(): Promise<StatusReport | null> {
  if (lastStatus && Date.now() - lastStatus.at < STATUS_REUSE_MS) return Promise.resolve(lastStatus.report);
  pendingStatus ??= fetch(STATUS_JSON_URL, { headers: { accept: "application/json" } })
    .then((response) => (response.ok ? (response.json() as Promise<StatusReport>) : null))
    .then((report) => {
      if (report?.overall) lastStatus = { report, at: Date.now() };
      return report?.overall ? report : null;
    })
    // The status page being unreachable only means no dot.
    .catch(() => null)
    .finally(() => {
      pendingStatus = null;
    });
  return pendingStatus;
}

/**
 * The live status, from status.g1t.sh once the page is up (or `when` turns
 * true), so no page waits on it. Kept a minute across pages. Null until it
 * arrives, or if it cannot.
 */
export function useSiteStatus(when = true): StatusReport | null {
  const [report, setReport] = useState<StatusReport | null>(() => lastStatus?.report ?? null);
  useEffect(() => {
    if (!when) return;
    let live = true;
    fetchStatus().then((fresh) => {
      if (live && fresh) setReport(fresh);
    });
    return () => {
      live = false;
    };
  }, [when]);
  return report;
}

/** The coloured dot, with words for screen readers. */
export function StatusDot({ state, className = "" }: { state: OverallState | null; className?: string }) {
  return (
    <span className={`relative inline-flex size-2 shrink-0 ${className}`}>
      {state && state !== "up" && state !== "unknown" && (
        <span aria-hidden className={`absolute inset-0 animate-ping rounded-full opacity-60 ${dotClass(state)}`} />
      )}
      <span aria-hidden className={`relative inline-flex size-2 rounded-full ${dotClass(state)}`} />
      <span className="sr-only">{state ? STATUS_WORDS[state] : "Checking status"}</span>
    </span>
  );
}

/** Where the footer's grid links go. Plain links: some are files or other hosts. */
const FOOTER_LINKS: { title: string; links: [string, string][] }[] = [
  {
    title: "Product",
    links: [
      // Code first, as on the landing page: then Chat, then the agents.
      ["Pull requests", "https://docs.g1t.sh/guides/pull-requests/"],
      ["Deployments", "https://docs.g1t.sh/guides/deployments/"],
      ["Chat", "https://docs.g1t.sh/guides/chat/"],
      ["Bring your own agent", "https://docs.g1t.sh/guides/bring-your-own-agent/"],
      ["Integrations", "https://docs.g1t.sh/guides/integrations/"],
      ["Explore", "/explore"],
      ["Pricing", "/pricing"],
      ["Download", "/download"],
    ],
  },
  {
    title: "Developers",
    links: [
      ["Documentation", "https://docs.g1t.sh/"],
      ["API reference", "https://docs.g1t.sh/reference/api/"],
      ["MCP tools", "https://docs.g1t.sh/reference/mcp/"],
      ["llms.txt", "/llms.txt"],
    ],
  },
  {
    title: "Company",
    links: [
      ["Flagon, Inc.", COMPANY.url],
      ["Support", "/support"],
      ["Security", "/security"],
      ["Status", STATUS_URL],
    ],
  },
  {
    title: "Open source",
    links: [
      ["Source on g1t", "/flagon-io/g1t"],
      ["MIT license", "/flagon-io/g1t/blob/main/LICENSE"],
      ["Run g1t yourself", "https://docs.g1t.sh/guides/self-hosting/"],
    ],
  },
];

/** What the footer says under the logo. */
const TAGLINE = "Where your team and its coding agents ship code.";

/** The icons under it: g1t's accounts elsewhere (lib/legal), then its source. */
const ICON_LINKS: { label: string; url: string; icon: React.ReactNode }[] = [
  ...SOCIAL.map((account) => ({
    label: `g1t on ${account.label}`,
    url: account.url,
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" className="size-4">
        <path d={account.icon.path} />
      </svg>
    ),
  })),
  { label: "Source on g1t", url: "/flagon-io/g1t", icon: <GitBranch aria-hidden className="size-4" /> },
];

/** The footer's first column: the logo, the tagline and the icons. */
function BrandColumn() {
  return (
    <div className="col-span-2 sm:col-span-4 lg:col-span-2 lg:pr-8">
      <Link to="/" aria-label="g1t home" className="inline-flex rounded-sm">
        <Logo />
      </Link>
      <p className="mt-3 max-w-xs text-sm leading-6 text-muted text-balance">{TAGLINE}</p>
      <ul className="mt-4 -ml-2 flex items-center gap-1">
        {ICON_LINKS.map((link) => (
          <li key={link.url}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon-sm">
                  <a href={link.url} aria-label={link.label}>
                    {link.icon}
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{link.label}</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The row's own links, after Status. */
const ROW_LINKS: [string, string][] = [
  ["Support", "/support"],
  ["Policies", "/policies"],
  ["Privacy", "/policies/privacy"],
  ["Security", "/security"],
];

/**
 * Flagon's mark, single-ink, as in Flagon's brand files
 * (flagon-mark-mono.svg): a flagon, its brew a tone of the text colour.
 */
function FlagonMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="11.3 12.3 41 41" fill="none" aria-hidden="true" className={className}>
      <defs>
        <clipPath id="g1t-footer-flagon-body">
          <path d="M19.5 23 L34.5 23 L36.5 46 Q36.7 48 34.3 48 L19.7 48 Q17.3 48 17.5 46 Z" />
        </clipPath>
      </defs>
      <g clipPath="url(#g1t-footer-flagon-body)">
        <path
          d="M13 27 q3.75 -0.7 7.5 0 t7.5 0 t7.5 0 t7.5 0 t7.5 0 L51 52 L13 52 Z"
          fill="currentColor"
          fillOpacity="0.22"
        />
      </g>
      <path
        d="M37 27 L45.5 27 L48.5 30 L48.5 36.5 L45.5 39.5 L38 39.5"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17.5 21 L36.5 21 L38.6 47 Q39 50 36 50 L18 50 Q15 50 15.4 47 Z"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinejoin="round"
      />
      <path d="M17 21 Q16.3 16.3 20 15.6 L33 15.6 Q37.2 16.2 37 21 Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <path d="M36.7 17.1 L39.4 16.1" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="40.3" cy="15.8" r="1.4" fill="currentColor" />
    </svg>
  );
}

/** "g1t is designed, built, and backed by Flagon, Inc., …" */
export function MakerLine() {
  const products = MAKER_PRODUCTS.map((product) => product.name);
  return (
    <p className="text-sm leading-6 text-muted text-balance">
      <Mark tight className="mr-1.5 inline-block h-[0.85em] w-auto align-baseline" />
      <span className="font-semibold text-fg">g1t</span> is designed, built, and backed by{" "}
      <a href={COMPANY.url} className="whitespace-nowrap font-semibold text-fg hover:underline hover:underline-offset-4">
        <FlagonMark className="mr-1 inline-block size-[0.95em] -translate-y-px align-middle" />
        {COMPANY.name}
      </a>
      {products.length > 0 ? `, the people behind ${listed(products)}.` : "."}
    </p>
  );
}

const ROW_LINK = "rounded-sm transition-colors hover:text-fg";

/**
 * Status, the trust pages, the account and the legal line, separated by
 * dots that wrap away cleanly on a phone.
 */
export function LegalRow({ user }: { user: User | null | undefined }) {
  const status = useSiteStatus();
  const asksFirst = useAsksFirst();
  const links = [
    <a key="status" href={STATUS_URL} className={`inline-flex items-center gap-1.5 ${ROW_LINK}`}>
      <StatusDot state={status?.overall.state ?? null} />
      Status
    </a>,
    ...ROW_LINKS.map(([label, to]) => (
      <Link key={to} to={to} className={ROW_LINK}>
        {label}
      </Link>
    )),
    // Where the visitor was asked about the analytics cookie: ask again.
    ...(asksFirst
      ? [
          <button key="consent" type="button" onClick={() => choose(null)} className={ROW_LINK}>
            Cookie choices
          </button>,
        ]
      : []),
  ];
  const account = [
    user ? (
      <Link key="me" to={`/u/${user.username}`} className={`font-medium text-fg/90 ${ROW_LINK}`}>
        {user.username}
      </Link>
    ) : (
      <Link key="login" to="/login" className={ROW_LINK}>
        Sign in
      </Link>
    ),
  ];
  const legal = [
    ...account,
    <span key="copyright" className="text-faint">
      {copyright()}
    </span>,
  ];
  const gap = "gap-x-3";
  const dot = (
    <span aria-hidden className="text-line-strong">
      ·
    </span>
  );
  // Two runs, the links and the legal line, so that on a narrow screen the
  // second starts its own line rather than a line starting with a dot.
  const run = (items: React.ReactNode[]) =>
    items.map((item, index) => (
      <li key={index} className={`flex items-center ${gap}`}>
        {index > 0 && dot}
        {item}
      </li>
    ));
  return (
    <div className={`flex flex-wrap items-center justify-center gap-y-1.5 ${gap} text-[0.8125rem] text-muted`}>
      <ul className={`flex flex-wrap items-center justify-center gap-y-1.5 ${gap}`}>{run(links)}</ul>
      {/* Between the two runs only while they share a line. */}
      <span className="hidden md:inline">{dot}</span>
      <ul className={`flex flex-wrap items-center justify-center gap-y-1.5 ${gap}`}>{run(legal)}</ul>
    </div>
  );
}

export function SiteFooter({ user }: { user: User | null | undefined }) {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-x-8 gap-y-10 px-4 pt-12 pb-10 sm:grid-cols-4 lg:grid-cols-6">
        <BrandColumn />
        {/* The link columns sit in the same grid as the brand column. */}
        <nav aria-label="Footer" className="contents">
          {FOOTER_LINKS.map((group) => (
            <div key={group.title}>
              <p className="text-sm font-medium">{group.title}</p>
              <ul className="mt-3 space-y-2 text-sm text-muted">
                {group.links.map(([label, to]) => (
                  <li key={to}>
                    <a href={to} className="transition-colors hover:text-fg">
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-10 text-center">
          <MakerLine />
          <LegalRow user={user} />
        </div>
      </div>
    </footer>
  );
}
