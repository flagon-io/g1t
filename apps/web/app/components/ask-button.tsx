/**
 * The top bar's Ask: the lavender pixel 1 beside its words. The panel it
 * opens (components/ask-composer.tsx: the direct message with @g1t, its
 * answers drawn with Markdown, code and tool steps) is loaded the first
 * time it is wanted, starting when the pointer comes near, so no page
 * carries it until then. Kept mounted once loaded, so the conversation
 * stays while the panel is closed.
 */
import { Suspense, lazy, useState } from "react";

import { MarkGlyph } from "./logo";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";

const load = () => import("./ask-composer");
const AskSheet = lazy(() => load().then((module) => ({ default: module.AskSheet })));

export function AskButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
  const change = (next: boolean) => {
    if (next) setWanted(true);
    setOpen(next);
  };
  return (
    <Sheet open={open} onOpenChange={change}>
      <Hint label="Ask g1t about your work">
        <SheetTrigger asChild>
          <Button variant="soft" size="bar" aria-label="Ask g1t" className="gap-2 max-md:ring-0 lg:px-3" onPointerEnter={() => void load()} onFocus={() => void load()}>
            <MarkGlyph className="h-3.5" />
            <span className="max-lg:hidden">Ask</span>
          </Button>
        </SheetTrigger>
      </Hint>
      {wanted && (
        <Suspense fallback={<Loading />}>
          <AskSheet slug={slug} open={open} />
        </Suspense>
      )}
    </Sheet>
  );
}

/** The panel's frame while it loads. */
function Loading() {
  return (
    <SheetContent side="right" className="sm:max-w-xl">
      <SheetTitle className="sr-only">Ask g1t</SheetTitle>
      <div className="flex flex-col gap-3 p-5" aria-busy="true">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-56" />
      </div>
    </SheetContent>
  );
}
