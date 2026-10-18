/**
 * One answer from @g1t, as it shows wherever g1t answers: the top bar's
 * Ask (components/ask-composer.tsx) and its direct message in Chat
 * (components/chat/channel.tsx). Thinking until its first words, the words
 * as they stream, then the answer with who wrote it and what can be done
 * with it: copy it, or have g1t answer again.
 */
import { Check, CircleAlert, Copy, CornerDownRight, RefreshCw, Settings2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { AskPage, ChatMessage } from "@g1t/contracts";

import { answerLabel, answering, askedFrom, cutOff } from "../../lib/g1t-chat";
import { AskTrail } from "../ask-steps";
import { Loader } from "../ai-elements/loader";
import { MessageAction, MessageActions } from "../ai-elements/message";
import { MessageResponse, type ResponseContext } from "../ai-elements/response";
import { FolioUnfurls } from "../folios/unfurl";
import { Alert } from "../ui/alert";
import { Badge } from "../ui/badge";

export function G1tAnswer({
  message,
  context,
  onRetry,
  steps,
  actions = true,
}: {
  message: ChatMessage;
  context: ResponseContext;
  /** Answer the question again; only on the latest answer. */
  onRetry?: () => void;
  /** Drawn above its words instead of the steps it kept (g1t's tool calls). */
  steps?: ReactNode;
  /** Whether to show the row of actions under it. */
  actions?: boolean;
}) {
  const answer = message.answer ?? null;
  const live = answering(answer);
  const [copied, setCopied] = useState(false);
  const label = answerLabel(answer);
  const copy = () => {
    void navigator.clipboard?.writeText(message.body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Ask is not set up: g1t's note says where an owner chooses a provider.
  if (answer?.setup === "missing") {
    return (
      <Alert tone="info" className="flex items-start gap-2.5 px-3.5 py-3">
        <Settings2 size={15} className="mt-1 shrink-0 text-info" />
        <MessageResponse context={context}>{message.body}</MessageResponse>
      </Alert>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      {steps ?? <AskTrail events={answer?.steps} working={live} part="steps" />}
      {answer?.state === "thinking" && !message.body ? (
        <Loader />
      ) : answer?.state === "error" ? (
        <div className="flex items-start gap-2 text-sm text-muted">
          <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
          <MessageResponse context={context} className="text-sm text-muted">
            {message.body}
          </MessageResponse>
        </div>
      ) : (
        <MessageResponse context={context} streaming={live}>
          {message.body}
        </MessageResponse>
      )}
      {!live && <AskTrail events={answer?.steps} working={false} part="proposals" slug={context.slug} message={message} />}
      {!live && <AskTrail events={answer?.steps} working={false} part="sources" />}
      {!live && message.body && <FolioUnfurls slug={context.slug} body={message.body} />}
      {actions && !live && (
        <MessageActions className="-ml-1.5">
          {answer?.state !== "error" && (
            <MessageAction label={copied ? "Copied" : "Copy answer"} onClick={copy}>
              {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            </MessageAction>
          )}
          {onRetry && (
            <MessageAction label="Answer again" onClick={onRetry}>
              <RefreshCw size={14} />
            </MessageAction>
          )}
          {label && (
            <Badge className="ml-1 px-1.5 py-0 font-normal">
              <span className="max-w-64 truncate">{label}</span>
            </Badge>
          )}
          {answer?.state === "stopped" && <span className="ml-1.5">Stopped</span>}
          {cutOff(answer) && <span className="ml-1.5">Cut off at the length limit</span>}
        </MessageActions>
      )}
    </div>
  );
}

/** "New conversation": where g1t started reading afresh. */
export function ConversationMark() {
  return (
    <div role="separator" aria-label="New conversation" className="relative my-1 flex items-center justify-center">
      <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-line" />
      <Badge className="relative bg-bg px-3 py-0.5 text-faint">New conversation</Badge>
    </div>
  );
}

/**
 * Under a question to @g1t asked on a page: which page, so "this pull
 * request" reads as the one it was. g1t was told the same.
 */
export function AskedFrom({ page }: { page: AskPage | null | undefined }) {
  const from = askedFrom(page);
  if (!from) return null;
  return (
    <a
      href={from.href}
      className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-faint hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <CornerDownRight size={12} aria-hidden="true" className="shrink-0" />
      <span className="truncate">Asked on {from.label}</span>
    </a>
  );
}
