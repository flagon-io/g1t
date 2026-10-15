/**
 * The page on its way out while the next one loads, as apps/web's shell
 * has it: a bar across the top, and the page dimming after a moment.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

/**
 * The page while the next one loads: after a moment it dims, under the
 * bar below, so it is plainly on its way out rather than frozen, and the
 * next page fades up from there. Sending a form does not dim it: the
 * form's button says it is working. Spread on the element holding the page.
 */
export function useLeaving() {
  const navigation = useNavigation();
  const method = navigation.formMethod?.toUpperCase();
  const leaving = navigation.state === "loading" && (method == null || method === "GET");
  return {
    "aria-busy": leaving || undefined,
    className: `transition-opacity motion-reduce:transition-none ${leaving ? "opacity-60 delay-200 duration-300" : "duration-150"}`,
  };
}

/**
 * A form React Router sent (<Form>) leaves the page as a fresh one would:
 * once the answer is in, the form goes back to what the page now says
 * and its button lets go of focus, so app.css's "working" spinner on a
 * focused submit button stops. A plain <form> loads a new page anyway.
 */
export function useSettledForms() {
  const navigation = useNavigation();
  const sent = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    const remember = (event: SubmitEvent) => {
      if (event.target instanceof HTMLFormElement) sent.current = event.target;
    };
    document.addEventListener("submit", remember);
    return () => document.removeEventListener("submit", remember);
  }, []);
  useEffect(() => {
    const form = sent.current;
    if (navigation.state !== "idle" || !form) return;
    sent.current = null;
    if (!form.isConnected) return;
    form.reset();
    if (document.activeElement instanceof HTMLElement && form.contains(document.activeElement)) document.activeElement.blur();
  }, [navigation.state]);
}

/**
 * A bar across the top of the page while the next one loads: it appears
 * at once, creeps towards the end while waiting, then fills and fades when
 * the page arrives. At rest it has no width and no style attribute, so the
 * server's page carries no inline style for the policy to refuse; React
 * sets the width through the DOM once it moves.
 */
export function Progress() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (busy) {
      setVisible(true);
      setWidth(12);
      // Slows as it goes, never quite arriving until the page does.
      const timer = setInterval(() => setWidth((now) => now + (90 - now) * 0.12), 200);
      return () => clearInterval(timer);
    }
    setWidth((now) => (now > 0 ? 100 : 0));
    const fade = setTimeout(() => setVisible(false), 250);
    const reset = setTimeout(() => setWidth(0), 550);
    return () => {
      clearTimeout(fade);
      clearTimeout(reset);
    };
  }, [busy]);
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-x-0 top-0 z-60 h-0.75 transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div
        className="h-full w-0 bg-accent shadow-[0_0_10px_var(--color-accent)] transition-[width] duration-200 ease-out"
        style={width > 0 ? { width: `${width}%` } : undefined}
      />
    </div>
  );
}
