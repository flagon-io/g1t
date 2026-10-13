/**
 * Who makes g1t, how to reach them, and the policies that govern it: the
 * one place the footer, the policy pages, /security, /support and
 * security.txt read these from.
 */
import { type SimpleIcon, siX } from "simple-icons";

/** The company behind g1t. */
export const COMPANY = {
  name: "Flagon, Inc.",
  url: "https://www.flagon.io",
  /** How the footer describes it. */
  about: "a small, independent software company",
  /** Who founded it, named wherever the company is described. */
  founder: "Chase Pierce",
};

/** g1t's own accounts elsewhere, drawn as their marks in the footer. */
export const SOCIAL: { label: string; url: string; icon: SimpleIcon }[] = [{ label: "X", url: "https://x.com/g1t_sh", icon: siX }];

/**
 * Flagon's other launched products, which the footer's maker line names
 * ("…, the people behind X and Y"). None yet: add each here when it ships.
 */
export const MAKER_PRODUCTS: { name: string; url: string }[] = [];

/** "X", "X and Y", "X, Y and Z". */
export function listed(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The year in UTC, so a page rendered near midnight on 31 December agrees everywhere. */
export function copyrightYear(now: Date = new Date()): number {
  return now.getUTCFullYear();
}

/** The footer's legal line. */
export function copyright(now: Date = new Date()): string {
  return `© ${copyrightYear(now)} ${COMPANY.name} All rights reserved.`;
}

/**
 * Where people reach g1t. Each must be a real, watched mailbox. For now
 * every topic goes to Flagon's one address; give a topic its own address
 * here once the g1t.sh aliases exist.
 */
export const CONTACT = {
  support: "hey@flagon.io",
  security: "hey@flagon.io",
  privacy: "hey@flagon.io",
  billing: "hey@flagon.io",
  abuse: "hey@flagon.io",
  legal: "hey@flagon.io",
};

export type Policy = {
  slug: string;
  title: string;
  summary: string;
};

/** The policies, in the order the index lists them. Each is `/policies/<slug>`. */
export const POLICIES: Policy[] = [
  {
    slug: "terms",
    title: "Terms of Service",
    summary: "The agreement between you and Flagon, Inc. when you use g1t: accounts, your content, agents, paying, and ending.",
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    summary: "What g1t collects, why, where it goes, how long it is kept, and how to see, export or delete it.",
  },
  {
    slug: "acceptable-use",
    title: "Acceptable Use Policy",
    summary: "What g1t may not be used for, from mining cryptocurrency to abuse, and what happens when it is.",
  },
  {
    slug: "refunds",
    title: "Refunds and Cancellation",
    summary: "Ending the plan, accidental overages and goodwill credits, and when money goes back to your card.",
  },
  {
    slug: "subprocessors",
    title: "Subprocessors",
    summary: "The companies that process data for g1t, what each does, and the services you choose to connect.",
  },
];

/**
 * The policies are drafts until g1t's general launch: while this is true,
 * the policies index and every policy page say so at the top
 * (components/policies-draft.tsx). Set it to false to take the note down.
 */
export const POLICIES_DRAFT = true;

/** When any policy last changed, `YYYY-MM-DD`. */
export const POLICIES_UPDATED = "2026-10-13";

/** Every change to the policies, newest first. */
export const POLICY_HISTORY: { date: string; change: string }[] = [
  {
    date: "2026-10-13",
    change:
      "Terms of Service and Privacy Policy: g1t no longer runs agents of its own. Section 6 of the terms covers the coding agents you connect and Ask g1t, which answers with your workspace's own AI provider; agents are no longer billed compute. Subprocessors: your workspace's AI provider listed among the integrations you choose.",
  },
  {
    date: "2026-10-09",
    change:
      "Privacy Policy: g1t.sh uses HeyCatch for site analytics, with names removed outside the public pages, and one analytics cookie, set in the EU, EEA, UK and Switzerland only after you allow it. Subprocessors: HeyCatch, Inc. added.",
  },
  {
    date: "2026-10-06",
    change:
      "Privacy Policy: request logs are kept 7 days, and database history 30 days. Subprocessors: GitHub listed among the integrations you choose, in place of Slack, which g1t does not connect to.",
  },
  {
    date: "2026-10-05",
    change:
      "First published: Terms of Service, Privacy Policy, Acceptable Use Policy, Refunds and Cancellation, and Subprocessors.",
  },
];

/** `2026-10-05` as "October 5, 2026". */
export function longDate(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[month - 1]} ${date}, ${year}`;
}

/**
 * security.txt (RFC 9116). `Expires` is required and should be less than a
 * year away, so it is always computed: 180 days from now.
 */
export function securityTxt(now: Date = new Date(), site = "https://g1t.sh"): string {
  const expires = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    `Contact: mailto:${CONTACT.security}`,
    `Expires: ${expires.toISOString().replace(".000Z", "Z")}`,
    "Preferred-Languages: en",
    `Policy: ${site}/security#responsible-disclosure`,
    `Canonical: ${site}/.well-known/security.txt`,
    "",
  ].join("\n");
}
