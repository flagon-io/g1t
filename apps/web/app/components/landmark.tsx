import { type ComponentProps, createContext, useContext } from "react";

/** True inside the app shell, whose `<main id="content">` already holds the page. */
export const InMain = createContext(false);

/**
 * A page's main landmark: `<main>` where nothing above is one (signed out),
 * a plain `<div>` inside the shell, so a page never has two.
 */
export function PageMain(props: ComponentProps<"main">) {
  return useContext(InMain) ? <div {...props} /> : <main {...props} />;
}
