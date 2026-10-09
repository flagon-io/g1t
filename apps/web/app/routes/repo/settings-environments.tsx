import { ArrowLeft, ChevronRight, Layers, Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Form, Link, redirect } from "react-router";

import { MAX_ENVIRONMENT_REVIEWERS, MAX_WAIT_MINUTES } from "@g1t/contracts";
import type { BranchPattern, Environment, EnvironmentReviewer } from "@g1t/contracts";

import type { Route } from "./+types/settings-environments";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { SettingsSection as Section } from "../../components/settings-section";
import { Button, EmptyState, ErrorText, Input, SubmitButton, TimeAgo } from "../../components/ui";
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
import { Badge } from "../../components/ui/badge";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Hint } from "../../components/ui/hint";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { environmentFromForm, environmentName, environmentSummary } from "../../lib/environments";
import { page } from "../../lib/meta";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Environments · ${params.owner}/${params.repo} · g1t` });
}

/** An environment with no rules saved: what the form starts from. */
function blank(name: string): Environment {
  return {
    name,
    reviewers: [],
    preventSelfReview: false,
    waitMinutes: 0,
    branchPolicy: "all",
    branchPatterns: [],
    adminsBypass: true,
    protected: false,
    updatedAt: null,
    updatedBy: null,
  };
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Admins; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_integrations");
  const environments = unwrap(await actions.environments({ namespace: params.owner, name: params.repo }, getViewer(context)));
  // `?environment=` opens one environment's rules, a new one's included.
  const asked = new URL(request.url).searchParams.get("environment");
  const name = asked === null ? null : environmentName(asked);
  return {
    environments,
    editing: name ? (environments.find((environment) => environment.name === name) ?? blank(name)) : null,
    badName: asked !== null && name === null ? asked : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_integrations");
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const name = environmentName(String(form.get("environment") ?? ""));
  if (!name) return { saved: false, error: "An environment's name is lowercase letters, digits, - and _, up to 40." };
  if (form.get("intent") === "delete") {
    const removed = await actions.deleteEnvironment(user, repo, name);
    if (!removed.ok) return { saved: false, error: removed.error.message };
    throw redirect(`/${params.owner}/${params.repo}/settings/environments`);
  }
  const read = environmentFromForm(form, { reviewers: MAX_ENVIRONMENT_REVIEWERS, waitMinutes: MAX_WAIT_MINUTES });
  if ("error" in read) return { saved: false, error: read.error };
  const saved = await actions.setEnvironment(user, repo, name, read.change);
  return saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error.message };
}

export default function RepoEnvironments({ loaderData, actionData, params }: Route.ComponentProps) {
  const base = `/${params.owner}/${params.repo}`;
  const { environments, editing, badName } = loaderData;
  return (
    <div>
      <RepoSettingsHeading base={base} />
      {editing ? (
        <EnvironmentEditor key={editing.name} environment={editing} base={base} saved={actionData?.saved ?? false} error={actionData?.error} />
      ) : (
        <EnvironmentList environments={environments} base={base} badName={badName} />
      )}
    </div>
  );
}

function EnvironmentList({ environments, base, badName }: { environments: Environment[]; base: string; badName: string | null }) {
  return (
    <div className="max-w-4xl space-y-8">
      <p className="max-w-3xl text-sm text-muted">
        A job that names an environment with <code className="font-mono text-xs text-fg/85">environment:</code> waits
        until the environment's protection rules let it through, and only then gets the environment's secrets. Rules can
        ask for a review, hold jobs for a wait timer, and limit which branches and tags deploy.
      </p>

      <section className="space-y-3">
        {environments.length === 0 ? (
          <EmptyState title="No environments yet">
            An environment appears here once a workflow, a job or a secret names it. You can also add rules to one by name
            below.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {environments.map((environment) => (
              <li key={environment.name}>
                <Link
                  to={`?environment=${encodeURIComponent(environment.name)}`}
                  className="group flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-raised/40"
                >
                  <Layers size={16} className="mt-0.5 shrink-0 text-muted" />
                  <span className="min-w-0 grow">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate font-mono text-sm font-medium">{environment.name}</span>
                      {environment.protected ? <Badge tone="accent">Protected</Badge> : <Badge>No rules</Badge>}
                    </span>
                    <span className="mt-1 block text-sm text-muted">
                      {environment.protected
                        ? environmentSummary(environment).join(" · ")
                        : "Named by a workflow or a secret. Jobs that deploy here start at once."}
                    </span>
                  </span>
                  <span className="mt-0.5 hidden shrink-0 text-xs text-muted group-hover:text-fg sm:inline">
                    {environment.protected ? "Edit rules" : "Add rules"}
                  </span>
                  <ChevronRight size={16} className="mt-0.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Section title="Add rules to an environment" about="Name an environment to protect, whether or not a workflow names it yet.">
        {/* A plain GET: the rules open in the form below, and nothing is saved until you save them. */}
        <Form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 grow">
            <Input
              name="environment"
              required
              maxLength={40}
              pattern="[A-Za-z0-9_\-]{1,40}"
              placeholder="production"
              aria-label="Environment name"
              defaultValue={badName ?? undefined}
            />
            <span className="mt-1.5 block text-xs text-faint">Lowercase letters, digits, - and _, up to 40.</span>
          </div>
          <Button type="submit" variant="quiet">
            <Plus size={14} />
            Add rules
          </Button>
        </Form>
        {badName !== null && (
          <ErrorText>{`“${badName}” cannot be an environment's name: use lowercase letters, digits, - and _, up to 40.`}</ErrorText>
        )}
      </Section>
    </div>
  );
}

/** Rows of a list that grows and shrinks, each with an id of its own for React. */
type Row<T> = T & { id: number };
let nextRow = 0;
const rows = <T,>(items: T[]): Row<T>[] => items.map((item) => ({ ...item, id: nextRow++ }));

function EnvironmentEditor({
  environment,
  base,
  saved,
  error,
}: {
  environment: Environment;
  base: string;
  saved: boolean;
  error: string | null | undefined;
}) {
  const [reviewers, setReviewers] = useState<Row<EnvironmentReviewer>[]>(() => rows(environment.reviewers));
  const [patterns, setPatterns] = useState<Row<BranchPattern>[]>(() =>
    rows(environment.branchPatterns.length > 0 ? environment.branchPatterns : [{ name: "", type: "branch" }]),
  );
  const [policy, setPolicy] = useState(environment.branchPolicy);
  const full = reviewers.length >= MAX_ENVIRONMENT_REVIEWERS;

  return (
    <div className="max-w-4xl space-y-8">
      <div className="space-y-2">
        <Link to={`${base}/settings/environments`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft size={14} />
          All environments
        </Link>
        <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <Layers size={16} className="text-muted" />
          <span className="min-w-0 break-all font-mono">{environment.name}</span>
          {environment.protected ? <Badge tone="accent">Protected</Badge> : <Badge>No rules</Badge>}
        </h2>
        <p className="max-w-3xl text-sm text-muted">
          Jobs with <code className="font-mono text-xs text-fg/85">environment: {environment.name}</code> wait until these
          rules let them through, and only then get its secrets.
          {!environment.protected && " Nothing holds them until you save rules."}
        </p>
      </div>

      <Form method="post" className="space-y-8">
        <input type="hidden" name="environment" value={environment.name} />
        <Section
          title="Required reviewers"
          about={`Up to ${MAX_ENVIRONMENT_REVIEWERS} people or teams. A job waits until one of them approves it.`}
        >
          {reviewers.length > 0 ? (
            <ul className="space-y-2">
              {reviewers.map((reviewer, index) => (
                <li key={reviewer.id} className="flex items-center gap-2">
                  <Select
                    name="reviewerType"
                    value={reviewer.type}
                    onValueChange={(type) =>
                      setReviewers((list) => list.map((row) => (row.id === reviewer.id ? { ...row, type: type as EnvironmentReviewer["type"] } : row)))
                    }
                  >
                    <SelectTrigger aria-label={`Reviewer ${index + 1} is a`} className="w-24 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="team">Team</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="min-w-0 grow">
                    <Input
                      name="reviewerName"
                      defaultValue={reviewer.name}
                      placeholder={reviewer.type === "team" ? "Team slug" : "Username"}
                      aria-label={`Reviewer ${index + 1}`}
                      maxLength={100}
                    />
                  </div>
                  <RemoveRow
                    label={`Remove reviewer ${index + 1}`}
                    onClick={() => setReviewers((list) => list.filter((row) => row.id !== reviewer.id))}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">
              No reviewers: jobs need no approval to deploy here.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="quiet"
              disabled={full}
              onClick={() => setReviewers((list) => [...list, ...rows<EnvironmentReviewer>([{ type: "user", name: "" }])])}
            >
              <Users size={14} />
              Add a reviewer
            </Button>
            {full && <span className="text-xs text-faint">That is the most an environment can have.</span>}
          </div>
          <CheckboxOption
            name="preventSelfReview"
            defaultChecked={environment.preventSelfReview}
            label="Prevent self-review"
            description="Whoever started a run cannot approve its deployments."
          />
        </Section>

        <Section title="Wait timer" about="Minutes a job waits once it reaches the environment. 0 means no wait.">
          <label className="block max-w-56">
            <span className="mb-1.5 block text-sm font-medium text-muted">Minutes</span>
            <Input
              type="number"
              name="waitMinutes"
              min={0}
              max={MAX_WAIT_MINUTES}
              step={1}
              defaultValue={environment.waitMinutes}
              inputMode="numeric"
            />
            <span className="mt-1.5 block text-xs text-faint">From 0 to {MAX_WAIT_MINUTES.toLocaleString("en-US")} (30 days).</span>
          </label>
        </Section>

        <Section title="Deployment branches and tags" about="Which branches and tags may run jobs that deploy here. A job on any other fails, saying so.">
          <RadioGroup name="branchPolicy" value={policy} onValueChange={(value) => setPolicy(value as Environment["branchPolicy"])}>
            <RadioOption value="all" label="All branches" description="Any branch or tag can deploy here." />
            <RadioOption value="protected" label="Protected branches only" description="Only branches the repository's rules protect, the default branch included." />
            <RadioOption
              value="selected"
              label="Selected branches and tags"
              description="Only branches and tags whose names match a pattern, such as release/* or v*."
            />
          </RadioGroup>
          {policy === "selected" && (
            <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
              <ul className="space-y-2">
                {patterns.map((pattern, index) => (
                  <li key={pattern.id} className="flex items-center gap-2">
                    <Select
                      name="patternType"
                      value={pattern.type}
                      onValueChange={(type) =>
                        setPatterns((list) => list.map((row) => (row.id === pattern.id ? { ...row, type: type as BranchPattern["type"] } : row)))
                      }
                    >
                      <SelectTrigger aria-label={`Pattern ${index + 1} matches`} className="w-24 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="branch">Branch</SelectItem>
                        <SelectItem value="tag">Tag</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="min-w-0 grow">
                      <Input
                        name="patternName"
                        defaultValue={pattern.name}
                        placeholder={pattern.type === "tag" ? "v*" : "release/*"}
                        aria-label={`Pattern ${index + 1}`}
                        maxLength={255}
                      />
                    </div>
                    <RemoveRow
                      label={`Remove pattern ${index + 1}`}
                      onClick={() => setPatterns((list) => list.filter((row) => row.id !== pattern.id))}
                    />
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="quiet"
                onClick={() => setPatterns((list) => [...list, ...rows<BranchPattern>([{ name: "", type: "branch" }])])}
              >
                <Plus size={14} />
                Add a pattern
              </Button>
            </div>
          )}
        </Section>

        <Section title="Admins" about="Whether people with the Admin role may let jobs through themselves.">
          <CheckboxOption
            name="adminsBypass"
            defaultChecked={environment.adminsBypass}
            label="Allow admins to bypass these rules"
            description="Someone with the Admin role may approve without being a reviewer, which also skips the wait timer."
          />
        </Section>

        <div className="sticky bottom-(--tabbar-h) in-data-[keyboard=open]:bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
          <SubmitButton name="intent" value="save" pending="Saving…">
            {environment.protected ? "Save rules" : "Add rules"}
          </SubmitButton>
          {saved && <span className="text-sm text-muted">Saved.</span>}
          <ErrorText>{error}</ErrorText>
          {environment.updatedBy && environment.updatedAt && !saved && !error && (
            <span className="text-xs text-faint">
              Last changed by <span className="font-mono">{environment.updatedBy}</span> <TimeAgo at={environment.updatedAt} />
            </span>
          )}
        </div>
      </Form>

      {environment.protected && <RemoveRules name={environment.name} />}
    </div>
  );
}

function RemoveRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-danger"
      >
        <Trash2 size={14} />
      </button>
    </Hint>
  );
}

function RemoveRules({ name }: { name: string }) {
  return (
    <Section title="Remove rules" about="Jobs that deploy here start at once again. The environment's secrets stay.">
      <div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="danger">
              <Trash2 size={14} />
              Remove rules
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <Form method="post" className="grid gap-4">
              <input type="hidden" name="intent" value="delete" />
              <input type="hidden" name="environment" value={name} />
              <AlertDialogHeader>
                <AlertDialogTitle>Remove the rules for {name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its reviewers, wait timer and branch limits are given up, and jobs that name it no longer wait. Its
                  secrets stay.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction asChild>
                  <button type="submit">
                    <Trash2 size={14} />
                    Remove rules
                  </button>
                </AlertDialogAction>
              </AlertDialogFooter>
            </Form>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Section>
  );
}
