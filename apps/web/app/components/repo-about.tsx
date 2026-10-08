/**
 * The About beside a repository's files: what it is (description, home
 * page, topics), what its files say (readme, license, security policy),
 * how people follow it (activity, stars, watching), then its releases,
 * deployments, packages, contributors and languages, each a section.
 *
 * What is read from the default branch (license, languages, contributors)
 * is worked out in the background and kept by commit; it streams in after
 * the files, and while it is first being worked out the panel asks for it
 * again by itself (`about.json`).
 */
import {
  Activity,
  BookOpen,
  Eye,
  Link2,
  Package as PackageIcon,
  Plus,
  Scale,
  ShieldCheck,
  Star,
  Tag as TagIcon,
} from "lucide-react";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { Await, Link } from "react-router";

import type { PackageSummary, Repo, RepoAbout } from "@g1t/contracts";

import { compact, count, languageBar, licenseLabel } from "../lib/about";
import { contributorPerson, profileHref, shownName } from "../lib/commit-people";
import { CommitAvatar } from "./commit-person";
import { UserCard } from "./user-card";
import { PackageIcon as EcosystemIcon } from "./package-icon";
import { Topics } from "./topics";
import { Avatar, Pill, TimeAgo } from "./ui";
import { Hint } from "./ui/hint";
import { SkeletonLine } from "./ui/skeleton";

/** How many contributors' avatars the About shows. */
const AVATARS = 14;
/** How often, and how many times, it asks again while the default branch is first read. */
const RETRY_MS = 3_000;
const RETRIES = 6;

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function Section({ title, count: n, to, children }: { title: string; count?: number; to?: string; children: ReactNode }) {
  const heading = (
    <>
      {title}
      {n != null && n > 0 && <span className="rounded-full bg-raised px-1.5 text-xs font-medium text-muted tabular-nums">{n.toLocaleString("en-US")}</span>}
    </>
  );
  return (
    <section className="border-t border-line pt-4">
      <h2 className="mb-2.5 text-sm font-semibold">
        {to ? (
          <Link to={to} className="inline-flex items-center gap-1.5 hover:text-accent">
            {heading}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1.5">{heading}</span>
        )}
      </h2>
      {children}
    </section>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center text-faint">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </li>
  );
}

const ROW_LINK = "hover:text-accent";

/** The colored bar and each language's share. */
export function LanguageBar({ languages }: { languages: RepoAbout["languages"] }) {
  const bar = languageBar(languages);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-raised" role="img" aria-label={bar.map((l) => `${l.name} ${l.percent}%`).join(", ")}>
        {bar.map((language) => (
          <span
            key={language.name}
            className="h-full border-r border-bg last:border-r-0"
            style={{ width: `${Math.max(language.percent, 0.6)}%`, background: language.color ?? "var(--color-faint)" }}
          />
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {bar.map((language) => (
          <li key={language.name} className="inline-flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-full" style={{ background: language.color ?? "var(--color-faint)" }} />
            <span className="font-medium text-fg">{language.name}</span>
            <span className="text-faint tabular-nums">{language.percent.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The About of a repository that is read from its default branch: it asks again while that is pending. */
function useLive(base: string, first: RepoAbout): RepoAbout {
  const [about, setAbout] = useState(first);
  useEffect(() => setAbout(first), [first]);
  useEffect(() => {
    if (!about.pending) return;
    let tries = 0;
    let stopped = false;
    const timer = setInterval(async () => {
      tries += 1;
      if (tries > RETRIES) return clearInterval(timer);
      try {
        const response = await fetch(`${base}/about.json`, { headers: { accept: "application/json" } });
        if (!response.ok || stopped) return;
        const next = (await response.json()) as RepoAbout;
        if (!next.pending) {
          clearInterval(timer);
          setAbout(next);
        }
      } catch {
        // Asked again on the next tick.
      }
    }, RETRY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [base, about.pending]);
  return about;
}

/** Reading the default branch for the first time. */
function Reading() {
  return <p className="text-xs text-faint">Reading the default branch…</p>;
}

function Releases({ base, about, canPush }: { base: string; about: RepoAbout; canPush: boolean }) {
  const latest = about.latestRelease;
  return (
    <Section title="Releases" count={about.releases} to={`${base}/releases`}>
      {latest ? (
        <div className="text-sm">
          <Link to={`${base}/releases/tag/${encodePath(latest.tagName)}`} className="flex items-start gap-2 hover:text-accent">
            <TagIcon size={15} className="mt-0.5 shrink-0 text-success" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-medium">{latest.name || latest.tagName}</span>
                <Pill>Latest</Pill>
              </span>
              <span className="text-xs text-faint">{latest.publishedAt && <TimeAgo at={latest.publishedAt} />}</span>
            </span>
          </Link>
          {about.releases > 1 && (
            <Link to={`${base}/releases`} className="mt-2 block text-xs text-muted hover:text-accent">
              + {count(about.releases - 1, "release")}
            </Link>
          )}
        </div>
      ) : about.releases > 0 ? (
        <Link to={`${base}/releases`} className="text-sm text-muted hover:text-accent">
          {count(about.releases, "release")}
        </Link>
      ) : (
        <div className="text-sm text-muted">
          <p>No releases published</p>
          {canPush && (
            <Link to={`${base}/releases/new`} className="mt-1 inline-flex items-center gap-1 text-accent hover:underline">
              <Plus size={13} />
              Create a new release
            </Link>
          )}
        </div>
      )}
    </Section>
  );
}

function Packages({ packages }: { packages: PackageSummary[] | null }) {
  return (
    <Section title="Packages" count={packages?.length}>
      {packages && packages.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {packages.slice(0, 5).map((pkg) => (
            <li key={pkg.id}>
              <Link to={`/${pkg.workspace}/-/packages/${pkg.ecosystem}/${pkg.name}`} className="flex min-w-0 items-center gap-2 hover:text-accent">
                <EcosystemIcon ecosystem={pkg.ecosystem} size={16} />
                <span className="truncate">{pkg.name}</span>
                {pkg.latest && <span className="ml-auto shrink-0 font-mono text-xs text-faint">{pkg.latest}</span>}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-muted">
          <p>No packages published</p>
          <a href="https://docs.g1t.sh/guides/packages/" className="mt-1 inline-flex items-center gap-1 text-accent hover:underline">
            <PackageIcon size={13} />
            Publish your first package
          </a>
        </div>
      )}
    </Section>
  );
}

function Contributors({ base, about }: { base: string; about: RepoAbout }) {
  const shown = about.topContributors.slice(0, AVATARS);
  return (
    <Section title="Contributors" count={about.contributors} to={`${base}/contributors`}>
      {about.pending ? (
        <Reading />
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">No commits yet</p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((contributor) => {
              // The same person, avatar, link and card as on their commits.
              const person = contributorPerson(contributor);
              const href = profileHref(person);
              const label = `${shownName(person)} · ${count(contributor.commits, "commit")}`;
              const face = <Avatar name={shownName(person)} image={person.avatar} size={30} />;
              return (
                <li key={`${contributor.kind}:${contributor.username ?? contributor.name}`}>
                  {person.kind === "user" || person.kind === "g1t" ? (
                    <UserCard username={person.username}>
                      {href ? (
                        <Link to={href} aria-label={label} className="block rounded-full">
                          {face}
                        </Link>
                      ) : (
                        <span tabIndex={0} aria-label={label} className="block rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent">
                          {face}
                        </span>
                      )}
                    </UserCard>
                  ) : (
                    // Nobody on g1t: no card, only the name on their commits.
                    <Hint label={label}>
                      <span tabIndex={0} aria-label={label} className="block rounded-full">
                        <CommitAvatar person={person} size={30} />
                      </span>
                    </Hint>
                  )}
                </li>
              );
            })}
          </ul>
          {about.contributors > shown.length && (
            <Link to={`${base}/contributors`} className="mt-2 block text-xs text-muted hover:text-accent">
              + {count(about.contributors - shown.length, "contributor")}
            </Link>
          )}
        </>
      )}
    </Section>
  );
}

/** What the default branch says and the counts, once they have streamed in. */
function Facts({ base, gitRef, about, watchers }: { base: string; gitRef: string; about: RepoAbout | null; watchers: number | null }) {
  const activity = (
    <Row icon={<Activity size={15} />}>
      <Link to={`${base}/activity`} className={ROW_LINK}>
        Activity
      </Link>
    </Row>
  );
  if (!about) return activity;
  const blob = (path: string) => `${base}/blob/${encodePath(gitRef)}/${encodePath(path)}`;
  return (
    <>
      {about.license && (
        <Row icon={<Scale size={15} />}>
          <Link to={blob(about.license.path)} className={ROW_LINK}>
            {licenseLabel(about.license)}
          </Link>
        </Row>
      )}
      {about.securityPolicy && (
        <Row icon={<ShieldCheck size={15} />}>
          <Link to={blob(about.securityPolicy)} className={ROW_LINK}>
            Security policy
          </Link>
        </Row>
      )}
      {activity}
      <Row icon={<Star size={15} />}>
        <Link to={`${base}/stargazers`} className={ROW_LINK}>
          <span className="font-medium text-fg">{compact(about.stars)}</span> {about.stars === 1 ? "star" : "stars"}
        </Link>
      </Row>
      {watchers != null && (
        <Row icon={<Eye size={15} />}>
          <span>
            <span className="font-medium text-fg">{watchers.toLocaleString("en-US")}</span> watching
          </span>
        </Row>
      )}
    </>
  );
}

function FactsSkeleton() {
  return (
    <>
      {[0, 1, 2].map((key) => (
        <li key={key} aria-hidden="true" className="flex items-center gap-2">
          <span className="size-4 shrink-0" />
          <SkeletonLine barClassName="w-24" />
        </li>
      ))}
    </>
  );
}

function LoadedSections({
  base,
  first,
  canPush,
  packages,
  deployments,
}: {
  base: string;
  first: RepoAbout;
  canPush: boolean;
  packages: Promise<PackageSummary[] | null> | PackageSummary[] | null;
  deployments: ReactNode;
}) {
  const about = useLive(base, first);
  return (
    <>
      <Releases base={base} about={about} canPush={canPush} />
      <Suspense fallback={<SectionSkeleton title="Packages" />}>
        <Await resolve={packages} errorElement={<Packages packages={null} />}>
          {(found) => <Packages packages={found} />}
        </Await>
      </Suspense>
      {deployments}
      <Contributors base={base} about={about} />
      <Section title="Languages">
        {about.pending ? <Reading /> : about.languages.length > 0 ? <LanguageBar languages={about.languages} /> : <p className="text-sm text-muted">No code to count</p>}
      </Section>
    </>
  );
}

function SectionSkeleton({ title }: { title: string }) {
  return (
    <section className="border-t border-line pt-4" aria-busy="true">
      <h2 className="mb-2.5 text-sm font-semibold">{title}</h2>
      <SkeletonLine barClassName="w-32" />
    </section>
  );
}

export type AboutData = {
  /** What the default branch says, stars and releases; null when it could not be read. */
  about: Promise<RepoAbout | null> | RepoAbout | null;
  /** How many watch it; null when it could not be read. */
  watchers: Promise<number | null> | number | null;
  /** Packages published from it; null when they could not be read. */
  packages: Promise<PackageSummary[] | null> | PackageSummary[] | null;
};

export function RepoAboutPanel({
  repo,
  gitRef,
  readme,
  data,
  canPush,
  homepage,
  deployments = null,
}: {
  repo: Repo;
  gitRef: string;
  readme: boolean;
  data: AboutData;
  canPush: boolean;
  /** The project's homepage (lib/about.ts `projectHomepage`); the repository's website when null. */
  homepage?: string | null;
  /** The Deployments section (deployments-panel.tsx): each environment's latest. */
  deployments?: ReactNode;
}) {
  const base = `/${repo.namespace}/${repo.name}`;
  const site = homepage ?? repo.website ?? null;
  const facts = (about: RepoAbout | null, watchers: number | null) => <Facts base={base} gitRef={gitRef} about={about} watchers={watchers} />;
  return (
    <aside className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">About</h2>
        <p className="mt-2.5 text-sm text-fg-soft">{repo.description ?? (site || repo.topics.length > 0 ? "No description." : "No description, website, or topics provided.")}</p>
        {site && (
          <a href={site} rel="noopener nofollow" className="mt-2.5 flex min-w-0 items-center gap-2 text-sm font-medium text-accent hover:underline">
            <Link2 size={15} className="shrink-0" />
            <span className="truncate">{site.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
          </a>
        )}
        <Topics topics={repo.topics} className="mt-3" />
        <ul className="mt-4 space-y-2.5 text-sm text-muted">
          {readme && (
            <Row icon={<BookOpen size={15} />}>
              <a href="#readme" className={ROW_LINK}>
                Readme
              </a>
            </Row>
          )}
          <Suspense fallback={<FactsSkeleton />}>
            <Await resolve={data.about} errorElement={facts(null, null)}>
              {(about) => (
                <Suspense fallback={facts(about, null)}>
                  <Await resolve={data.watchers} errorElement={facts(about, null)}>
                    {(watchers) => facts(about, watchers)}
                  </Await>
                </Suspense>
              )}
            </Await>
          </Suspense>
        </ul>
        <p className="mt-4 text-xs text-faint">
          Created <TimeAgo at={repo.createdAt} />
        </p>
      </div>
      <Suspense
        fallback={
          <>
            <SectionSkeleton title="Releases" />
            <SectionSkeleton title="Packages" />
            {deployments}
            <SectionSkeleton title="Contributors" />
            <SectionSkeleton title="Languages" />
          </>
        }
      >
        <Await resolve={data.about} errorElement={<>{deployments}</>}>
          {(about) =>
            about ? (
              <LoadedSections base={base} first={about} canPush={canPush} packages={data.packages} deployments={deployments} />
            ) : (
              <>{deployments}</>
            )
          }
        </Await>
      </Suspense>
    </aside>
  );
}
