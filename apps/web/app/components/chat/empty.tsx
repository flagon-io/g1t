import { Check, Hash, Lock, MessagesSquare, PlugZap } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useParams } from "react-router";

import { CreateChannelButton, NewMessageButton } from "./actions";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Textarea } from "../ui/textarea";

/** A calm full-height panel for a conversation that cannot be shown. */
function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex h-(--page-h) items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <Card className="mx-auto flex size-12 items-center justify-center text-muted">{icon}</Card>
        <h1 className="mt-4 text-base font-semibold">{title}</h1>
        <div className="mt-1.5 text-sm text-muted">{children}</div>
      </div>
    </div>
  );
}

/** Chat did not answer: it may be deploying a moment after the site. */
export function ChatUnavailable({ title = "Chat" }: { title?: string }) {
  return (
    <Panel icon={<PlugZap size={20} />} title={`${title} isn't reachable right now`}>
      Chat didn't answer. It's usually back within a minute; reload to try again. Nothing you sent is lost.
    </Panel>
  );
}

/** A workspace with no conversations yet. */
export function NoChannels() {
  const { owner = "" } = useParams();
  return (
    <Panel icon={<MessagesSquare size={20} />} title="Start the first conversation">
      <p>Channels keep a topic in one place. Direct messages are for one person or a few.</p>
      <div className="mt-5 flex justify-center gap-2">
        <CreateChannelButton slug={owner.toLowerCase()} variant="button" />
        <NewMessageButton slug={owner.toLowerCase()} variant="button" />
      </div>
    </Panel>
  );
}

/** A channel's name with its mark, as the header and the sidebar show it. */
export function ChannelGlyph({ className }: { className?: string }) {
  return <Hash size={16} className={className} />;
}

/**
 * A channel's link that does not open for the viewer: private, kept to a
 * workspace they are not in, or not there at all, which reads the same so
 * nothing about a channel they may not see is told. They may ask whoever
 * could add them to let them in, with a note.
 */
export function RequestAccess({ name, workspace, member }: { name: string; workspace: { slug: string; name: string }; member: boolean }) {
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const ask = async () => {
    setState("sending");
    try {
      const response = await fetch(`/${workspace.slug}/-/chat/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "request_access", name, note }),
      });
      const result = (await response.json()) as { ok: boolean };
      setState(result.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  };
  return (
    <Panel icon={<Lock size={20} />} title={`You can't open #${name}`}>
      <p>
        {member
          ? `If #${name} is a private channel in ${workspace.name}, only the people in it can read it.`
          : `You're not a member of ${workspace.name}. If #${name} is one of its channels, it's for its members or the people asked into it.`}{" "}
        You can ask to be let in: whoever could add you will see your request.
      </p>
      {state === "sent" ? (
        <p className="mt-5 inline-flex items-center gap-1.5 text-fg">
          <Check size={15} className="text-accent" />
          Asked. You'll find it in your sidebar once someone lets you in.
        </p>
      ) : (
        <div className="mt-5 space-y-2 text-left">
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={300}
            rows={3}
            placeholder="Say who you are and why you'd like in (optional)"
            aria-label="A note for whoever lets you in"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-danger">{state === "failed" ? "That didn't go through. Try again." : ""}</span>
            <Button type="button" onClick={() => void ask()} disabled={state === "sending"}>
              {state === "sending" ? "Asking…" : "Ask to join"}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
