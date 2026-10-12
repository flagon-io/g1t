import { ArrowUp } from "lucide-react";

import { Button } from "./ui/button";

/**
 * "3 new commits · Show": what arrived while the reader was on the page,
 * held back so the list does not move under them (lib/use-repo-live.ts,
 * `hold`). Nothing when nothing is held. `count` null: arrived, uncounted.
 */
export function NewItemsBar({ held, count, noun, onShow }: { held: boolean; count: number | null; noun: [string, string]; onShow: () => void }) {
  if (!held) return null;
  const label = count == null || count < 1 ? `New ${noun[1]}` : `${count} new ${count === 1 ? noun[0] : noun[1]}`;
  return (
    <div role="status" className="mb-3 flex justify-center">
      <Button variant="soft" size="xs" onClick={onShow} className="rounded-full px-3">
        <ArrowUp size={12} aria-hidden />
        {label}
        <span aria-hidden className="text-faint">
          ·
        </span>
        Show
      </Button>
    </div>
  );
}
