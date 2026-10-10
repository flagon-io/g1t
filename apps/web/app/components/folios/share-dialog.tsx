/**
 * Share an artifact (docs.g1t.sh/guides/artifacts/, "Sharing"): invite people,
 * agents and teams with a role, see everyone who has access and where it
 * comes from, choose whether it follows its space or parent or only
 * people invited, open it to the workspace or to anyone in it with the
 * link, and say how agents may change it. People who can't share see it
 * read-only.
 */
import { DOC_AGENT_MODE_LABELS, DOC_ROLE_LABELS, FOLIO_GENERAL_ROLES, type DocRole, type Folio, type FolioAccessChange, type FolioAccessList, type FolioGeneralAccess, type FolioGeneralRole } from "@g1t/contracts";
import { Check, Globe, Link2, Lock, Users } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { spacePath } from "../../lib/folios";
import { Button, ErrorText } from "../ui";
import { Combobox } from "../ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Hint } from "../ui/hint";
import { SelectField } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { foliosQuery, foliosRequest, useFoliosData } from "./actions";
import { Face } from "./parts";

const ROLES: DocRole[] = ["view", "comment", "edit", "manage"];

type Candidate = { value: string; label: string; kind: "user" | "agent" | "team"; name: string };

export function ShareDialog({ slug, folio, open, onOpenChange, onChanged }: { slug: string; folio: Pick<Folio, "id" | "title" | "path" | "space" | "parent_id" | "viewer_role">; open: boolean; onOpenChange: (o: boolean) => void; onChanged?: () => void }) {
  const layout = useFoliosData();
  const [access, setAccess] = useState<FolioAccessList | null>(null);
  const [teams, setTeams] = useState<{ slug: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState("");
  const [role, setRole] = useState<DocRole>("edit");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAccess(null);
    setError(null);
    setSaved(false);
    void foliosQuery<FolioAccessList>(slug, { access: folio.id }).then((r) => (r.ok ? setAccess(r.value) : setError(r.error.message)));
    void foliosQuery<{ slug: string; name: string }[]>(slug, { teams: "1" }).then((r) => r.ok && setTeams(r.value));
  }, [open, slug, folio.id]);

  const change = async (body: FolioAccessChange) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const done = await foliosRequest<FolioAccessList>(slug, "access", { folio_id: folio.id, access: body });
    setBusy(false);
    if (!done.ok) {
      setError(done.error.message);
      return false;
    }
    setAccess(done.value);
    setSaved(true);
    onChanged?.();
    return true;
  };

  const manager = folio.viewer_role === "manage";
  const canShare = !!access?.can_share;
  const listed = new Set([...(access?.rows ?? []).map((r) => r.principal), access ? `user:${access.owner.id}` : ""]);
  const candidates: Candidate[] = useMemo(
    () => [
      ...(layout?.mentionables ?? []).map((m): Candidate => (m.kind === "agent" ? { value: `agent:${m.id}`, label: `${m.display_name} (agent)`, kind: "agent", name: m.name } : { value: `username:${m.name}`, label: `${m.display_name} (@${m.name})`, kind: "user", name: m.name })),
      ...teams.map((t): Candidate => ({ value: `team:${t.slug}`, label: `${t.name} (team)`, kind: "team", name: t.slug })),
    ],
    [layout?.mentionables, teams],
  );
  const usernameOf = new Map((access?.rows ?? []).filter((r) => r.profile.kind === "user").map((r) => [r.profile.name, r.principal]));
  const offered = candidates.filter((c) => !listed.has(c.value) && !(c.kind === "user" && (usernameOf.has(c.name) || access?.owner.name === c.name)));

  const invite = async () => {
    if (!who) return;
    const principal = who.startsWith("username:") ? await memberKey(slug, who.slice(9)) : who;
    if (!principal) return setError("That person isn't in the workspace.");
    if (await change({ op: "grant", principal, role, notify: note.trim() || null })) {
      setWho("");
      setNote("");
    }
  };

  const root = !folio.parent_id || access?.inherit === false;
  const general: FolioGeneralAccess = access?.general_access ?? "none";
  const generalRole: FolioGeneralRole = access?.general_role ?? "view";
  const roleOptions = ROLES.filter((r) => manager || r !== "manage").map((r) => ({ value: r, label: DOC_ROLE_LABELS[r] }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Share “{folio.title || "Untitled"}”</DialogTitle>
          <DialogDescription>{canShare ? "People you add get a notification with a link." : `Only people with full access can change who can open it. Ask ${access?.owner.display_name ?? "its owner"} to share it.`}</DialogDescription>
        </DialogHeader>

        {canShare && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Combobox options={offered.map((c) => ({ value: c.value, label: c.label }))} value={who} onValueChange={setWho} placeholder="Add people, agents or teams" searchPlaceholder="Search the workspace" emptyText="Nobody else to add." className="h-9 min-w-0 grow basis-56" />
              <SelectField aria-label="Their role" value={role} onValueChange={(r) => setRole(r as DocRole)} options={roleOptions} className="h-9 w-36" />
            </div>
            {who && (
              <div className="flex gap-2">
                <input aria-label="Message" placeholder="Add a message (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="h-9 min-w-0 grow rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent/60" />
                <Button type="button" variant="accent" disabled={busy} onClick={invite}>
                  Invite
                </Button>
              </div>
            )}
          </div>
        )}

        <section className="mt-2">
          <h3 className="mb-1.5 flex items-center gap-2 text-xs font-medium text-faint">
            Who has access
            {saved && (
              <span className="inline-flex items-center gap-1 text-success">
                <Check size={12} /> Updated
              </span>
            )}
          </h3>
          {!access ? (
            <div className="space-y-2 py-1" aria-busy="true">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-6 w-44" />
            </div>
          ) : (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto [scrollbar-width:thin]">
              <Row face={<Face who={access.owner} size={26} />} name={access.owner.display_name} sub={`@${access.owner.name}`} end={<span className="text-xs text-faint">Owner</span>} />
              {access.rows.map((r) => {
                const face = r.profile.kind === "team" ? <TeamFace /> : <Face who={r.profile} size={26} />;
                const sub = r.profile.kind === "team" ? "Team" : r.profile.kind === "agent" ? "Agent" : `@${r.profile.name}`;
                if (r.source.kind === "grant") {
                  const editable = canShare && (manager || r.role !== "manage");
                  return (
                    <Row
                      key={r.principal}
                      face={face}
                      name={r.profile.display_name}
                      sub={sub}
                      end={
                        editable ? (
                          <SelectField
                            aria-label={`${r.profile.display_name}'s access`}
                            value={r.role}
                            onValueChange={(v) => (v === "remove" ? change({ op: "revoke", principal: r.principal }) : change({ op: "grant", principal: r.principal, role: v as DocRole }))}
                            options={[...roleOptions, { value: "remove", label: "Remove access" }]}
                            className="h-8 w-36"
                          />
                        ) : (
                          <span className="text-xs text-muted">{DOC_ROLE_LABELS[r.role]}</span>
                        )
                      }
                    />
                  );
                }
                const from = r.source;
                return (
                  <Row
                    key={r.principal}
                    face={face}
                    name={r.profile.display_name}
                    sub={
                      <>
                        From{" "}
                        <Link to={from.kind === "folio" ? from.path : `/${slug}/-/artifacts`} onClick={() => onOpenChange(false)} className="text-muted hover:text-fg hover:underline">
                          {from.kind === "folio" ? from.title : from.kind === "space" ? from.name : "its owner"}
                        </Link>
                      </>
                    }
                    end={<span className="text-xs text-muted">{DOC_ROLE_LABELS[r.role]}</span>}
                  />
                );
              })}
            </ul>
          )}
        </section>

        {access && (
          <section className="mt-2 space-y-3 border-t border-line pt-4">
            <h3 className="text-xs font-medium text-faint">General access</h3>
            {(folio.space || folio.parent_id) && (
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-muted">{access.inherit ? <Users size={15} /> : <Lock size={15} />}</span>
                <div className="min-w-0 grow">
                  <SelectField
                    aria-label="Follows its space or parent"
                    disabled={!manager || busy}
                    value={access.inherit ? "inherit" : "restrict"}
                    onValueChange={(v) => change({ op: "inherit", inherit: v === "inherit" })}
                    options={[
                      { value: "inherit", label: access.inherited_from ? `Everyone in ${access.inherited_from.name}` : folio.space ? `Everyone in ${folio.space.name}` : "Follows the doc it's in" },
                      { value: "restrict", label: "Only people invited" },
                    ]}
                    className="h-8 w-full max-w-xs"
                  />
                  <p className="mt-1 text-xs text-faint">
                    {access.inherit ? "Whoever can open " : "Access stops here: whoever can open "}
                    {folio.parent_id ? "the doc it's in" : folio.space ? <Link to={spacePath(slug, folio.space.slug)} className="hover:text-fg hover:underline">{folio.space.name}</Link> : "its space"}
                    {access.inherit ? " can open this, with the same role." : " can't open this unless invited."}
                  </p>
                </div>
              </div>
            )}
            {root ? (
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-muted">{general === "workspace" ? <Globe size={15} /> : general === "link" ? <Link2 size={15} /> : <Lock size={15} />}</span>
                <div className="flex min-w-0 grow flex-wrap items-center gap-2">
                  <SelectField
                    aria-label="General access"
                    disabled={!manager || busy}
                    value={general}
                    onValueChange={(v) => change(v === "none" ? { op: "general", access: "none", role: null } : { op: "general", access: v as FolioGeneralAccess, role: generalRole })}
                    options={[
                      { value: "none", label: "Restricted" },
                      { value: "workspace", label: `Everyone in ${layout?.slug ?? "the workspace"}` },
                      { value: "link", label: "Anyone in the workspace with the link" },
                    ]}
                    className="h-8 min-w-0 grow basis-56"
                  />
                  {general !== "none" && (
                    <SelectField
                      aria-label="Their role"
                      disabled={!manager || busy}
                      value={generalRole}
                      onValueChange={(v) => change({ op: "general", access: general, role: v as FolioGeneralRole })}
                      options={FOLIO_GENERAL_ROLES.map((r) => ({ value: r, label: DOC_ROLE_LABELS[r] }))}
                      className="h-8 w-36"
                    />
                  )}
                  <p className="w-full text-xs text-faint">
                    {general === "none" ? "Only the people above can open it." : general === "workspace" ? "Every member can find and open it." : "Members who open the link can. It isn't listed or searchable until they do."}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-faint">It follows the doc it&apos;s in. Change who else can open it there, or choose &ldquo;Only people invited&rdquo;.</p>
            )}
            <div className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-faint">
                <Globe size={15} />
              </span>
              <Hint label="Links for people outside the workspace aren't available yet.">
                <span className="text-sm text-faint" tabIndex={0}>
                  Public link: off for this workspace
                </span>
              </Hint>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">Agents may</span>
              <SelectField
                aria-label="How agents change it"
                disabled={!manager || busy}
                value={access.agent_mode ?? "default"}
                onValueChange={(v) => change({ op: "agent_mode", agent_mode: v === "default" ? null : (v as "suggest" | "edit") })}
                options={[
                  { value: "default", label: folio.space ? `As ${folio.space.name} says` : "Suggest changes (default)" },
                  { value: "suggest", label: DOC_AGENT_MODE_LABELS.suggest },
                  { value: "edit", label: DOC_AGENT_MODE_LABELS.edit },
                ]}
                className="h-8 w-52"
              />
            </div>
          </section>
        )}

        {error && <ErrorText>{error}</ErrorText>}

        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-4">
          <Button
            type="button"
            variant="quiet"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(`${window.location.origin}${folio.path}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              } catch {
                setError("Your browser didn't allow copying.");
              }
            }}
          >
            {copied ? <Check size={14} /> : <Link2 size={14} />} {copied ? "Copied" : "Copy link"}
          </Button>
          <Button type="button" variant="accent" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ face, name, sub, end }: { face: ReactNode; name: string; sub: ReactNode; end: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-md px-1 py-1.5">
      {face}
      <span className="min-w-0 grow">
        <span className="block truncate text-sm text-fg">{name}</span>
        <span className="block truncate text-xs text-faint">{sub}</span>
      </span>
      {end}
    </li>
  );
}

function TeamFace() {
  return (
    <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-raised text-muted">
      <Users size={13} />
    </span>
  );
}

/** A person's member key (`user:<id>`), from their username, as the site resolves it. */
export async function memberKey(slug: string, username: string): Promise<string | null> {
  const found = await foliosQuery<string>(slug, { person: username });
  return found.ok ? found.value : null;
}
