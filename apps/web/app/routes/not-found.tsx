import { data } from "react-router";

/**
 * Any address no other route matches. Throwing the 404 from a route, rather
 * than leaving the router to, means the root loader still runs, so someone
 * signed in sees the page in their own sidebar and not the public frame.
 */
export function loader() {
  throw data(null, { status: 404 });
}

export default function NotFound() {
  return null;
}
