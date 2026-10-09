import { ArrowUp } from "lucide-react";
import { Suspense, lazy } from "react";

import type { ComposerProps } from "./editor";

// The editor (components/chat/editor.tsx) is loaded with the first composer,
// so pages without one never fetch it.
const ChatEditor = lazy(() => import("./editor"));

/**
 * Where a message is written: the formatting editor, with what it looks
 * like for the moment it takes to load. See components/chat/editor.tsx.
 */
export function Composer(props: ComposerProps) {
  return (
    <Suspense fallback={<Loading placeholder={props.placeholder} compact={props.compact} />}>
      <ChatEditor {...props} />
    </Suspense>
  );
}

/** The composer's frame, still, while the editor loads. */
function Loading({ placeholder, compact }: { placeholder: string; compact?: boolean }) {
  return (
    <div aria-busy="true" className="rounded-xl border border-line-strong bg-surface">
      <p className={`px-3.5 text-[0.9375rem] leading-6 text-faint ${compact ? "pt-2.5 pb-1" : "pt-3 pb-1.5"}`}>{placeholder}</p>
      <div className="flex items-center gap-1 px-2 pb-2">
        <span className="h-7" />
        <span aria-hidden="true" className="ml-auto flex size-8 items-center justify-center rounded-lg bg-line text-faint">
          <ArrowUp size={16} strokeWidth={2.4} />
        </span>
      </div>
    </div>
  );
}
