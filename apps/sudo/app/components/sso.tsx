import { Link } from "react-router";

import type { SsoSettings } from "@g1t/contracts";

import { Badge, EmptyState, Notice, Section, When } from "~/components/ui";

const PROTOCOLS = { oidc: "OpenID Connect", oauth2: "OAuth 2.0", saml: "SAML 2.0" } as const;

/** Which provider a connection is, by its own address. */
function provider(sso: NonNullable<SsoSettings["connection"]>): string {
  const config = sso.config;
  return config.issuer ?? config.idp_entity_id ?? config.authorization_url ?? "—";
}

/**
 * A workspace's single sign-on, as its owners see it: the provider, whether
 * it is required, and who is linked. Read only: owners change it on the
 * site, and are never held out, so staff never need to.
 */
export function SsoSection({ sso, unavailable }: { sso: SsoSettings | null; unavailable: string | null }) {
  const connection = sso?.connection ?? null;
  return (
    <Section
      id="sso"
      title="Single sign-on"
      description="The workspace's own identity provider. Owners set it up and require it at /-/settings/sso; they are never held out."
      className="mt-6"
    >
      {unavailable ? (
        <Notice tone="error">Single sign-on could not be read: {unavailable}</Notice>
      ) : !connection ? (
        <EmptyState title="Not set up" />
      ) : (
        <div className="space-y-5">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-faint">Protocol</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-1.5">
                {PROTOCOLS[connection.protocol]}
                {sso?.required ? <Badge tone="lavender">Required of members</Badge> : <Badge>Not required</Badge>}
                {connection.allow_join && <Badge tone="info">Provider's people join</Badge>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Provider</dt>
              <dd className="mt-0.5 font-mono text-xs break-all">{provider(connection)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Tested</dt>
              <dd className="mt-0.5">
                {connection.tested_at ? (
                  <>
                    By{" "}
                    {connection.tested_by ? (
                      <Link to={`/users/${connection.tested_by}`} className="font-mono hover:underline">
                        {connection.tested_by}
                      </Link>
                    ) : (
                      "someone"
                    )}{" "}
                    <When at={connection.tested_at} />
                  </>
                ) : (
                  <Badge tone="warn">Not yet</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Set up</dt>
              <dd className="mt-0.5">
                <When at={connection.created_at} />, changed <When at={connection.updated_at} />
              </dd>
            </div>
            {connection.protocol !== "saml" && (
              <div>
                <dt className="text-xs text-faint">Client id</dt>
                <dd className="mt-0.5 font-mono text-xs break-all">
                  {connection.config.client_id ?? "—"} {connection.has_client_secret ? "(secret kept)" : "(no secret)"}
                </dd>
              </div>
            )}
            {connection.certificates.length > 0 && (
              <div>
                <dt className="text-xs text-faint">Signing certificates, SHA-256</dt>
                <dd className="mt-0.5 space-y-0.5 font-mono text-xs break-all">
                  {connection.certificates.map((certificate) => (
                    <p key={certificate.fingerprint}>{certificate.fingerprint}</p>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          <p className="text-sm">
            <span className="text-xs text-faint">SCIM </span>
            {sso?.scim ? (
              <>
                <Badge tone="info">On</Badge>{" "}
                <span className="text-muted">
                  {sso.scim.users.filter((user) => user.active).length} active of {sso.scim.users.length} assigned, token ending{" "}
                  <span className="font-mono">{sso.scim.hint}</span>, last used <When at={sso.scim.last_used_at} />
                </span>
              </>
            ) : (
              <Badge>Off</Badge>
            )}
          </p>
          {sso!.identities.length === 0 ? (
            <p className="text-sm text-muted">No one has signed in through it yet.</p>
          ) : (
            <div className="-mx-4 -mb-4 overflow-x-auto border-t border-line sm:-mx-5 sm:-mb-5">
              <table className="w-full min-w-120 text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium sm:pl-5">Person</th>
                    <th className="px-4 py-2 font-medium">At the provider</th>
                    <th className="px-4 py-2 font-medium">Linked</th>
                    <th className="px-4 py-2 font-medium sm:pr-5">Last signed in</th>
                  </tr>
                </thead>
                <tbody>
                  {sso!.identities.map((identity) => (
                    <tr key={identity.username} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 font-mono sm:pl-5">
                        <Link to={`/users/${identity.username}`} className="hover:underline">
                          {identity.username}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 break-all text-muted">{identity.email ?? identity.subject}</td>
                      <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted">
                        <When at={identity.linked_at} />
                      </td>
                      <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted sm:pr-5">
                        <When at={identity.last_used_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
