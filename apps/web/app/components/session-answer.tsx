/**
 * Answering a hosted session while it runs, on its page
 * (routes/workspace/work/sessions/session.tsx): a card for each call that
 * waits for someone to allow or deny it, and the box at the bottom to steer,
 * stop or follow it up.
 * Each is a fetcher form posting the page's own action, so what is pending
 * and what went wrong show in place, and the page reads the session again
 * once it is answered. What a call does (`ApprovalWhat`) and its Allow and
 * Deny (`AnswerButtons`) are the same on Needs attention's card
 * (components/needs-attention.tsx).
 */
import { RotateCcw, SendHorizontal, ShieldAlert } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useFetcher } from "react-router";

import type { AgentApproval } from "@g1t/contracts";

import { cn } from "../lib/cn";
import type { Submission } from "../lib/pending";
import { APPROVAL_ANSWERED_EVENT, approvalWhat, timeLeft, toolName } from "../lib/session-approvals";
import { Input, SubmitButton, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { PromptBox, PromptBoxInput, PromptBoxSend, PromptBoxStop, PromptBoxToolbar } from "./chat/prompt-box";

/** What the page's action answers a fetcher with. */
type Answered = { error?: string; answered?: boolean; sent?: boolean } | null | undefined;

/**
 * What a call wants to do: its tool, and the call in one line as the
 * transcript shows it, secrets already hidden by the integrations service.
 * The same wherever a call is answered: its session's page and Needs
 * attention.
 */
export function ApprovalWhat({ approval, className }: { approval: Pick<AgentApproval, "tool" | "summary">; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-baseline gap-2", className)}>
      <Badge shape="tag" className="font-mono">
        {toolName(approval.tool)}
      </Badge>
      <code className="min-w-0 font-mono text-[0.8125rem] break-all whitespace-pre-wrap text-fg">{approvalWhat(approval)}</code>
    </div>
  );
}

/**
 * Allow and Deny for one call, inside its fetcher's form: the call it
 * answers, and the answer, which shows as pending on its own button.
 */
export function AnswerButtons({ approval, fetcher }: { approval: Pick<AgentApproval, "toolUseId">; fetcher: Submission }) {
  return (
    <>
      <input type="hidden" name="toolUseId" value={approval.toolUseId} />
      <SubmitButton size="sm" name="answer" value="allow" fetcher={fetcher} pending="Allowing…">
        Allow
      </SubmitButton>
      <SubmitButton size="sm" variant="outline" name="answer" value="deny" fetcher={fetcher} pending="Denying…">
        Deny
      </SubmitButton>
    </>
  );
}

/**
 * A call that waits for approval: its tool, what it wants to do (one line,
 * secrets hidden, as the transcript shows it), how long it has left, and
 * Allow or Deny, with why for a denial, told to the session. Its anchor
 * (`#approval-…`) is where its starter's notification links.
 */
export function ApprovalCard({ approval, now }: { approval: AgentApproval; now: number }) {
  const fetcher = useFetcher<Answered>();
  const heading = useId();
  const error = fetcher.state === "idle" ? fetcher.data?.error : undefined;
  // Needs attention and Recents, beside the page, read again: the call no longer waits.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.answered) window.dispatchEvent(new Event(APPROVAL_ANSWERED_EVENT));
  }, [fetcher.state, fetcher.data]);
  return (
    <Card asChild className="scroll-mt-20 border-warn/40 bg-warn/5 p-4">
      <section id={`approval-${approval.toolUseId}`} aria-labelledby={heading}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ShieldAlert size={16} className="shrink-0 text-warn" />
          <h2 id={heading} className="text-[0.9375rem] font-semibold text-fg">
            Waiting for approval
          </h2>
          <span className="ml-auto text-xs text-faint" suppressHydrationWarning>
            asked <TimeAgo at={approval.askedAt} /> · {timeLeft(approval.expiresAt, now)}
          </span>
        </div>
        <ApprovalWhat approval={approval} className="mt-3" />
        <p className="mt-2 text-xs text-muted">Nobody answering in time declines it, and the session carries on without it.</p>
        <fetcher.Form method="post" className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="action" value="answer" />
          <AnswerButtons approval={approval} fetcher={fetcher} />
          <Input
            name="note"
            maxLength={1000}
            placeholder="Why, if you deny it (told to the session)"
            aria-label="Why you deny it"
            className="h-8 min-w-48 flex-1 text-sm"
          />
        </fetcher.Form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
      </section>
    </Card>
  );
}

/**
 * The box at the bottom of a hosted session's page, as a chat's composer
 * (components/chat/prompt-box.tsx). While it runs, what is written goes to
 * it as its next instruction (`message`), and Stop beside it interrupts it
 * (`stop`, for whoever started it). Once it has ended (`continue`), what is
 * written starts a new session that carries on from it, with its branch,
 * pull requests and report, and opens that one: an ended session cannot be
 * resumed, since its credentials went when it finished. Enter sends,
 * Shift+Enter starts a new line; cleared once sent.
 */
export function SessionMessageBox({ mode = "message", canStop = false }: { mode?: "message" | "continue"; canStop?: boolean }) {
  const fetcher = useFetcher<Answered>();
  const stopper = useFetcher<Answered>();
  const form = useRef<HTMLFormElement>(null);
  const stopId = useId();
  const error = fetcher.state === "idle" ? fetcher.data?.error : stopper.state === "idle" ? stopper.data?.error : undefined;
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.sent) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  const continuing = mode === "continue";
  return (
    <div className="sticky bottom-(--tabbar-h) z-10 -mx-4 mt-8 bg-linear-to-t from-bg via-bg/95 to-bg/0 px-4 pt-6 pb-4 in-data-[keyboard=open]:bottom-0 sm:mx-0 sm:px-0">
      {canStop && !continuing && (
        <stopper.Form method="post" id={stopId} className="hidden">
          <input type="hidden" name="action" value="stop" />
        </stopper.Form>
      )}
      <fetcher.Form ref={form} method="post" aria-label={continuing ? "Continue in a new session" : "Send to this session"}>
        <input type="hidden" name="action" value={continuing ? "continue" : "message"} />
        <PromptBox>
          <PromptBoxInput
            name="text"
            required
            maxLength={continuing ? 8000 : 4000}
            busy={busy}
            aria-label={continuing ? "What to do next, in a new session" : "Message to the session"}
            placeholder={continuing ? "Follow up: a new session carries on from this one" : "Steer it: tell it what to do next"}
          />
          <PromptBoxToolbar
            end={
              <>
                {canStop && !continuing && <PromptBoxStop form={stopId} busy={stopper.state !== "idle"} label="Stop the session" />}
                <PromptBoxSend label={continuing ? "Continue in a new session" : "Send"} busy={busy} />
              </>
            }
          >
            <span className="flex items-center gap-1.5 px-2 text-xs text-faint">
              {continuing ? <RotateCcw size={12} /> : <SendHorizontal size={12} />}
              {continuing ? "It has finished. Sending starts a new session that carries on from it." : "Goes to it as its next instruction."}
            </span>
          </PromptBoxToolbar>
        </PromptBox>
      </fetcher.Form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
