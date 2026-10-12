/**
 * Install requests: for an owner, everything members asked the workspace
 * to add (a plugin, a skill, a connector, an integration), with the way to
 * add it, mark it added or turn it down; for anyone else, their own and how
 * each was answered. The Request buttons across Customize post here, and
 * so do the answers.
 */
import { ArrowLeft } from "lucide-react";
import { Link, data } from "react-router";

import { connectorsFor } from "@g1t/contracts/connectors";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/requests";
import { useCustomize } from "./layout";
import { NoAnswer, RequestRow, SectionHead } from "../../../components/customize";
import { EmptyState } from "../../../components/ui";
import { Card } from "../../../components/ui/card";
import { addPath, customizeForm, openRequests } from "../../../lib/customize";
import { page } from "../../../lib/meta";
import { workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Requests · Customize · ${params.owner} · g1t` });
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const asked = customizeForm(await request.formData());
  if (!asked) return data({ error: "Nothing to do." }, { status: 400 });
  const call = asked.intent === "request" ? workspaceAgents.requestInstall(slug, viewer, asked.listing, asked.note) : workspaceAgents.resolveInstallRequest(slug, viewer, asked.id, asked.status);
  const result = await call.catch(() => null);
  if (!result) return data({ error: "The request didn't go through. Try again in a moment." }, { status: 503 });
  if (!result.ok) return data({ error: result.error.message }, { status: result.error.code === "conflict" ? 409 : 422 });
  return { error: null };
}

export default function CustomizeRequests() {
  const { slug, owner, requests } = useCustomize();
  const back = (
    <Link to={customizePath("skills", slug)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      Customize
    </Link>
  );
  if (!requests) {
    return (
      <div className="space-y-6">
        {back}
        <NoAnswer what="Requests" />
      </div>
    );
  }
  const views = connectorsFor("workspace");
  const waiting = openRequests(requests.requests);
  const answered = requests.requests.filter((request) => request.status !== "open");
  return (
    <div className="space-y-8">
      {back}
      {requests.requests.length === 0 ? (
        owner ? (
          <EmptyState title="No requests">When a member asks for a plugin, a skill or a connector, it shows here, and you're notified.</EmptyState>
        ) : (
          <EmptyState title="You haven't asked for anything">
            Find a plugin, a skill or a connector in Discover and choose <b>Request</b>. The workspace's owners are notified, and you hear back when one answers.
          </EmptyState>
        )
      ) : (
        <>
          <section aria-labelledby="waiting">
            <SectionHead id="waiting" title={owner ? "Waiting on an owner" : "Waiting"} aside={`${waiting.length}`}>
              {owner ? "Installing a plugin or connecting a connector answers every request for it. Anything added another way, mark added." : "Your requests the workspace's owners haven't answered yet."}
            </SectionHead>
            {waiting.length === 0 ? (
              <Card asChild tone="plain" className="border-dashed px-4 py-6 text-center text-sm text-muted">
                <p>Nothing is waiting.</p>
              </Card>
            ) : (
              <Card asChild divided className="overflow-hidden">
                <ul>
                  {waiting.map((request) => (
                    <RequestRow key={request.id} request={request} slug={slug} owner={owner} addTo={owner ? addPath(request, slug, views) : null} />
                  ))}
                </ul>
              </Card>
            )}
          </section>
          {answered.length > 0 && (
            <section aria-labelledby="answered">
              <SectionHead id="answered" title="Answered" aside="Last 30 days" />
              <Card asChild divided className="overflow-hidden">
                <ul>
                  {answered.map((request) => (
                    <RequestRow key={request.id} request={request} slug={slug} owner={owner} addTo={null} />
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </>
      )}
    </div>
  );
}
