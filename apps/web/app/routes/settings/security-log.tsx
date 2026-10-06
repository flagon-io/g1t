import type { Route } from "./+types/security-log";
import { page } from "../../lib/meta";
import { requireUser } from "../../lib/session.server";
import { SecurityLogSection } from "../../components/emails-section";
import { loadSecurityLog } from "../../lib/emails.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Security log · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  return { log: await loadSecurityLog(user) };
}

export default function SecurityLogSettings({ loaderData }: Route.ComponentProps) {
  return <SecurityLogSection log={loaderData.log} />;
}
