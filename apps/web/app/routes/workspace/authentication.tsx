import { useState } from "react";
import { Form, Link, data, useNavigation } from "react-router";

import type { Route } from "./+types/authentication";
import { page } from "../../lib/meta";
import { ErrorText } from "../../components/ui";
import { Button } from "../../components/ui/button";
import { SwitchCard } from "../../components/ui/switch";
import { accounts, identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";
import { settingsPath } from "../../lib/workspace-nav";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Authentication security · ${params.owner} · g1t` });
}

/**
 * How people sign in to the workspace, as GitHub's Authentication security
 * is: requiring two-factor authentication of everyone with access, and
 * single sign-on (its own page, under this one). Owners only; to anyone
 * else the page does not exist.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!viewer || roleIn(viewer, params.owner) !== "owner") throw data(null, { status: 404 });
  const workspace = await identity.getWorkspace(params.owner);
  if (!workspace) throw data(null, { status: 404 });
  // Who would be held out by requiring it, and whether the owner has it on
  // themselves; either unread, the section says so in its place.
  const [members, twoFactor] = await Promise.all([
    part(identity.listMembers(params.owner, viewer), "Two-factor authentication"),
    part(accounts.twoFactorStatus(viewer), "Two-factor authentication"),
  ]);
  return {
    slug: workspace.slug,
    required: workspace.twoFactorRequirementEnabled ?? false,
    without: isFailed(members) ? members : members.ok ? members.value.filter((member) => member.two_factor === false).map((member) => member.username) : [],
    ownTwoFactor: isFailed(twoFactor) ? twoFactor : twoFactor.ok ? twoFactor.value.enabled : false,
  };
}

/** Requiring two-factor authentication: identity checks the owner has it. */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const result = await identity.setTwoFactorRequirement(user, params.owner, form.get("required") === "on");
  if (!result.ok) return { error: result.error.message };
  return { saved: true };
}

export default function Authentication({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, required, without, ownTwoFactor } = loaderData;
  return (
    <div className="max-w-lg space-y-10">
      {isFailed(without) || isFailed(ownTwoFactor) ? (
        <section>
          <h2 className="font-medium">Two-factor authentication</h2>
          <div className="mt-5">
            <Unavailable what="Two-factor authentication" />
          </div>
        </section>
      ) : (
        <TwoFactorRequirementSection
          key={String(required)}
          slug={slug}
          required={required}
          without={without}
          ownTwoFactor={ownTwoFactor}
          saved={Boolean(actionData && "saved" in actionData)}
          error={actionData && "error" in actionData ? actionData.error : undefined}
        />
      )}
      <section>
        <h2 className="font-medium">Single sign-on</h2>
        <p className="mt-1.5 text-xs text-faint">
          Members sign in through your identity provider, with SAML or OpenID Connect, and SCIM keeps who is in {slug} in step with it. Set it up under{" "}
          <Link to={settingsPath(slug, "sso")} className="text-muted underline underline-offset-4 hover:text-fg">
            Single sign-on
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

/** Requiring two-factor authentication of everyone with access. */
function TwoFactorRequirementSection({
  slug,
  required,
  without,
  ownTwoFactor,
  saved,
  error,
}: {
  slug: string;
  required: boolean;
  without: string[];
  ownTwoFactor: boolean;
  saved: boolean;
  error?: string;
}) {
  const [chosen, setChosen] = useState(required);
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formMethod != null;
  return (
    <section id="two-factor" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
      <h2 className="font-medium">Two-factor authentication</h2>
      <p className="mt-1.5 text-xs text-faint">
        With two-factor authentication required, members and outside collaborators without it keep their place but cannot use {slug} until they turn it on. They
        see a notice saying so.
      </p>
      <Form method="post" className="mt-5 space-y-3">
        <SwitchCard
          name="required"
          title="Require two-factor authentication"
          checked={chosen}
          disabled={!ownTwoFactor && !required}
          onCheckedChange={setChosen}
        >
          {!ownTwoFactor && !required ? (
            <>
              Turn it on for your own account first, in{" "}
              <Link to="/settings/two-factor" className="text-accent underline underline-offset-4">
                your settings
              </Link>
              .
            </>
          ) : without.length === 0 ? (
            "Every member has it on."
          ) : (
            `${without.length} ${without.length === 1 ? "member does" : "members do"} not have it on: ${without.slice(0, 5).join(", ")}${without.length > 5 ? ` and ${without.length - 5} more` : ""}.`
          )}
        </SwitchCard>
        <ErrorText>{error}</ErrorText>
        {saved && !error && chosen === required && (
          <p role="status" className="text-xs text-muted">
            Saved.
          </p>
        )}
        <Button type="submit" disabled={saving || chosen === required}>
          Save
        </Button>
      </Form>
    </section>
  );
}
