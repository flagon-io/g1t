import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useLocation, useRevalidator } from "react-router";

import { Card } from "./ui/card";

/** Says a section could not be loaded, without taking the page down. */
export function Unavailable({ what }: { what: string }) {
  return (
    <Card asChild tone="plain" className="flex items-center gap-2 border-dashed px-4 py-5 text-sm text-muted">
      <p>
        <TriangleAlert size={14} className="text-warn" />
        {what} could not be loaded just now. It will be back on the next refresh.
      </p>
    </Card>
  );
}

/**
 * Keeps a part of a page that fails to draw to itself: in its place it says
 * that `what` could not be loaded, and the rest of the page stays. It tries
 * again on the next refresh or navigation (whatever reloads the page's
 * data). Data a part could not fetch is the loader's to say
 * (lib/partial.server.ts `soft`); this catches what breaks while drawing.
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
