/**
 * The top bar's Ask: the lavender pixel 1 beside its words. It opens
 * Chat's New over the page you are on (components/chat/actions.tsx), on
 * its agent composer: a hosted session in a repository, or with no
 * repository g1t's answer in your direct message with it. The composer
 * starts on the page's repository and work item, and g1t is told the page.
 *
 * A page that asks g1t a question itself (Home's box, Summarize, Explain:
 * lib/ask.ts askG1t) sends it to your direct message with g1t and opens it
 * in Chat, where the answer streams; one that only opens Ask (openAsk)
 * opens that conversation.
 */
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { ASK_EVENT, askPage } from "../lib/ask";
import { askInChat } from "../lib/ask-in-chat";
import { NewChatDialog } from "./chat/actions";
import { MarkGlyph } from "./logo";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";

export function AskButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  // A question a page asked that could not be sent: in the box when New opens.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const location = useLocation();
  const navigate = useNavigate();
  // Any completed navigation closes it: what it opened is the page now.
  useEffect(() => setOpen(false), [location.key]);
  useEffect(() => {
    const onAsk = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text?.trim();
      void askInChat(slug, { text, page: askPage(window.location.pathname) }).then((asked) => {
        // Not sent: New opens with the question in its box, to send again or set up.
        if ("error" in asked) {
          setDraft(text);
          return setOpen(true);
        }
        navigate(asked.to);
      });
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [slug, navigate]);
  return (
    <>
      <Hint label="Ask g1t, or start an agent">
        <Button variant="soft" size="bar" aria-label="Ask g1t" className="gap-2 max-md:ring-0 lg:px-3" onClick={() => setOpen(true)}>
          <MarkGlyph className="h-3.5" />
          <span className="max-lg:hidden">Ask</span>
        </Button>
      </Hint>
      <NewChatDialog
        slug={slug}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setDraft(undefined);
        }}
        page={open ? askPage(location.pathname) : null}
        text={draft}
      />
    </>
  );
}
