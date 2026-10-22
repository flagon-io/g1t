/**
 * Chat's New, as claude.ai has it: a new conversation with g1t, in your
 * direct message with it. With no repository, g1t answers there, on the
 * workspace's Ask provider (what the top bar's Ask did in its own panel
 * before it folded into Chat; opened over a page, g1t is told the page).
 * With a repository, and if you like a work item, g1t starts agent work:
 * a hosted session (Claude Managed Agents, on the workspace's own
 * Anthropic key, through `-/chat/api/agent`), and the new conversation
 * shows what you asked and g1t's card for the session, which links to its
 * page, where it streams and can be steered and stopped.
 */
import { CircleDot, FolderGit2, ListChecks } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { AGENT_MODES, type AgentMode, type AskPage, type AskSetup, MAX_PROMPT_CHARS } from "@g1t/contracts";

import { NO_REPO, lastRepoKey, pickerRepos, startingRepo } from "../../lib/agent-chat";
import { askWhere } from "../../lib/ask";
import { askInChat } from "../../lib/ask-in-chat";
import { modelLabel } from "../../lib/ask-model";
import type { AgentComposerData, AgentItemsData } from "../../routes/workspace/chat/agent";
import { Unavailable } from "../boundary";
import { MarkGlyph } from "../logo";
import { Combobox, type ComboboxOption } from "../ui/combobox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Skeleton } from "../ui/skeleton";
import { PromptBox, PromptBoxInput, PromptBoxSend, PromptBoxToolbar } from "./prompt-box";

type AskSetupAnswer = AskSetup & { owner: boolean };

function remembered(slug: string): string | null {
  try {
    return localStorage.getItem(lastRepoKey(slug));
  } catch {
    return null;
  }
}

function remember(slug: string, repo: string) {
  try {
    localStorage.setItem(lastRepoKey(slug), repo);
  } catch {
    // Not kept: the next New starts on the most used repository.
  }
}

/** Reads one JSON answer; null when it failed. */
async function read<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/** The part of a repository's path shown in the picker: its name, the workspace being plain. */
function repoName(path: string): string {
  return path.split("/")[1] ?? path;
}

export function AgentComposer({ slug, page, onDone, initialText = "" }: { slug: string; page?: AskPage | null; onDone: () => void; initialText?: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<AgentComposerData | null | "failed">(null);
  const [ask, setAsk] = useState<AskSetupAnswer | null | "failed">(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, AgentItemsData["items"]>>({});
  const [item, setItem] = useState<number | null>(page?.item ?? null);
  const [mode, setMode] = useState<AgentMode>("implement");
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // What it can start with, read once when it opens; Ask's own setup too, for "No repository".
  useEffect(() => {
    let live = true;
    void read<AgentComposerData>(`/${slug}/-/chat/api/agent`).then((found) => {
      if (!live) return;
      setData(found ?? "failed");
      const repos = found?.repos ?? [];
      setRepo(startingRepo({ repos, remembered: remembered(slug) }));
    });
    // `-/ask` answers the setup as a result, with whether the viewer is an owner beside it.
    void read<{ ok: boolean; value?: AskSetup; owner: boolean }>(`/${slug}/-/ask`).then((found) => {
      if (live) setAsk(found?.ok && found.value ? { ...found.value, owner: found.owner } : "failed");
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [slug]);

  // The open work items of the repository chosen, read once each.
  useEffect(() => {
    if (!repo || repo in items) return;
    let live = true;
    void read<AgentItemsData>(`/${slug}/-/chat/api/agent?items=${encodeURIComponent(repo)}`).then((found) => {
      if (live) setItems((now) => ({ ...now, [repo]: found?.items ?? null }));
    });
    return () => {
      live = false;
    };
  }, [repo, items, slug]);

  const loaded = data != null && data !== "failed";
  const repos = useMemo(() => (loaded ? (data.repos ?? []) : []), [loaded, data]);
  const suggested = loaded ? data.suggested : null;
  const g1t = repo === NO_REPO;
  const setup = loaded ? data.setup : null;
  const hosted = setup?.available === true;
  const askReady = ask != null && ask !== "failed" && ask.problem == null;
  const owner = (loaded && data.owner) || (ask != null && ask !== "failed" && ask.owner);
  const ready = repo != null && (g1t ? askReady : hosted);

  const repoOptions = useMemo<ComboboxOption[]>(
    () => [
      {
        value: NO_REPO,
        label: "No repository",
        description: "g1t answers, from what it can read",
        icon: <MarkGlyph className="h-3" />,
        keywords: ["ask", "g1t"],
      },
      ...pickerRepos({ repos, page, suggested }).map((path) => ({
        value: path,
        label: repoName(path),
        description: path === suggested ? `${path} · used most` : path,
        icon: <FolderGit2 />,
        keywords: [path],
      })),
    ],
    [repos, page, suggested],
  );
  const listed = repo ? items[repo] : undefined;
  const itemOptions = useMemo<ComboboxOption[]>(() => {
    const options: ComboboxOption[] = [{ value: "", label: "No work item", description: "It works on what you ask, tied to nothing" }];
    for (const one of listed ?? [])
      options.push({ value: String(one.number), label: `#${one.number} ${one.title}`, keywords: [one.title, String(one.number)] });
    // One from the page that is not among the repository's open ones still shows as chosen.
    if (item != null && !(listed ?? []).some((one) => one.number === item)) options.push({ value: String(item), label: `#${item}` });
    return options;
  }, [listed, item]);

  const send = async () => {
    const asked = text.trim();
    if (!asked || busy || !ready || repo == null) return;
    setBusy(true);
    setError(null);
    remember(slug, repo);
    if (g1t) {
      // A new conversation in your direct message with g1t, told the page it was asked from.
      const asked_ = await askInChat(slug, { text: asked, page, fresh: true });
      setBusy(false);
      if ("error" in asked_) return setError(asked_.error);
      onDone();
      return navigate(asked_.to);
    }
    try {
      const response = await fetch(`/${slug}/-/chat/api/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, prompt: asked, item: item ?? undefined, mode: item != null ? mode : undefined }),
      });
      const answer = (await response.json().catch(() => null)) as { to?: string; error?: string } | null;
      if (!answer?.to) {
        setBusy(false);
        return setError(answer?.error ?? "The session could not be started. Try again in a moment.");
      }
      onDone();
      navigate(answer.to);
    } catch {
      setBusy(false);
      setError("g1t could not be reached. Check your connection and try again.");
    }
  };

  const where = g1t && page ? askWhere(page) : null;
  const modeLabel = AGENT_MODES.find((one) => one.mode === mode)?.label ?? "Implement";

  return (
    <div className="px-5 pt-1.5 pb-5">
      <PromptBox>
        <PromptBoxInput
          ref={input}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onSend={() => void send()}
          busy={busy}
          maxLength={MAX_PROMPT_CHARS}
          rows={3}
          placeholder={
            g1t ? "Ask g1t what changed, what's blocked, or what to do next" : repo ? `What should Claude do in ${repoName(repo)}?` : "What do you want done?"
          }
          aria-label="What do you want done"
        />
        <PromptBoxToolbar
          end={<PromptBoxSend label={g1t ? "Ask g1t" : "Start agent work"} disabled={!ready || !text.trim()} busy={busy} onClick={() => void send()} />}
        >
          {data == null ? (
            <Skeleton className="mx-1 h-5 w-28 rounded-full" />
          ) : data === "failed" || data.repos == null ? (
            <span className="px-2">
              <Unavailable what="Repositories" compact />
            </span>
          ) : (
            <>
              <Combobox
                variant="pill"
                options={repoOptions}
                value={repo ?? NO_REPO}
                onValueChange={(next) => {
                  setRepo(next);
                  setItem(null);
                  requestAnimationFrame(() => input.current?.focus());
                }}
                searchPlaceholder="Find a repository"
                emptyText="No repository matches."
                aria-label="Repository"
              />
              {!g1t && (
                <Combobox
                  variant="pill"
                  options={itemOptions}
                  value={item == null ? "" : String(item)}
                  onValueChange={(next) => setItem(next ? Number(next) : null)}
                  placeholder="Work item"
                  searchPlaceholder={listed === undefined ? "Loading work items…" : "Find an open work item"}
                  emptyText={listed === null ? "Work items could not be loaded." : "No open work item matches."}
                  aria-label="Work item"
                  className={item == null ? "text-faint" : undefined}
                />
              )}
              {!g1t && item != null && (
                <DropdownMenu>
                  <DropdownMenuTrigger className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted outline-none hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=open]:bg-raised data-[state=open]:text-fg">
                    <ListChecks size={13} />
                    {modeLabel}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel>What to do with #{item}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={mode} onValueChange={(next) => setMode(next as AgentMode)}>
                      {AGENT_MODES.map((one) => (
                        <DropdownMenuRadioItem key={one.mode} value={one.mode} className="items-start">
                          <span className="flex flex-col">
                            <span>{one.label}</span>
                            <span className="text-xs text-faint">{one.hint}</span>
                          </span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {where && (
                <span className="flex items-center gap-1 px-2 text-xs text-faint">
                  <CircleDot size={12} />
                  {where}
                </span>
              )}
            </>
          )}
        </PromptBoxToolbar>
      </PromptBox>
      <div className="mt-2.5 min-h-5 px-1 text-xs leading-relaxed text-faint">
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : repo == null ? null : g1t ? (
          ask == null ? null : ask === "failed" ? (
            <Unavailable what="What Ask answers with" compact />
          ) : ask.problem == null ? (
            <p>
              g1t answers in your direct message with it, with {ask.provider_name} · <span className="font-mono">{modelLabel(ask)}</span>, on the
              workspace&apos;s own key.
            </p>
          ) : (
            <NotSetUp
              what="Ask needs one of the workspace's AI providers."
              problem={ask.problem}
              setup={owner ? { to: `/${slug}/-/settings/ai#ask`, label: "Connect a provider and choose it for Ask" } : null}
              slug={slug}
              onDone={onDone}
            />
          )
        ) : setup == null ? (
          <Unavailable what="Whether agents can start here" compact />
        ) : hosted ? (
          <p>
            g1t starts a hosted session for it on {setup.connectionName ? `the ${setup.connectionName} connection` : "the workspace's Anthropic account"}
            {setup.model && (
              <>
                {" "}
                with <span className="font-mono">{setup.model}</span>
              </>
            )}
            , billed by Anthropic to the workspace. g1t links it in your conversation with it, where you follow it.
          </p>
        ) : (
          <NotSetUp
            what="Agents run on the workspace's own Anthropic account, which is not connected yet."
            problem={setup.problem}
            setup={owner ? { to: `/${slug}/-/settings/ai`, label: "Connect Anthropic" } : null}
            slug={slug}
            onDone={onDone}
            alternative="Or choose No repository to ask g1t."
          />
        )}
      </div>
    </div>
  );
}

/** Why it cannot start yet: an owner gets the way to set it up, anyone else is told to ask one. */
function NotSetUp({
  what,
  problem,
  setup,
  slug,
  onDone,
  alternative,
}: {
  what: string;
  problem: string | null;
  setup: { to: string; label: string } | null;
  slug: string;
  onDone: () => void;
  alternative?: string;
}) {
  return (
    <p className="text-muted">
      {problem ?? what}{" "}
      {setup ? (
        <Link to={setup.to} onClick={onDone} className="text-accent hover:underline">
          {setup.label}
        </Link>
      ) : (
        <>Ask an owner of {slug} to set it up.</>
      )}
      {alternative && <> {alternative}</>}
    </p>
  );
}
