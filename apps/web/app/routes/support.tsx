import { ArrowUpRight, BookOpen, CircleAlert, CreditCard, LifeBuoy, Lock, ShieldAlert, Activity, Ticket } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/support";
import { TrustPage } from "../components/trust-page";
import { StatusDot, useSiteStatus } from "../components/footer";
import { CONTACT } from "../lib/legal";
import { page } from "../lib/meta";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "Support · g1t",
    description: "How to get help with g1t: the documentation, the status page, who to write to, and what to include.",
  });
}

const DOCS: [string, string][] = [
  ["Quickstart", "https://docs.g1t.sh/quickstart/"],
  ["g1t agents", "https://docs.g1t.sh/guides/g1t-agents/"],
  ["Git", "https://docs.g1t.sh/guides/git/"],
  ["Accounts and sign-in", "https://docs.g1t.sh/guides/authentication/"],
  ["Usage and billing", "https://docs.g1t.sh/guides/usage-and-billing/"],
  ["Guardrails", "https://docs.g1t.sh/guides/guardrails/"],
  ["API reference", "https://docs.g1t.sh/reference/api/"],
  ["MCP tools", "https://docs.g1t.sh/reference/mcp/"],
];

const MAILBOXES: { icon: ReactNode; title: string; address: string; about: string }[] = [
  {
    icon: <LifeBuoy size={16} />,
    title: "Help with g1t",
    address: CONTACT.support,
    about: "Accounts, workspaces, git, agents, deployments, something that doesn't work, or closing an account.",
  },
  {
    icon: <Ticket size={16} />,
    title: "Invites",
    address: CONTACT.support,
    about: "More invites for you or your workspace while g1t is invite-only. Say who you would like to bring.",
  },
  {
    icon: <CreditCard size={16} />,
    title: "Billing",
    address: CONTACT.billing,
    about: "Charges, invoices, refunds, custom terms and enterprise billing.",
  },
  {
    icon: <ShieldAlert size={16} />,
    title: "Security",
    address: CONTACT.security,
    about: "A vulnerability in g1t. See responsible disclosure on the security page.",
  },
  {
    icon: <Lock size={16} />,
    title: "Privacy",
    address: CONTACT.privacy,
    about: "A copy of your information, deleting it, or a question about how it's used.",
  },
  {
    icon: <CircleAlert size={16} />,
    title: "Report abuse",
    address: CONTACT.abuse,
    about: "Something on g1t that breaks the Acceptable Use Policy: malware, phishing, spam, infringement.",
  },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-14 first:mt-0">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function Support() {
  const status = useSiteStatus();
  return (
    <TrustPage
      eyebrow="Support"
      title="Get help with g1t"
      lede={<p>Most answers are in the documentation. When they aren't, a person at g1t reads every message.</p>}
    >
      <div className="max-w-3xl">
        <div className="grid gap-3 sm:grid-cols-2">
          <a
            href="https://docs.g1t.sh/"
            className="group flex gap-3 rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong hover:bg-raised"
          >
            <BookOpen size={18} className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="flex items-center gap-1 font-medium">
                Read the documentation <ArrowUpRight size={14} className="text-faint group-hover:text-fg" />
              </span>
              <span className="mt-1 block text-sm text-muted">Guides for every part of g1t, and the API and MCP reference.</span>
            </span>
          </a>
          <Link
            to="/status"
            className="group flex gap-3 rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong hover:bg-raised"
          >
            <Activity size={18} className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="flex items-center gap-2 font-medium">
                Check the status <StatusDot state={status?.overall.state ?? null} />
              </span>
              <span className="mt-1 block text-sm text-muted">
                {status ? status.overall.line : "Whether each part of g1t is working right now."}
              </span>
            </span>
          </Link>
        </div>

        <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
          {DOCS.map(([label, href]) => (
            <li key={href}>
              <a href={href} className="hover:text-fg">
                {label}
              </a>
            </li>
          ))}
        </ul>

        <Section title="Write to us">
          {/* One mailbox for now; each topic says what to put in the subject so
              mail can be sorted. Separate addresses can come back in CONTACT. */}
          {new Set(MAILBOXES.map((box) => box.address)).size === 1 && (
            <p className="mb-3 text-sm text-muted">
              Write to{" "}
              <a href={`mailto:${MAILBOXES[0].address}`} className="font-mono text-accent hover:underline">
                {MAILBOXES[0].address}
              </a>{" "}
              and start the subject with the topic below.
            </p>
          )}
          <ul className="divide-y divide-line rounded-xl border border-line">
            {MAILBOXES.map((box) => (
              <li key={box.title} className="flex flex-col gap-1 px-4 py-4 sm:flex-row sm:items-start sm:gap-4">
                <span className="flex shrink-0 items-center gap-2 font-medium sm:w-40">
                  <span className="text-muted">{box.icon}</span>
                  {box.title}
                </span>
                <span className="min-w-0">
                  <a
                    href={`mailto:${box.address}?subject=${encodeURIComponent(`[g1t ${box.title}] `)}`}
                    className="font-mono text-sm text-accent hover:underline"
                  >
                    {new Set(MAILBOXES.map((other) => other.address)).size === 1 ? `Subject: [g1t ${box.title}]` : box.address}
                  </a>
                  <span className="mt-0.5 block text-sm text-muted">{box.about}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-muted">
            Write from the email address on your g1t account, so we know it's you. Found a bug in g1t itself? You can
            also open an issue on <Link to="/flagon-io/g1t/issues" className="text-accent hover:underline">flagon-io/g1t</Link>.
          </p>
        </Section>

        <Section title="What to include">
          <ul className="list-disc space-y-1.5 pl-5 text-[0.9375rem] text-fg/90">
            <li>Your username, and the workspace and project, such as <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.85em]">g1t.sh/acme/web</code>.</li>
            <li>A link to where it happened: the page, issue, pull request, agent run or workflow run.</li>
            <li>What you did, what you expected, and what happened instead, with any error message as text.</li>
            <li>When it happened, with your time zone.</li>
          </ul>
          <p className="mt-4 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-sm">
            <span className="font-medium">Never send a password, an access token, a secret or a card number.</span>{" "}
            <span className="text-muted">
              g1t staff will never ask for them, by email or any other way. If you've sent one, revoke or change it.
            </span>
          </p>
        </Section>

        <Section title="From your workspace">
          <p className="text-[0.9375rem] text-fg/90">
            Owners can ask for two things straight from <span className="font-medium">Settings → Billing and plans</span>, and
            the answer comes back to the same page and by email:
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[0.9375rem] text-fg/90">
            <li>
              <span className="font-medium">Raise my limit</span>, when the workspace needs more than its spend limit allows.
              A person answers within one business day.
            </li>
            <li>
              <span className="font-medium">Spent more than you meant to? Tell us.</span>, when a month ran over by
              accident. See <Link to="/policies/refunds" className="text-accent hover:underline">refunds</Link> for the
              goodwill credit.
            </li>
          </ul>
        </Section>

        <Section title="When you'll hear back">
          <ul className="list-disc space-y-1.5 pl-5 text-[0.9375rem] text-fg/90">
            <li>Help and billing: within one business day.</li>
            <li>Security reports: acknowledged within two business days.</li>
            <li>Privacy requests: within 30 days, usually much sooner.</li>
          </ul>
          <p className="mt-3 text-sm text-muted">
            Business days are Monday to Friday, US time, apart from public holidays. If something seems down, the{" "}
            <Link to="/status" className="text-accent hover:underline">status page</Link> checks every part of g1t each
            minute.
          </p>
        </Section>
      </div>
    </TrustPage>
  );
}
