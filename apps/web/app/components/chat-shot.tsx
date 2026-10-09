/**
 * Static pictures of the product for the landing page: a channel where a
 * person and an agent talk over a pull request, and an agent's profile.
 * Drawn in the app's own tokens so they read as the real thing; nothing
 * here loads data.
 */
import {
  AtSign,
  Bot,
  BookOpen,
  Check,
  Code2,
  GitMerge,
  GitPullRequest,
  Hash,
  Home,
  Inbox,
  MessagesSquare,
  Paperclip,
  SendHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import { AgentAvatar } from "./agent-avatar";

/** A round letter avatar: lavender for agents, gray for people. */
function Face({ letter, agent, size = "md" }: { letter: string; agent?: boolean; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold",
        size === "sm" && "size-5 text-[0.625rem]",
        size === "md" && "size-8 text-xs",
        size === "lg" && "size-12 text-lg",
        agent ? "rounded-lg bg-accent/15 text-accent ring-1 ring-accent/30" : "rounded-full bg-raised text-fg-soft ring-1 ring-line-strong",
      )}
    >
      {letter}
    </span>
  );
}

/** The small tag beside an agent's name. */
function AgentTag() {
  return (
    <span className="rounded bg-accent/15 px-1 py-px font-mono text-[0.5625rem] tracking-wide text-accent uppercase">Agent</span>
  );
}

function Message({
  face,
  name,
  agent,
  role,
  time,
  children,
}: {
  face: ReactNode;
  name: string;
  agent?: boolean;
  role?: string;
  time: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 px-4 py-2.5">
      {face}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-[0.8125rem]">
          <span className="font-semibold text-fg">{name}</span>
          {agent && <AgentTag />}
          {role && <span className="text-xs text-faint">{role}</span>}
          <span className="text-[0.6875rem] text-faint">{time}</span>
        </p>
        <div className="mt-0.5 space-y-2 text-[0.8125rem] leading-6 text-fg-soft">{children}</div>
      </div>
    </div>
  );
}

function Mention({ children }: { children: ReactNode }) {
  return <span className="rounded bg-accent/15 px-0.5 text-accent">{children}</span>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-raised px-1 py-px font-mono text-[0.75rem] text-fg">{children}</code>;
}

/** The pull request card an agent posts into the thread. */
function PullCard() {
  return (
    <div className="max-w-md rounded-xl bg-bg ring-1 ring-line">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <GitPullRequest size={16} className="mt-0.5 shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="text-[0.8125rem] font-medium text-fg">Invite emails use the team name</p>
          <p className="mt-0.5 font-mono text-[0.6875rem] text-faint">acme/web #418 · fixes #412</p>
        </div>
        <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[0.6875rem] font-medium text-success">Ready</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3.5 py-2 text-[0.6875rem] text-muted">
        <span className="flex items-center gap-1.5">
          <Check size={12} className="text-success" />3 of 3 checks passed
        </span>
        <span className="font-mono">
          <span className="text-success">+24</span> <span className="text-danger">−6</span>
        </span>
        <span>Reviewed by @lint</span>
      </div>
    </div>
  );
}

const RAIL: { icon: ReactNode; label: string; on?: boolean }[] = [
  { icon: <Home size={16} />, label: "Home" },
  { icon: <Code2 size={16} />, label: "Code" },
  { icon: <MessagesSquare size={16} />, label: "Chat", on: true },
  { icon: <BookOpen size={16} />, label: "Docs" },
  { icon: <Bot size={16} />, label: "Agents" },
  { icon: <Inbox size={16} />, label: "Inbox" },
];

const CHANNELS: { name: string; on?: boolean; unread?: number }[] = [
  { name: "web", on: true },
  { name: "releases", unread: 2 },
  { name: "support" },
  { name: "design" },
];

const DMS: { name: string; agent?: boolean; letter: string }[] = [
  { name: "Ship", agent: true, letter: "S" },
  { name: "Lint", agent: true, letter: "L" },
  { name: "Priya Shah", letter: "P" },
];

/**
 * A channel in the Chat mode: the rail, the channel list, and a short
 * exchange where an agent answers, links the pull request it made, and
 * waits for a person to approve the merge.
 */
export function ChatShot({ className }: { className?: string }) {
  return (
    <figure
      aria-label="A channel in g1t: a person asks an agent about a release, and the agent answers with the pull request it opened"
      className={cn("overflow-hidden rounded-2xl bg-surface text-left shadow-2xl shadow-black/40 ring-1 ring-line", className)}
    >
      <div className="flex min-h-[27rem]">
        {/* The rail. */}
        <nav aria-hidden="true" className="hidden w-14 shrink-0 flex-col items-center gap-1.5 border-r border-line bg-bg py-3 md:flex">
          {RAIL.map((item) => (
            <span
              key={item.label}
              className={cn(
                "flex size-9 items-center justify-center rounded-lg",
                item.on ? "bg-accent/15 text-accent" : "text-faint",
              )}
            >
              {item.icon}
            </span>
          ))}
        </nav>

        {/* The channel list. */}
        <div aria-hidden="true" className="hidden w-52 shrink-0 border-r border-line px-2 py-3 lg:block">
          <p className="px-2 text-[0.8125rem] font-semibold text-fg">Acme</p>
          <p className="mt-4 px-2 text-[0.6875rem] font-medium text-faint">Channels</p>
          <ul className="mt-1 space-y-px">
            {CHANNELS.map((channel) => (
              <li
                key={channel.name}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.8125rem]",
                  channel.on ? "bg-raised text-fg" : "text-muted",
                )}
              >
                <Hash size={13} className="text-faint" />
                <span className="flex-1">{channel.name}</span>
                {channel.unread && (
                  <span className="rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold text-bg">{channel.unread}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-4 px-2 text-[0.6875rem] font-medium text-faint">Direct messages</p>
          <ul className="mt-1 space-y-px">
            {DMS.map((dm) => (
              <li key={dm.name} className="flex items-center gap-2 rounded-md px-2 py-1 text-[0.8125rem] text-muted">
                <Face letter={dm.letter} agent={dm.agent} size="sm" />
                <span className="flex-1">{dm.name}</span>
                {dm.agent && <span className="size-1.5 rounded-full bg-success" />}
              </li>
            ))}
          </ul>
        </div>

        {/* The channel. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Hash size={15} className="text-faint" />
            <span className="text-sm font-semibold text-fg">web</span>
            <span className="hidden truncate text-xs text-faint sm:inline">The web app, its releases and its bugs</span>
            <span className="ml-auto flex -space-x-1.5" aria-hidden="true">
              <Face letter="P" size="sm" />
              <Face letter="S" agent size="sm" />
              <Face letter="L" agent size="sm" />
              <Face letter="D" size="sm" />
            </span>
          </div>

          <div className="flex-1 py-2">
            <Message face={<Face letter="P" />} name="Priya Shah" time="10:42">
              <p>
                <Mention>@ship</Mention> what is left before Thursday&apos;s release?
              </p>
            </Message>
            <Message face={<Face letter="S" agent />} name="Ship" agent role="Release manager" time="10:42">
              <p>
                One thing: <span className="text-accent">#412</span>, invite emails show the workspace name instead of the
                team&apos;s. The fix is ready. The subject now comes from <Code>invite_subject()</Code>, with a test for both
                names.
              </p>
              <PullCard />
              <p>It needs one approval from a person, then it lands through the merge queue.</p>
            </Message>
            <Message face={<Face letter="P" />} name="Priya Shah" time="10:44">
              <p>Approved. Thanks!</p>
            </Message>
            <div className="flex items-center gap-2 px-4 pt-1 text-xs text-faint">
              <GitMerge size={13} className="text-merged" />
              <span>
                <span className="text-fg-soft">#418</span> merged to main · deploying to production
              </span>
            </div>
          </div>

          <div className="px-4 pb-4">
            <div className="flex items-center gap-2 rounded-xl bg-bg px-3 py-2.5 text-[0.8125rem] text-faint ring-1 ring-line">
              <span className="flex-1">Message #web</span>
              <AtSign size={15} />
              <Paperclip size={15} />
              <SendHorizontal size={15} className="text-accent" />
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}

function Field({ label, children, soon }: { label: string; children: ReactNode; soon?: boolean }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 border-t border-line px-5 py-3 text-[0.8125rem]">
      <dt className="text-faint">
        {label}
        {soon && <span className="sr-only"> (coming soon)</span>}
      </dt>
      <dd className="min-w-0 text-fg-soft">{children}</dd>
    </div>
  );
}

/** An agent's profile: who it is, what it answers for, how it talks, what it may use and spend. */
export function AgentCardShot({ className }: { className?: string }) {
  const spent = 12.4;
  const budget = 40;
  return (
    <figure
      aria-label="An agent's profile in g1t: Margo, a QA Engineer on the QA team, with her responsibilities, voice, model routing, budget and what she may do alone"
      className={cn("overflow-hidden rounded-2xl bg-surface text-left ring-1 ring-line", className)}
    >
      <div className="flex items-center gap-4 px-5 py-5">
        <AgentAvatar agent={{ handle: "margo", name: "Margo" }} size={48} />
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold text-fg">
            Margo <AgentTag />
          </p>
          <p className="text-sm text-muted">@margo · QA Engineer on the QA team</p>
        </div>
        <span className="ml-auto hidden items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs text-success sm:flex">
          <span className="size-1.5 rounded-full bg-success" />
          Idle
        </span>
      </div>
      <dl>
        <Field label="Answers for">
          <ul className="space-y-0.5">
            <li>Reviewing pull requests for risk and test coverage</li>
            <li>Test plans for new features</li>
            <li>Chasing flaky checks</li>
          </ul>
        </Field>
        <Field label="Personality">
          <span className="text-fg">Crisp.</span> Short answers, points at the exact line, proposes the fix.
        </Field>
        <Field label="Models">
          <span className="text-fg">Auto</span>, never below Standard
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <span className="rounded-md bg-raised px-1.5 py-0.5 text-xs text-muted ring-1 ring-line">g1t&apos;s models</span>
            <span className="rounded-md bg-raised px-1.5 py-0.5 text-xs text-muted ring-1 ring-line">Your own provider</span>
          </span>
        </Field>
        <Field label="Subagents">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs text-muted ring-1 ring-line">flake-hunter</span>
            <span className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-xs text-muted ring-1 ring-line">migration-checker</span>
            <span className="text-xs text-faint">run soon</span>
          </span>
        </Field>
        <Field label="Budget">
          <span className="font-mono text-xs text-fg tabular-nums">
            ${spent.toFixed(2)} of ${budget} this month
          </span>
          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-raised">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${(spent / budget) * 100}%` }} />
          </span>
          <span className="mt-1.5 block text-xs text-faint">$5 a task</span>
        </Field>
        <Field label="Asks first">Merge · Deploy to production</Field>
      </dl>
    </figure>
  );
}
