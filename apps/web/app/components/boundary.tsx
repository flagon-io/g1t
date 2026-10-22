import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useLocation, useRevalidator } from "react-router";

import { Card } from "./ui/card";

/**
 * Says a section could not be loaded, without taking the page down.
 * `compact`: one quiet line, for a sidebar's card or a count's place.
 */
export function Unavailable({ what, compact = false }: { what: string; compact?: boolean }) {
  if (compact) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <TriangleAlert size={12} className="shrink-0 text-warn" />
        {what} could not be loaded just now.
        <TryAgain />
      </p>
    );
  }
  return (
    <Card asChild tone="plain" className="flex flex-wrap items-center gap-2 border-dashed px-4 py-5 text-sm text-muted">
      <p>
        <TriangleAlert size={14} className="text-warn" />
        {what} could not be loaded just now.
        <TryAgain />
      </p>
    </Card>
  );
}

/** Loads the page's data again in place: what a section that could not be loaded offers. */
function TryAgain() {
  const revalidator = useRevalidator();
  const busy = revalidator.state !== "idle";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void revalidator.revalidate()}
      className="text-accent underline-offset-4 hover:underline disabled:text-faint disabled:no-underline"
    >
      {busy ? "Trying again…" : "Try again"}
    </button>
  );
}

/**
 * Keeps a part of a page that fails to draw to itself: in its place it says
 * that `what` could not be loaded, and the rest of the page stays. It tries
 * again on the next refresh or navigation (whatever reloads the page's
 * data). Data a part could not fetch is the loader's to say
 * (lib/partial.ts `part`); this catches what breaks while drawing.
 */
export function Boundary({ what, children, fallback }: { what: string; children: ReactNode; fallback?: ReactNode }) {
  const { key } = useLocation();
  const loads = useLoads();
  return (
    <Catch what={what} fallback={fallback} reset={`${key}:${loads}`}>
      {children}
    </Catch>
  );
}

/** How many times the page's data has loaded again in place (a refresh, a form). */
function useLoads(): number {
  const { state } = useRevalidator();
  const [loads, setLoads] = useState(0);
  const was = useRef(state);
  useEffect(() => {
    if (was.current !== "idle" && state === "idle") setLoads((n) => n + 1);
    was.current = state;
  }, [state]);
  return loads;
}

type CatchProps = { what: string; fallback?: ReactNode; reset: string; children: ReactNode };

class Catch extends Component<CatchProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`g1t: ${this.props.what} failed to draw`, error, info.componentStack);
  }

  componentDidUpdate(previous: CatchProps) {
    // Fresh data, or another page: draw it again.
    if (this.state.failed && previous.reset !== this.props.reset) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? <Unavailable what={this.props.what} />;
    return this.props.children;
  }
}
