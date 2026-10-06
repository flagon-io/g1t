import { identity } from "../lib/services.server";
import { Form, Link } from "react-router";

import type { Route } from "./+types/settings";
import { page } from "../lib/meta";
import { AvatarField } from "../components/avatar-field";
import { Button, ErrorText, Field, Input, TimeAgo } from "../components/ui";
import { readAvatarUpload } from "../lib/avatar-upload";
import { assertSameOrigin, requireUser } from "../lib/session.server";
import { ProfileSection } from "../components/profile-form";
import { InvitesSection } from "../components/invites-section";
import { inviteAction, loadInvites } from "../lib/invites.server";
import { EmailsSection, SecurityLogSection } from "../components/emails-section";
import { EMAIL_INTENTS, emailAction, loadEmails } from "../lib/emails.server";
import { GithubMark } from "../components/github";
import { githubSignIn } from "../lib/github.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const [keys, tokens, applications, profile, github] = await Promise.all([
    identity.listSshKeys(user),
    identity.listAccessTokens(user),
    identity.listOAuthGrants(user),
    identity.profile(user.username),
    githubSignIn.account(user).catch(() => null),
  ]);
  const [invites, emails] = await Promise.all([loadInvites(user), loadEmails(user)]);
  return { user, keys, tokens, applications, profile, github, invites, emails, origin: new URL(request.url).origin };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const id = String(form.get("id") ?? "");

  // Email addresses (lib/emails.server.ts): sensitive changes may first ask
  // for the password.
  if ((EMAIL_INTENTS as readonly string[]).includes(String(form.get("intent")))) {
    return { emailAction: await emailAction(user, form, request) };
  }

  switch (form.get("intent")) {
    // Invites: making and revoking them (lib/invites.server.ts).
    case "create-invite":
    case "revoke-invite": {
      const done = await inviteAction(user, form);
      return { inviteCreated: done?.inviteCreated, inviteError: done?.inviteError };
    }
    // Identity checks every field again, and the website most of all.
    case "profile": {
      const text = (name: string) => String(form.get(name) ?? "");
      const result = await identity.updateProfile(user, {
        name: text("name"),
        bio: text("bio"),
        location: text("location"),
        website: text("website"),
        pronouns: text("pronouns"),
      });
      return result.ok ? { profileSaved: true } : { profileError: result.error.message };
    }
    // The picture: identity checks the image's bytes again.
    case "avatar": {
      const upload = await readAvatarUpload(form);
      if ("error" in upload) return { avatarError: upload.error };
      const result = await identity.setUserAvatar(user, upload.image);
      return result.ok ? null : { avatarError: result.error.message };
    }
    case "remove-avatar": {
      const result = await identity.setUserAvatar(user, null);
      return result.ok ? null : { avatarError: result.error.message };
    }
    case "add-key": {
      const result = await identity.addSshKey(
        user,
        String(form.get("title") ?? ""),
        String(form.get("key") ?? ""),
      );
      return result.ok ? null : { keyError: result.error.message };
    }
    case "delete-key":
      await identity.removeSshKey(user, id);
      return null;
    case "add-token": {
      const created = await identity.createAccessToken(
        user,
        String(form.get("label") ?? ""),
      );
      return { newToken: created.token };
    }
    case "delete-token":
      await identity.removeAccessToken(user, id);
      return null;
    case "unlink-github": {
      const result = await githubSignIn.unlink(user);
      return result.ok ? null : { githubError: result.error.message };
    }
    case "sign-out-application":
      await identity.revokeOAuthGrant(user, id);
      return null;
  }
  return null;
}

function DeleteButton({
  intent,
  id,
  label = "Delete",
}: {
  intent: string;
  id: string;
  label?: string;
}) {
  return (
    <Form method="post" className="ml-auto">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      <Button variant="quiet" type="submit">
        {label}
      </Button>
    </Form>
  );
}

export default function Settings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, keys, tokens, applications, profile, github, invites, emails, origin } = loaderData;
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
      <header className="mb-8 border-b border-line pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1.5 text-sm text-muted">
          How <span className="font-mono text-fg">{user.username}</span> signs in from git, tools and agents.
        </p>
      </header>
      <div className="max-w-2xl space-y-12">
      <section id="picture" className="scroll-mt-20">
        <h2 className="font-medium">Picture</h2>
        <div className="mt-4">
          <AvatarField
            name={user.username}
            image={user.avatar}
            error={actionData && "avatarError" in actionData ? actionData.avatarError : undefined}
            about="Shown beside your username in the sidebar and on mission control. Without one, g1t draws your first letter."
          />
        </div>
      </section>
      <ProfileSection
        username={user.username}
        profile={profile}
        error={actionData && "profileError" in actionData ? actionData.profileError : undefined}
        saved={Boolean(actionData && "profileSaved" in actionData)}
      />
      <EmailsSection
        data={emails.emails}
        actionData={actionData && "emailAction" in actionData ? actionData.emailAction : undefined}
        hasPassword={github?.hasPassword ?? true}
      />
      {github?.enabled && (
        <section id="github" className="scroll-mt-20">
          <h2 className="font-medium">GitHub</h2>
          <p className="mt-1 text-sm text-muted">
            Sign in with your GitHub account, and import or mirror repositories you can reach there.
          </p>
          {github.account ? (
            <div className="mt-4 flex items-center gap-4 rounded-md border border-line px-4 py-3">
              <GithubMark className="size-5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm">
                  Linked to <span className="font-mono">@{github.account.login}</span>
                </p>
                <p className="text-xs text-faint">
                  Since <TimeAgo at={github.account.linkedAt} />
                  {!github.account.authorized && " · access ended: link it again to import repositories"}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {!github.account.authorized && (
                  <a href="/auth/github?link=1" className="text-sm text-muted hover:text-fg">
                    Link again
                  </a>
                )}
                <Form method="post">
                  <input type="hidden" name="intent" value="unlink-github" />
                  <Button variant="quiet" type="submit" disabled={!github.hasPassword} title={github.hasPassword ? undefined : "GitHub is how you sign in. Set a password first."}>
                    Unlink
                  </Button>
                </Form>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <a
                href="/auth/github?link=1"
                className="inline-flex items-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-fg/90 hover:border-line-strong hover:bg-surface hover:text-fg"
              >
                <GithubMark /> Link GitHub
              </a>
            </div>
          )}
          {github.account && !github.hasPassword && (
            <p className="mt-2 text-xs text-faint">
              GitHub is the only way you sign in, so it cannot be unlinked yet. Sign out and use Forgot your password to set one.
            </p>
          )}
          <ErrorText>{actionData && "githubError" in actionData ? actionData.githubError : undefined}</ErrorText>
        </section>
      )}
      <InvitesSection
        overview={invites}
        origin={origin}
        created={actionData && "inviteCreated" in actionData ? actionData.inviteCreated : undefined}
        error={actionData && "inviteError" in actionData ? actionData.inviteError : undefined}
      />
      <section id="ssh-keys" className="scroll-mt-20">
        <h2 className="font-medium">SSH keys</h2>
        <ul className="mt-4 divide-y divide-line rounded-md border border-line empty:hidden">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm">{key.title}</p>
                <p className="truncate font-mono text-xs text-muted">
                  {key.fingerprint}
                </p>
              </div>
              <DeleteButton intent="delete-key" id={key.id} />
            </li>
          ))}
        </ul>
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="add-key" />
          <Field label="Title (optional)">
            <Input name="title" maxLength={100} />
          </Field>
          <Field label="Public key">
            <Input name="key" placeholder="ssh-ed25519 AAAA…" required />
          </Field>
          <ErrorText>{actionData?.keyError}</ErrorText>
          <Button type="submit">Add SSH key</Button>
        </Form>
      </section>

      <section id="tokens" className="scroll-mt-20">
        <h2 className="font-medium">Access tokens</h2>
        <p className="mt-1 text-sm text-muted">
          Use a token as the password when git asks for one over HTTPS, and to
          authenticate agents and the API. A token here acts as you.
        </p>
        {(user.workspaces ?? []).length > 0 && (
          <p className="mt-1 text-sm text-muted">
            For CI and integrations that work for a team, use a workspace's
            own tokens instead:{" "}
            {(user.workspaces ?? []).map((membership, i) => (
              <span key={membership.slug}>
                {i > 0 && ", "}
                <Link
                  to={`/${membership.slug}/-/tokens`}
                  className="font-mono text-fg underline underline-offset-4"
                >
                  {membership.slug}
                </Link>
              </span>
            ))}
            .
          </p>
        )}
        {actionData?.newToken && (
          <div className="mt-4 rounded-md border border-accent/40 bg-surface p-4">
            <p className="text-sm">Copy it now. It will not be shown again.</p>
            <pre className="mt-2 overflow-x-auto font-mono text-sm text-accent">
              {actionData.newToken}
            </pre>
          </div>
        )}
        <ul className="mt-4 divide-y divide-line rounded-md border border-line empty:hidden">
          {tokens.map((token) => (
            <li key={token.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{token.name}</p>
                <p className="text-xs text-faint">
                  Created <TimeAgo at={token.createdAt} /> ·{" "}
                  {token.lastUsedAt ? (
                    <>
                      last used <TimeAgo at={token.lastUsedAt} />
                    </>
                  ) : (
                    "never used"
                  )}
                </p>
              </div>
              <DeleteButton intent="delete-token" id={token.id} />
            </li>
          ))}
        </ul>
        <Form method="post" className="mt-4 flex items-end gap-3">
          <input type="hidden" name="intent" value="add-token" />
          <div className="grow">
            <Field label="Name">
              <Input name="label" maxLength={100} placeholder="laptop" />
            </Field>
          </div>
          <Button type="submit">Create token</Button>
        </Form>
      </section>

      <section id="applications" className="scroll-mt-20">
        <h2 className="font-medium">Connected applications</h2>
        <p className="mt-1 text-sm text-muted">
          Applications you signed in to through your browser, such as an agent
          connected to the g1t MCP server. Signing one out ends its access at
          once.
        </p>
        {applications.length === 0 ? (
          <p className="mt-4 text-sm text-faint">None yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-md border border-line">
            {applications.map((application) => (
              <li key={application.id} className="flex items-center gap-4 px-4 py-3">
                <div>
                  <p className="text-sm">{application.clientName}</p>
                  <p className="text-xs text-faint">
                    Connected <TimeAgo at={application.createdAt} /> · last used{" "}
                    <TimeAgo at={application.lastUsedAt} />
                  </p>
                </div>
                <DeleteButton
                  intent="sign-out-application"
                  id={application.id}
                  label="Sign out"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <SecurityLogSection log={emails.log} />
      </div>
    </main>
  );
}
