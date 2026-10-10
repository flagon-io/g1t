import { Hash, MessagesSquare, PlugZap } from "lucide-react";
import type { ReactNode } from "react";
import { useParams } from "react-router";

import { CreateChannelButton, NewMessageButton } from "./actions";

/** A calm full-height panel for a conversation that cannot be shown. */
function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex h-(--page-h) items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-line bg-surface text-muted">{icon}</div>
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
      <p>Channels keep a topic in one place. Direct messages are for one person, a few, or an agent.</p>
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
