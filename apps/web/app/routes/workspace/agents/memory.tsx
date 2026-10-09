import { Bot, Brain, Pencil, Pin, PinOff, Trash2, User as UserIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher, useOutletContext } from "react-router";

import type { AgentMemory, AgentMemoryScope, WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/memory";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult, BUTTONS, Confirm } from "../../../components/agents/dialogs";
import { memoryGroups } from "../../../components/agents/format";
import { Quiet } from "../../../components/agents/parts";
import { TimeAgo } from "../../../components/ui";
import { Hint } from "../../../components/ui/hint";
import { SelectField } from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { sidebarOrNull } from "../../../lib/chat.server";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/** The longest fact the agents service keeps. */
const MAX_FACT = 500;

/** What the agent remembers that the viewer may see, and the channels they could give it facts for. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [memories, sidebar] = await Promise.all([readOrNull(workspaceAgents.memories(slug, params.handle.toLowerCase(), viewer)), sidebarOrNull(slug, viewer)]);
  const channels = (sidebar?.entries ?? [])
    .filter((entry) => entry.channel.kind === "channel" && entry.channel.name)
    .map((entry) => ({ id: entry.channel.id, name: entry.channel.name! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { memories, channels, isOwner: role === "owner", me: viewer.username };
}

export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const handle = params.handle.toLowerCase();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  if (intent === "remember") {
    const body = String(form.get("body") ?? "").trim();
    if (!body) return { ok: false, intent, error: "Write what it should remember." };
    const asked = String(form.get("scope") ?? "person");
    const scope: AgentMemoryScope = asked === "workspace" || asked === "channel" ? asked : "person";
    const channel = String(form.get("channel") ?? "");
    if (scope === "channel" && !channel) return { ok: false, intent, error: "Choose the channel it's for." };
    return answer(intent, workspaceAgents.remember(slug, handle, viewer, { body, scope, scope_ref: scope === "channel" ? channel : null }));
  }
  if (intent === "edit") return answer(intent, workspaceAgents.updateMemory(slug, handle, viewer, id, { body: String(form.get("body") ?? "") }));
  if (intent === "pin") return answer(intent, workspaceAgents.updateMemory(slug, handle, viewer, id, { pinned: form.get("pinned") === "true" }));
  if (intent === "forget") return answer(intent, workspaceAgents.forget(slug, handle, viewer, id));
  return { ok: false, intent, error: "Unknown request." };
}

/**
 * What the agent remembers, by where it may be recalled: the whole
 * workspace, one conversation, or only the viewer's own DMs with it. Each
 * fact carries where it came from.
 */
export default function MemoryTab({ loaderData }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { memories, channels, isOwner } = loaderData;
  if (!memories) return <Quiet title="Memory can't be shown right now">The agents service didn&apos;t answer. Reload in a moment.</Quiet>;
  const groups = memoryGroups(memories);
  return (
    <div className="space-y-8">
      <p className="max-w-2xl text-sm text-muted">
        {agent.display_name} has no hidden memory: only these facts, each recalled only where it belongs. <strong className="font-medium text-fg-soft">Workspace</strong> facts
        are recalled anywhere; a <strong className="font-medium text-fg-soft">conversation</strong>&apos;s only there; <strong className="font-medium text-fg-soft">just you</strong>{" "}
        only in your direct messages with it. You see the facts from conversations you&apos;re in.
      </p>
      <AddFact agent={agent} channels={channels} isOwner={isOwner} />
      {groups.length === 0 ? (
        <Quiet title="Nothing remembered yet" icon={<Brain size={20} />}>
          When a session learns something worth keeping, or someone tells {agent.display_name} to remember it, the fact shows here with where it came from.
        </Quiet>
      ) : (
        groups.map((group) => (
          <section key={group.scope}>
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h2 className="text-sm font-medium">
                {group.title} <span className="text-faint">{group.memories.length}</span>
              </h2>
              <p className="text-xs text-faint">{group.about}</p>
            </div>
            <ul className="mt-3 divide-y divide-line/60 overflow-hidden rounded-xl border border-line bg-surface">
              {group.memories.map((memory) => (
                <Fact key={memory.id} memory={memory} agent={agent} canChange={memory.scope !== "workspace" || isOwner} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function AddFact({ agent, channels, isOwner }: { agent: WorkspaceAgent; channels: { id: string; name: string }[]; isOwner: boolean }) {
  const fetcher = useFetcher<ActionResult>({ key: "remember" });
  const form = useRef<HTMLFormElement>(null);
  const [scope, setScope] = useState<AgentMemoryScope>("person");
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  const options = [
    { value: "person", label: "Just me", description: "Recalled only in your direct messages with it." },
    ...(isOwner ? [{ value: "workspace", label: "This workspace", description: "Recalled anywhere, for anyone. Owners only." }] : []),
    ...(channels.length > 0 ? [{ value: "channel", label: "A channel", description: "Recalled only in that channel and its threads." }] : []),
  ];
  return (
    <fetcher.Form ref={form} method="post" className="rounded-xl border border-line bg-surface p-4">
      <input type="hidden" name="intent" value="remember" />
      <label htmlFor="fact" className="text-sm font-medium">
        Add a fact
      </label>
      <Textarea
        id="fact"
        name="body"
        rows={2}
        maxLength={MAX_FACT}
        required
        placeholder={`Something ${agent.display_name} should know, such as: Releases go out on Thursdays.`}
        className="mt-2"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="w-44">
          <SelectField name="scope" value={scope} onValueChange={(v) => setScope(v as AgentMemoryScope)} options={options} size="sm" aria-label="Who it's recalled for" />
        </div>
        {scope === "channel" && (
          <div className="w-48">
            <SelectField name="channel" options={channels.map((c) => ({ value: c.id, label: `#${c.name}` }))} placeholder="Choose a channel" size="sm" aria-label="Channel" required />
          </div>
        )}
        <span className="grow text-xs text-danger">{fetcher.data && !fetcher.data.ok && fetcher.data.intent === "remember" ? fetcher.data.error : ""}</span>
        <button type="submit" disabled={busy} className={`${BUTTONS.PRIMARY} h-8 py-0`}>
          {busy ? "Saving…" : "Remember"}
        </button>
      </div>
    </fetcher.Form>
  );
}

function Fact({ memory, agent, canChange }: { memory: AgentMemory; agent: WorkspaceAgent; canChange: boolean }) {
  const [editing, setEditing] = useState(false);
  const edit = useFetcher<ActionResult>({ key: `edit-${memory.id}` });
  const pin = useFetcher<ActionResult>({ key: `pin-${memory.id}` });
  useEffect(() => {
    if (edit.state === "idle" && edit.data?.ok) setEditing(false);
  }, [edit.state, edit.data]);
  const pinned = pin.formData ? pin.formData.get("pinned") === "true" : memory.pinned;
  const by =
    memory.created_by_kind === "agent" ? (
      <span className="inline-flex items-center gap-1">
        <Bot size={11} />
        Kept by {memory.created_by === agent.handle ? agent.display_name : `@${memory.created_by}`}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1">
        <UserIcon size={11} />
        Told by @{memory.created_by}
      </span>
    );
  return (
    <li className="group px-4 py-3">
      {editing ? (
        <edit.Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="edit" />
          <input type="hidden" name="id" value={memory.id} />
          <Textarea name="body" defaultValue={memory.body} rows={2} maxLength={MAX_FACT} required autoFocus aria-label="The fact" />
          <div className="flex items-center justify-end gap-2">
            <span className="grow text-xs text-danger">{edit.data && !edit.data.ok ? edit.data.error : ""}</span>
            <button type="button" className={`${BUTTONS.QUIET} h-8 py-0`} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className={`${BUTTONS.PRIMARY} h-8 py-0`} disabled={edit.state !== "idle"}>
              {edit.state !== "idle" ? "Saving…" : "Save"}
            </button>
          </div>
        </edit.Form>
      ) : (
        <div className="flex items-start gap-3">
          {pinned && (
            <Hint label="Pinned: always recalled where it belongs">
              <Pin size={13} className="mt-1 shrink-0 text-accent" aria-label="Pinned" />
            </Hint>
          )}
          <div className="min-w-0 grow">
            <p className="text-sm text-fg">{memory.body}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
              {memory.scope === "channel" && memory.scope_label && <span className="text-muted">#{memory.scope_label}</span>}
              {by}
              {memory.source_label && <span>from {memory.source_label}</span>}
              <TimeAgo at={memory.updated_at} />
            </p>
          </div>
          {canChange && (
            <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
              <pin.Form method="post">
                <input type="hidden" name="intent" value="pin" />
                <input type="hidden" name="id" value={memory.id} />
                <input type="hidden" name="pinned" value={pinned ? "false" : "true"} />
                <Hint label={pinned ? "Unpin" : "Pin"}>
                  <button type="submit" aria-label={pinned ? "Unpin" : "Pin"} className="flex size-7 items-center justify-center rounded-md text-faint max-sm:size-10 hover:bg-raised hover:text-fg">
                    {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  </button>
                </Hint>
              </pin.Form>
              <Hint label="Edit">
                <button type="button" aria-label="Edit" onClick={() => setEditing(true)} className="flex size-7 items-center justify-center rounded-md text-faint max-sm:size-10 hover:bg-raised hover:text-fg">
                  <Pencil size={14} />
                </button>
              </Hint>
              <Confirm
                title="Forget this fact?"
                confirm="Forget"
                fields={{ intent: "forget", id: memory.id }}
                fetcherKey={`forget-${memory.id}`}
                trigger={
                  <button type="button" aria-label="Forget" className="flex size-7 items-center justify-center rounded-md text-faint max-sm:size-10 hover:bg-raised hover:text-danger">
                    <Trash2 size={14} />
                  </button>
                }
              >
                {agent.display_name} won&apos;t recall &ldquo;{memory.body}&rdquo; again, anywhere. It can learn it again if it comes up.
              </Confirm>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
