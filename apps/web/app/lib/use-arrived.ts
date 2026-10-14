import { useEffect, useState } from "react";

/**
 * `initial` until `promise` settles, then what it resolved to: for a value
 * a loader streams in after the page, shown in place when it arrives. A
 * promise that rejects leaves `initial`.
 */
export function useArrived<T, I = T>(promise: Promise<T>, initial: I): T | I {
  const [arrived, setArrived] = useState<{ from: Promise<T>; value: T } | null>(null);
  useEffect(() => {
    let current = true;
    promise.then(
      (value) => current && setArrived({ from: promise, value }),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [promise]);
  return arrived?.from === promise ? arrived.value : initial;
}
