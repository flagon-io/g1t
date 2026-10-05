import { type RouterContextProvider, createContext } from "react-router";

/** The staff member making the request, as the worker verified them. */
export type Staff = { email: string };

/** Set by the worker (workers/app.ts) once the Access token checks out. */
export const staffContext = createContext<Staff | null>(null);

/**
 * The verified staff member, or a 403. The worker refuses anyone else
 * before React Router runs; this is the second lock on the same door.
 */
export function requireStaff(context: Readonly<RouterContextProvider>): Staff {
  const staff = context.get(staffContext);
  if (!staff?.email) throw new Response("Forbidden", { status: 403 });
  return staff;
}
