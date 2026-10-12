/**
 * What Customize's pages do on the server besides reading: the connector
 * actions every page with a connector shares (signing in and out, a key,
 * listing tools again, where it reaches, removing it), and what follows
 * adding one: the browser goes to sign in, or to the connector's page.
 */
import { type ShouldRevalidateFunctionArgs, redirect } from "react-router";

import type { ConnectorInput, User, WorkspaceConnector } from "@g1t/contracts";

import { addresses } from "./addresses.server";
import { connectorCallbackPath, connectorPagePath, needsReload, splitTarget } from "./customize";
import { workspaceAgents } from "./services.server";
import type { ActionResult } from "../components/agents/dialogs";
import { answer } from "../components/agents/actions.server";

/** Where a connector's sign-in comes back to: this g1t's own page. */
export function callbackUri(slug: string): string {
  return `${addresses().site}${connectorCallbackPath(slug)}`;
}

/** A Customize page reads its data again only for another page, the other view, or a posted form (lib/customize.ts). */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs): boolean {
  return needsReload(currentUrl, nextUrl, formMethod) ? defaultShouldRevalidate : false;
}

/** The browser leaves for the connector's sign-in page, or lands on the connector's own page with what happened. */
async function toSignIn(slug: string, viewer: User, id: string): Promise<Response> {
  const started = await workspaceAgents.startConnectorSignIn(slug, viewer, id, callbackUri(slug)).catch(() => null);
  if (started?.ok) return redirect(started.value.url);
  const problem = started ? started.error.message : "The agents service didn't answer. Try again in a moment.";
  return redirect(`${connectorPagePath(slug, id)}?problem=${encodeURIComponent(problem)}`);
}

/**
 * Adds a connector and takes the browser where it goes next: to sign in
 * when the server asks for that, or to the connector's page otherwise. An
 * answer (not a redirect) says why it couldn't be added.
 */
export async function addConnectorThen(slug: string, viewer: User, input: ConnectorInput): Promise<Response | ActionResult> {
  const added = await workspaceAgents.addConnector(slug, viewer, input).catch(() => null);
  if (!added) return { ok: false, intent: "connect", error: "The agents service didn't answer. Try again in a moment." };
  if (!added.ok) return { ok: false, intent: "connect", error: added.error.message, code: added.error.code };
  return afterAdd(slug, viewer, added.value);
}

/** After a connector is added: the sign-in when it needs one, its page otherwise. */
export function afterAdd(slug: string, viewer: User, connector: WorkspaceConnector): Promise<Response> | Response {
  if (connector.state === "needs_sign_in") return toSignIn(slug, viewer, connector.id);
  return redirect(`${connectorPagePath(slug, connector.id)}?added=1`);
}

/**
 * The actions a connector has wherever it is shown. `intent` names one;
 * null says it isn't one of them, so the page's own action goes on.
 * `afterRemove` is where the browser goes once it is removed.
 */
export async function connectorAction(intent: string, form: FormData, slug: string, viewer: User, afterRemove: string | null): Promise<Response | ActionResult | null> {
  const id = String(form.get("connector") ?? "");
  switch (intent) {
    case "sign_in":
      return toSignIn(slug, viewer, id);
    case "sign_out":
      return answer(intent, workspaceAgents.signOutConnector(slug, viewer, id));
    case "key":
      return answer(intent, workspaceAgents.setConnectorKey(slug, viewer, id, String(form.get("header_name") ?? "") || null, String(form.get("value") ?? "")));
    case "refresh":
      return answer(intent, workspaceAgents.refreshConnector(slug, viewer, id));
    case "grant": {
      const { scope, target } = splitTarget(String(form.get("where") ?? ""));
      return answer(intent, workspaceAgents.grantConnector(slug, viewer, id, scope, target));
    }
    case "revoke":
      return answer(intent, workspaceAgents.revokeConnector(slug, viewer, id, String(form.get("grant") ?? "")));
    case "remove": {
      const result = await answer(intent, workspaceAgents.removeConnector(slug, viewer, id));
      return result.ok && afterRemove ? redirect(afterRemove) : result;
    }
    default:
      return null;
  }
}
