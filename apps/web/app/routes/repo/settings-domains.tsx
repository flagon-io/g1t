import { CheckCircle2, Globe, Info, LoaderCircle, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link } from "react-router";

import type { Domain, DomainRecord, DomainStatus } from "@g1t/contracts";

import type { Route } from "./+types/settings-domains";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { Button, CopyLine, EmptyState, ErrorText, Field, Input, SubmitButton, usePending } from "../../components/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { CheckboxOption } from "../../components/ui/checkbox";
import { deployments } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";
import { useRefreshWhile } from "../../lib/refresh";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Domains · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Admins; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_integrations");
  const ref = { workspace: params.owner, slug: params.repo };
  const [settings, domains] = await Promise.all([deployments.settings(ref, viewer), deployments.domains(ref, viewer)]);
  return { settings: unwrap(settings), ...unwrap(domains) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_integrations");
  const form = await request.formData();
  const ref = { workspace: params.owner, slug: params.repo };
  const intent = form.get("intent");
  const id = String(form.get("id") ?? "");
  if (intent === "add") {
    const added = await deployments.addDomain(user, ref, String(form.get("hostname") ?? ""), { twin: form.get("twin") === "on" });
    if (!added.ok) return { error: added.error.message };
    const names = added.value.map((d) => d.hostname);
    return { notice: names.length ? `Added ${names.join(" and ")}. Add the DNS records below.` : "Saved." };
  }
  if (intent === "refresh") {
    const checked = await deployments.refreshDomain(user, ref, id);
    if (!checked.ok) return { error: checked.error.message };
    return { notice: checked.value.status === "active" ? `${checked.value.hostname} is active.` : `Checked ${checked.value.hostname} again.` };
  }
  if (intent === "remove") {
    const removed = await deployments.removeDomain(user, ref, id);
    return removed.ok ? { notice: "Domain removed." } : { error: removed.error.message };
  }
  return { error: "Unknown request." };
}

const STATUS: Record<DomainStatus, { label: string; tone: string; live?: boolean }> = {
  pending: { label: "Waiting for DNS", tone: "text-warn border-warn/30 bg-warn/5", live: true },
  verifying: { label: "Issuing certificate", tone: "text-warn border-warn/30 bg-warn/5", live: true },
  active: { label: "Active", tone: "text-accent border-accent/30 bg-accent/5" },
  failed: { label: "Failed", tone: "text-danger border-danger/30 bg-danger/5" },
  removing: { label: "Removing", tone: "text-faint border-line" },
};

/** A custom domain's monthly price, to the cent: `$0.12`. */
function domainPrice(micros: number | undefined): string {
  return `$${((micros ?? 120_000) / 1_000_000).toFixed(2)}`;
}

function StatusBadge({ status }: { status: DomainStatus }) {
  const { label, tone, live } = STATUS[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>
      <span className={`size-1.5 rounded-full bg-current ${live ? "animate-pulse motion-reduce:animate-none" : ""}`} />
      {label}
    </span>
  );
}

/** The www or apex twin of what is typed, for the pairing option's label. */
function twinOf(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host)) return null;
  if (host.startsWith("www.")) return host.slice(4).includes(".") ? host.slice(4) : null;
  return host.split(".").length === 2 ? `www.${host}` : null;
}

export default function DomainSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { settings, domains, target, available, notice, monthlyMicros, used } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const [hostname, setHostname] = useState("");
  const twin = twinOf(hostname);
  const added = actionData && "notice" in actionData && !!actionData.notice?.startsWith("Added");
  useEffect(() => {
    if (added) setHostname("");
  }, [added, actionData]);

  // While a domain is on its way, the page follows it.
  const waiting = domains.some((d) => d.status === "pending" || d.status === "verifying");
  useRefreshWhile(waiting, 10_000);

  // A redirecting domain is shown under the one it redirects to.
  const primary = domains.filter((d) => !d.redirectTo || !domains.some((p) => p.hostname === d.redirectTo));

  return (
    <div className="max-w-4xl">
      <RepoSettingsHeading base={base} />
      <div className="min-h-6">
        {actionData && "notice" in actionData && <p className="text-sm text-accent">{actionData.notice}</p>}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      </div>

      <header className="mb-6">
        <h2 className="flex items-center gap-2 font-medium">
          <Globe size={16} className="text-accent" />
          Custom domains
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Serve production at a domain of your own, such as <span className="font-mono text-fg">example.com</span> or{" "}
          <span className="font-mono text-fg">www.example.com</span>, beside{" "}
          <span className="font-mono text-fg">{settings.productionUrl.replace("https://", "")}</span>. Point it at{" "}
          <span className="font-mono text-fg">{target}</span>; g1t issues and renews its certificate. Redeploys never change
          it.{" "}
          <a href="https://docs.g1t.sh/guides/deployments/#custom-domains" className="text-fg hover:underline">
            How custom domains work
          </a>
        </p>
      </header>

      {!available && notice && (
        <p className="mb-6 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
          <Info size={15} className="mt-0.5 shrink-0" />
          {notice}
        </p>
      )}

      {!settings.enabled && (
        <p className="mb-6 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          Deployments are off for this project, so a domain added now shows that nothing is deployed until they are on.{" "}
          <Link to={`${base}/settings/deployments`} className="text-fg hover:underline">
            Turn on deployments
          </Link>
        </p>
      )}

      <Form method="post" className="rounded-xl border border-line bg-surface p-5">
        <input type="hidden" name="intent" value="add" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grow">
            <Field label="Domain" hint="A domain (the apex, such as example.com) or any subdomain, such as www.example.com or app.example.com.">
              <Input
                name="hostname"
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="example.com"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </Field>
          </div>
          <div className="sm:mb-6">
            <SubmitButton variant="accent" match={{ intent: "add" }} pending="Adding…" disabled={!hostname.trim()}>
              Add domain
            </SubmitButton>
          </div>
        </div>
        <CheckboxOption
          name="twin"
          defaultChecked
          disabled={!twin}
          className="mt-2"
          label={twin ? `Also add ${twin}, redirecting to ${hostname.trim().toLowerCase()}` : "Also add the www or apex twin, redirecting to it"}
          description="Most sites answer at both example.com and www.example.com; one serves the app and the other sends visitors to it, path and query kept."
        />
        <p className="mt-4 text-xs text-faint">
          Each custom domain is {domainPrice(monthlyMicros)} a month on the g1t plan, its cost plus 20%, from the included usage
          first. As many as you like: {used} in use across the workspace.
        </p>
      </Form>

      <div className="mt-8 space-y-4">
        {domains.length === 0 ? (
          <EmptyState title="No custom domains yet">Add one above, then the DNS records it asks for.</EmptyState>
        ) : (
          primary.map((domain) => (
            <DomainCard
              key={domain.id}
              domain={domain}
              redirects={domains.filter((d) => d.redirectTo === domain.hostname)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DomainCard({ domain, redirects }: { domain: Domain; redirects: Domain[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <DomainRow domain={domain} />
      {redirects.map((other) => (
        <div key={other.id} className="border-t border-line">
          <DomainRow domain={other} />
        </div>
      ))}
    </section>
  );
}

function DomainRow({ domain }: { domain: Domain }) {
  const active = domain.status === "active";
  return (
    <div className="p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {active ? (
          <a href={`https://${domain.hostname}`} className="min-w-0 truncate font-mono text-sm font-medium hover:text-accent">
            {domain.hostname}
          </a>
        ) : (
          <span className="min-w-0 truncate font-mono text-sm font-medium">{domain.hostname}</span>
        )}
        <StatusBadge status={domain.status} />
        {domain.redirectTo && <span className="text-xs text-muted">redirects to {domain.redirectTo}</span>}
        <span className="ml-auto flex items-center gap-2">
          {domain.status !== "removing" && (
            <Form method="post">
              <input type="hidden" name="intent" value="refresh" />
              <input type="hidden" name="id" value={domain.id} />
              <SubmitButton
                variant="quiet"
                match={{ intent: "refresh", id: domain.id }}
                pending="Checking…"
                title="Ask Cloudflare to check the records again now"
              >
                <RotateCw size={14} />
                Check now
              </SubmitButton>
            </Form>
          )}
          <RemoveDomain domain={domain} />
        </span>
      </div>
      {domain.error && !active && <p className="mt-2 text-sm text-muted">{domain.error}</p>}
      {active ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
          <CheckCircle2 size={14} className="text-accent" />
          {domain.redirectTo ? "Redirecting, with its certificate." : "Serving production, with its certificate."}
          {domain.verifiedAt && <span className="text-faint">Since {new Date(domain.verifiedAt).toLocaleDateString()}.</span>}
        </p>
      ) : (
        <Records domain={domain} />
      )}
    </div>
  );
}

function Records({ domain }: { domain: Domain }) {
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted">Add these records where the domain's DNS is managed:</p>
      {domain.records.map((record) => (
        <RecordRow key={`${record.type}-${record.name}-${record.value}`} record={record} />
      ))}
      {domain.apex && (
        <p className="text-xs text-faint">
          The apex (the bare domain) cannot have a plain CNAME. Use your provider's flattened CNAME or ALIAS record: a CNAME
          at <span className="font-mono">@</span> on Cloudflare DNS, an ALIAS on DNSimple, NS1, Namecheap, Porkbun or Gandi,
          or an ANAME on DNS Made Easy. Route 53's alias records cannot point outside AWS. If your provider has none of
          these, add only the www domain here and forward the apex to it at your provider.
        </p>
      )}
      <p className="text-xs text-faint">
        DNS changes can take a few minutes to an hour to be seen. The certificate is issued once the domain points here.
      </p>
    </div>
  );
}

function RecordRow({ record }: { record: DomainRecord }) {
  const type = record.type === "ALIAS" ? "CNAME (flattened) or ALIAS" : record.type;
  return (
    <div className="grid gap-2 rounded-lg border border-line bg-bg p-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <div className="text-xs">
        <p className="font-medium text-fg">{type}</p>
        <p className="mt-0.5 text-faint">{record.purpose}</p>
      </div>
      <div className="grid min-w-0 gap-2">
        <div>
          <p className="mb-1 text-xs text-faint">Name</p>
          <CopyLine text={record.name} />
        </div>
        <div>
          <p className="mb-1 text-xs text-faint">{record.type === "TXT" ? "Content" : "Target"}</p>
          <CopyLine text={record.value} />
        </div>
      </div>
    </div>
  );
}

function RemoveDomain({ domain }: { domain: Domain }) {
  // The dialog closes as it posts, so the row's own button says it is going.
  const removing = usePending({ intent: "remove", id: domain.id });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="quiet" disabled={removing} aria-label={`Remove ${domain.hostname}`}>
          {removing ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} />}
          {removing ? "Removing…" : "Remove"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <Form method="post" className="grid gap-4">
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="id" value={domain.id} />
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {domain.hostname}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops serving this project at once, and its certificate is given up. Any domain redirecting to it is
              removed too. You can add it again later; its DNS records stay as you set them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <button type="submit">
                <Trash2 size={14} />
                Remove domain
              </button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
