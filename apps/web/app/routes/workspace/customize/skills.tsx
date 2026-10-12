/**
 * Customize → Skills (docs.g1t.sh/guides/customize/, "Skills"). Yours: the
 * workspace's library, every skill it wrote, imported, saved from a session,
 * follows from a repository or got from a plugin, each saying which agents
 * it reaches with the control that changes that; the drafts waiting for
 * review first; g1t's foundational skills, which every agent has; and the
 * repository the library follows. Discover: every skill in every
 * marketplace's plugins, grouped by marketplace; Add installs the plugin
 * that brings it, then the skill is given to agents like any other.
 */
import { BookOpen, ChevronRight, GitBranch, Plus, RefreshCw } from "lucide-react";
import { Link, data, useFetcher, useSearchParams } from "react-router";

import { FOUNDATIONAL_SKILLS, FOUNDATIONAL_SKILLS_VERSION, type LibrarySkill, type SkillLibrary, type SkillListing, type SkillMirror } from "@g1t/contracts";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/skills";
import { useCustomize } from "./layout";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult, Confirm } from "../../../components/agents/dialogs";
import { FromRepository, NeedsComputer, originText, skillsPath } from "../../../components/agents/skills";
import { AvailabilityBadge, AvailableTo, FeaturedBanner, FilterMenu, ListingCard, ListingGrid, ListingMark, NoAnswer, RequestButton, SectionHead, Waiting } from "../../../components/customize";
import { ButtonLink, EmptyState, SubmitButton, TimeAgo } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { type Reach, type ReachOption, categoriesOf, filterSkills, groupByMarketplace, nextParams, pluginPath, readQuery, readView, requestedBy, skillListingRef, splitTarget, waitingFor, withParams } from "../../../lib/customize";
import { page } from "../../../lib/meta";
import { skillLibrary, workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export { shouldRevalidate } from "../../../lib/customize.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Skills · Customize · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ library: SkillLibrary | null; discover: SkillListing[] | null | undefined }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const discovering = readView(new URL(request.url).searchParams) === "discover";
  const [library, discover] = await Promise.all([
    readOrNull(skillLibrary.library(slug, viewer)),
    // Only Discover reads the marketplaces; undefined says it wasn't asked for.
    discovering ? readOrNull(workspaceAgents.discover(slug, viewer)).then((found) => found?.skills ?? null) : Promise.resolve(undefined),
  ]);
  return { library, discover };
}

/**
 * Give a skill to every agent, a team or one agent, or take it back; move
 * an attachment to the newest version; install the plugin that brings a
 * skill from Discover; link, read again or unlink the repository the
 * library follows.
 */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  const name = String(form.get("name") ?? "");
  switch (intent) {
    case "attach": {
      const { scope, target } = splitTarget(String(form.get("where") ?? ""));
      return answer(intent, skillLibrary.attachSkill(slug, viewer, name, scope, target));
    }
    case "detach":
      return answer(intent, skillLibrary.detachSkill(slug, viewer, name, String(form.get("attachment") ?? "")));
    case "pin":
      return answer(intent, skillLibrary.pinSkill(slug, viewer, name, String(form.get("attachment") ?? ""), null));
    case "add":
      return answer(intent, workspaceAgents.installPlugin(slug, viewer, String(form.get("plugin") ?? "")));
    case "link": {
      const repo = String(form.get("repo") ?? "").trim();
      if (!repo) return { ok: false, intent, error: "Name the repository as workspace/name." };
      return answer(intent, skillLibrary.setMirror(slug, viewer, repo));
    }
    case "unlink":
      return answer(intent, skillLibrary.setMirror(slug, viewer, null));
    case "sync":
      return answer(intent, skillLibrary.syncMirror(slug, viewer));
    default:
      return { ok: false, intent, error: "Unknown request." };
  }
}

/** Where a skill reaches, as the control reads it. */
function reachOf(skill: LibrarySkill): Reach[] {
  return skill.attachments.map((a) => ({ id: a.id, scope: a.scope, target: a.target, label: a.label }));
}

/** Who the viewer may give skills to: owners anyone, team maintainers their teams; null for everyone else. */
function targetsOf(library: SkillLibrary) {
  return library.can_manage || library.teams.length > 0 ? { can_manage: library.can_manage, teams: library.teams, agents: library.agents } : null;
}

export default function CustomizeSkills({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return readView(params) === "discover" ? <Discover library={loaderData.library} listings={loaderData.discover ?? null} /> : <Yours library={loaderData.library} />;
}

// ── Yours ────────────────────────────────────────────────────────────────

function Yours({ library }: { library: SkillLibrary | null }) {
  const { slug } = useCustomize();
  const [params] = useSearchParams();
  const query = readQuery(params).toLowerCase();
  if (!library) return <NoAnswer what="The library" />;
  const matching = (skill: LibrarySkill) => !query || [skill.name, skill.qualified_name, skill.description, skill.plugin ?? ""].some((text) => text.toLowerCase().includes(query));
  const drafts = library.skills.filter((s) => s.status === "draft" && matching(s));
  const published = library.skills.filter((s) => s.status === "published" && matching(s));
  const foundational = FOUNDATIONAL_SKILLS.filter((skill) => !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query));
  const targets = targetsOf(library);
  return (
    <div className="space-y-10">
      {drafts.length > 0 && (
        <section aria-labelledby="drafts">
          <SectionHead id="drafts" title="Drafts to review" aside={`${drafts.length}`}>
            Saved from finished sessions. No agent uses a draft until someone who writes skills reviews and publishes it.
          </SectionHead>
          <Card asChild divided className="overflow-hidden border-warn/30">
            <ul>
              {drafts.map((skill) => (
                <SkillRow key={skill.id} slug={slug} skill={skill} targets={null} mirror={library.mirror} />
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section aria-labelledby="library">
        <SectionHead id="library" title="Your workspace's skills" aside={`${published.length}`}>
          How your agents do a kind of work, in the open SKILL.md format. A skill reaches the agents it is available to; they see its name and when to use it, and read the rest when a request matches.
        </SectionHead>
        {published.length === 0 ? (
          <EmptyState title={query ? "No skill matches" : "No skills yet"}>
            {query ? (
              "Try another word, or look in Discover."
            ) : library.can_write ? (
              <>
                Write one, such as how you cut a release or your brand voice, import a SKILL.md or a zip, save a finished session as a skill, or add public skills from{" "}
                <Link to={withParams(customizePath("skills", slug), params, { view: "discover" })} className="text-accent hover:underline">
                  Discover
                </Link>
                .
              </>
            ) : (
              "Owners and team maintainers write skills. You can save a finished session as a skill for them to review, or ask for a public skill in Discover."
            )}
          </EmptyState>
        ) : (
          <Card asChild divided className="overflow-hidden">
            <ul>
              {published.map((skill) => (
                <SkillRow key={skill.id} slug={slug} skill={skill} targets={targets} mirror={library.mirror} />
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section aria-labelledby="foundational">
        <SectionHead id="foundational" title="From g1t" aside={`Version ${FOUNDATIONAL_SKILLS_VERSION}, updated with every release`}>
          Every agent has these. Owners turn one off for an agent on its Skills tab.
        </SectionHead>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {foundational.map((skill) => (
            <li key={skill.id}>
              <Card asChild className="flex h-full items-start gap-3 px-4 py-3 transition-colors hover:border-line-strong">
                <Link to={skillsPath(slug, skill.id)} prefetch="intent">
                  <BookOpen size={15} className="mt-0.5 shrink-0 text-faint" aria-hidden />
                  <span className="min-w-0">
                    <span className="block font-mono text-[0.8125rem] font-medium text-fg">{skill.id}</span>
                    <span className="mt-0.5 block text-xs text-muted">{skill.description}</span>
                  </span>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <MirrorPanel slug={slug} mirror={library.mirror} canManage={library.can_manage} canWrite={library.can_write} />
    </div>
  );
}

/** A library skill as a row: its name, what it is, where it came from, and the agents it is available to. */
function SkillRow({ slug, skill, targets, mirror }: { slug: string; skill: LibrarySkill; targets: ReturnType<typeof targetsOf>; mirror: SkillMirror | null }) {
  const fetcher = useFetcher<ActionResult>({ key: `skill-reach-${skill.id}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const behind = skill.attachments.filter((a) => a.version < skill.version);
  const draft = skill.status === "draft";
  const to = skillsPath(slug, skill.qualified_name, draft && skill.can_edit ? "/edit" : "");
  const change = (option: ReachOption, checked: boolean) => {
    if (checked) fetcher.submit({ intent: "attach", name: skill.qualified_name, where: option.value }, { method: "post" });
    else if (option.reach) fetcher.submit({ intent: "detach", name: skill.qualified_name, attachment: option.reach.id }, { method: "post" });
  };
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5 sm:flex-nowrap">
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={to} prefetch="intent" className="font-mono text-sm font-medium text-fg hover:underline">
            {skill.qualified_name}
          </Link>
          {draft ? <Badge tone="warn">Draft</Badge> : <span className="text-xs text-faint">v{skill.version}</span>}
          {skill.plugin && (
            <Link to={pluginPath(slug, skill.plugin)} className="inline-flex" prefetch="intent">
              <Badge tone="accent">from {skill.plugin}</Badge>
            </Link>
          )}
          {skill.requires_computer && <NeedsComputer />}
          {skill.mirrored && <FromRepository repo={mirror?.repo ?? null} />}
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted">{skill.description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {draft ? <span className="text-xs text-faint">{originText(skill.origin)}</span> : <AvailableTo reach={reachOf(skill)} targets={targets} busy={fetcher.state !== "idle"} onChange={change} />}
          {behind.length > 0 && (
            <fetcher.Form method="post" className="inline-flex items-center gap-1.5">
              <input type="hidden" name="intent" value="pin" />
              <input type="hidden" name="name" value={skill.qualified_name} />
              <input type="hidden" name="attachment" value={behind[0]!.id} />
              <SubmitButton variant="link" size="inline" fetcher={fetcher} match={{ intent: "pin", attachment: behind[0]!.id }} pending="Updating…" className="text-xs text-warn">
                Update available on {behind.length === 1 ? behind[0]!.label : `${behind.length} attachments`}
              </SubmitButton>
            </fetcher.Form>
          )}
        </div>
        {error && <p className="mt-1.5 text-sm text-danger">{error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs text-faint sm:flex-col sm:items-end">
        <p>
          @{skill.updated_by} · <TimeAgo at={skill.updated_at} />
        </p>
        <Link to={to} aria-label={`Open ${skill.qualified_name}`} className="hidden text-faint hover:text-fg sm:block">
          <ChevronRight size={16} aria-hidden />
        </Link>
      </div>
    </li>
  );
}

/** The repository the library follows: `.claude/skills/<name>/` on its default branch, read after every push. */
function MirrorPanel({ slug, mirror, canManage, canWrite }: { slug: string; mirror: SkillMirror | null; canManage: boolean; canWrite: boolean }) {
  const link = useFetcher<ActionResult>({ key: "skills-link" });
  const sync = useFetcher<ActionResult>({ key: "skills-sync" });
  const linkError = link.state === "idle" && link.data && !link.data.ok ? link.data.error : null;
  const syncError = sync.state === "idle" && sync.data && !sync.data.ok ? sync.data.error : null;
  const problems = mirror?.error?.split("\n").filter(Boolean) ?? [];
  return (
    <Card asChild>
      <section aria-labelledby="repository">
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
          <div className="flex min-w-0 items-start gap-3">
            <GitBranch size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0">
              <h2 id="repository" className="text-sm font-medium">
                Keep skills in a repository
              </h2>
              {mirror ? (
                <p className="mt-0.5 text-sm text-muted">
                  Follows{" "}
                  <Link to={`/${mirror.repo}/tree/${mirror.branch}/.claude/skills`} className="font-mono text-fg hover:underline">
                    {mirror.repo}
                  </Link>
                  : each folder in <code className="font-mono text-[0.8125rem]">.claude/skills/</code> on {mirror.branch} is a skill, and a push there publishes a new version.
                  {mirror.synced_at && (
                    <span className="text-faint">
                      {" "}
                      Read <TimeAgo at={mirror.synced_at} />
                      {mirror.commit ? ` at ${mirror.commit.slice(0, 7)}` : ""}.
                    </span>
                  )}
                </p>
              ) : (
                <p className="mt-0.5 max-w-2xl text-sm text-muted">
                  Optional. Link a repository and each <code className="font-mono text-[0.8125rem]">.claude/skills/&lt;name&gt;/</code> folder on its default branch becomes a skill here, updated by every push, so skills go
                  through the same pull requests and reviews as code.
                </p>
              )}
            </div>
          </div>
          {mirror && (
            <div className="flex shrink-0 flex-wrap gap-2">
              {canWrite && (
                <sync.Form method="post">
                  <input type="hidden" name="intent" value="sync" />
                  <SubmitButton variant="outline" size="sm" fetcher={sync} match={{ intent: "sync" }} pending="Reading…">
                    <RefreshCw size={13} />
                    Read it again
                  </SubmitButton>
                </sync.Form>
              )}
              {canManage && (
                <Confirm
                  title="Stop following the repository?"
                  confirm="Stop following"
                  fields={{ intent: "unlink" }}
                  fetcherKey="skills-unlink"
                  trigger={
                    <Button type="button" variant="outline" size="sm" className="hover:border-danger/50 hover:text-danger">
                      Stop following
                    </Button>
                  }
                >
                  Its skills stay in the library as they are, and can be edited here again. Pushes to {mirror.repo} no longer change them.
                </Confirm>
              )}
            </div>
          )}
        </div>
        {(problems.length > 0 || syncError) && (
          <ul className="space-y-1 border-t border-line/60 px-4 py-3 text-sm text-warn" aria-label="What couldn't be read">
            {syncError && <li>{syncError}</li>}
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {!mirror && canManage && (
          <link.Form method="post" className="flex flex-wrap items-start gap-2 border-t border-line/60 px-4 py-3">
            <input type="hidden" name="intent" value="link" />
            <label htmlFor="skills-repo" className="sr-only">
              Repository
            </label>
            <Input id="skills-repo" name="repo" placeholder={`${slug}/agents`} autoComplete="off" spellCheck={false} className="max-w-xs grow font-mono" />
            <SubmitButton variant="outline" fetcher={link} match={{ intent: "link" }} pending="Linking…">
              Link repository
            </SubmitButton>
            {linkError && <p className="w-full text-sm text-danger">{linkError}</p>}
          </link.Form>
        )}
      </section>
    </Card>
  );
}

// ── Discover ─────────────────────────────────────────────────────────────

function Discover({ library, listings }: { library: SkillLibrary | null; listings: SkillListing[] | null }) {
  const { slug, owner, username, requests } = useCustomize();
  const [params, setParams] = useSearchParams();
  if (!listings) return <NoAnswer what="Public skills" />;
  const category = params.get("category") || null;
  const shown = filterSkills(listings, { q: readQuery(params), category });
  const categories = categoriesOf(listings);
  const marketplaces = new Set(listings.map((listing) => listing.marketplace)).size;
  const grouped = groupByMarketplace(shown);
  const targets = library ? targetsOf(library) : null;
  return (
    <div className="space-y-8">
      <FeaturedBanner
        title="Public skills, as they are"
        action={
          <ButtonLink to={customizePath("marketplaces", slug)} variant="outline" size="sm">
            {marketplaces} {marketplaces === 1 ? "marketplace" : "marketplaces"}
          </ButtonLink>
        }
      >
        Every skill published in the marketplaces this workspace reads, in the open SKILL.md format. Adding one installs the plugin that brings it; then you say which agents it is available to.
      </FeaturedBanner>
      <div className="flex flex-wrap items-center gap-2">
        {categories.length > 0 && (
          <FilterMenu label="Category" all="All" value={category} options={categories.map((c) => ({ value: c, label: c }))} onChange={(next) => setParams(nextParams(params, { category: next }), { replace: true, preventScrollReset: true })} />
        )}
        <span className="text-xs text-faint">
          {shown.length} of {listings.length}
        </span>
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No skill matches">Try another word or category, or add a marketplace that lists it.</EmptyState>
      ) : (
        grouped.map((group) => (
          <section key={group.marketplace} aria-labelledby={`from-${group.marketplace}`}>
            <SectionHead id={`from-${group.marketplace}`} title={`From ${group.marketplace}`} aside={`${group.items.length}`} />
            <ListingGrid>
              {group.items.map((listing) => (
                <SkillCard key={listing.ref} listing={listing} slug={slug} owner={owner} requested={requestedBy(requests?.requests ?? [], skillListingRef(listing), username)} waiting={owner ? waitingFor(requests?.requests ?? [], skillListingRef(listing)) : 0} library={library} targets={targets} />
              ))}
            </ListingGrid>
          </section>
        ))
      )}
    </div>
  );
}

/** A skill in Discover: what it is, the plugin that brings it, and Add, Request, or where it is available once added. */
function SkillCard({
  listing,
  slug,
  owner,
  requested,
  waiting,
  library,
  targets,
}: {
  listing: SkillListing;
  slug: string;
  owner: boolean;
  requested: boolean;
  waiting: number;
  library: SkillLibrary | null;
  targets: ReturnType<typeof targetsOf>;
}) {
  const fetcher = useFetcher<ActionResult>({ key: `discover-skill-${listing.ref}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const pluginRef = `${listing.plugin}@${listing.marketplace}`;
  const added = library?.skills.find((skill) => skill.plugin === pluginRef && skill.name.toLowerCase() === listing.name.toLowerCase()) ?? null;
  const available = listing.availability.kind === "available" || listing.availability.kind === "installed";
  const change = (option: ReachOption, checked: boolean) => {
    if (!added) return;
    if (checked) fetcher.submit({ intent: "attach", name: added.qualified_name, where: option.value }, { method: "post" });
    else if (option.reach) fetcher.submit({ intent: "detach", name: added.qualified_name, attachment: option.reach.id }, { method: "post" });
  };
  const action = added ? (
    <AvailableTo reach={reachOf(added)} targets={targets} busy={fetcher.state !== "idle"} onChange={change} />
  ) : !available ? null : owner ? (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="add" />
      <input type="hidden" name="plugin" value={pluginRef} />
      <SubmitButton size="xs" fetcher={fetcher} match={{ intent: "add", plugin: pluginRef }} pending="Adding…">
        <Plus size={13} />
        Add
      </SubmitButton>
    </fetcher.Form>
  ) : (
    <RequestButton slug={slug} listing={skillListingRef(listing)} name={listing.name} requested={requested} size="xs" />
  );
  return (
    <ListingCard
      mark={<ListingMark id={listing.ref} name={listing.name} />}
      title={<span className="font-mono">{listing.name}</span>}
      to={pluginPath(slug, pluginRef)}
      description={listing.description}
      badge={added || listing.added ? <Badge tone="success">Added</Badge> : !available ? <AvailabilityBadge availability={listing.availability} /> : null}
      muted={!available}
      meta={
        <>
          From {listing.plugin}
          {listing.author ? ` · by ${listing.author}` : ""}
          {waiting > 0 && (
            <>
              {" · "}
              <Waiting slug={slug} count={waiting} />
            </>
          )}
        </>
      }
      action={action}
    >
      {error && <p className="text-xs text-danger">{error}</p>}
    </ListingCard>
  );
}
