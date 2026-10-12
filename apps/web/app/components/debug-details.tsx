import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useMatches } from "react-router";

import appCss from "../app.css?url";
import { clientNavigated } from "../lib/stale-build";
import { debugReport, describeError } from "../lib/developer-mode";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/**
 * On a page that failed, with developer mode on (lib/developer-mode.ts):
 * the error itself, its stack and where it happened, and a button that
 * copies all of it as one report.
 */
export function DebugDetails({ error }: { error: unknown }) {
  const location = useLocation();
  const matches = useMatches();
  // The browser's facts once it is in the browser; the server draws without them.
  const [browser, setBrowser] = useState<{ url: string; userAgent: string; desktop: string | null; at: Date } | null>(null);
  useEffect(() => {
    setBrowser({ url: window.location.href, userAgent: navigator.userAgent, desktop: window.g1tDesktop?.version ?? null, at: new Date() });
  }, [location.key, error]);
  const report = debugReport({
    url: browser?.url ?? location.pathname + location.search + location.hash,
    at: browser?.at ?? null,
    error,
    routes: matches.map((match) => match.id),
    build: appCss.split("/").pop() ?? appCss,
    userAgent: browser?.userAgent ?? "",
    desktop: browser?.desktop,
    navigation: clientNavigated(location.key) ? "client" : "document",
  });
  const described = describeError(error);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an old browser, or one that refused): the text is there to select.
    }
  };
  return (
    <Card tone="plain" radius="lg" className="mt-8 text-left">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">Developer mode</p>
          <p className="truncate text-xs text-muted">
            {described.kind}
            {described.status ? ` ${described.status}` : ""}: {described.message}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={copy} className="shrink-0">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy details"}
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto p-4 text-xs leading-relaxed whitespace-pre-wrap wrap-break-word">
        <code>{report}</code>
      </pre>
    </Card>
  );
}
