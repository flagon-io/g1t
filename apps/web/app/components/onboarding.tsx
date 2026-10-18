/**
 * Getting started: the setup guide that opens on a workspace's Home for
 * its owners until they finish or dismiss it, and opens again from
 * Settings → General, the AI page and the command palette.
 *
 * A dialog with a rail of steps beside the step at hand (on a phone, the
 * sheet with the step's place in the guide above it). Each step's tick is
 * the workspace's own state (lib/onboarding.ts); adding an AI provider and
 * choosing Ask's model post to the AI page's own action, so they are the
 * same checks the AI page makes, and the page's loaders read the new state
 * after. Closing the dialog, or finishing it, dismisses it for the person
 * (`-/onboarding`, identity's `set_onboarding`), so it stops opening by
 * itself; nothing else is lost.
 */
import { ArrowLeft, ArrowRight, Bot, Check, CircleDashed, Code2, ExternalLink, GitBranch, KeyRound, Laptop, Plus, Rocket, Sparkles, Users } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import { type AiConnection, type AiProvider, type OnboardingStep, AI_PROVIDERS } from "@g1t/contracts";

import { AI_PROVIDER_GROUPS, AI_PROVIDER_LOOKS, aiProvidersIn } from "../lib/ai-providers";
import { autoOffered, defaultModel, modelOptions } from "../lib/ask-model";
import { cn } from "../lib/cn";
import { type OnboardingStepView, type OnboardingView, STEP_ORDER, finished, firstOpenStep, opensByItself, progressOf } from "../lib/onboarding";
import { AgentSetup } from "./agent-setup";
import { AiProviderMark } from "./connectors";
import { ModelProviderFields } from "./model-providers";
import { ButtonLink, CopyLine, ErrorText, Field, Input, SubmitButton } from "./ui";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Combobox } from "./ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Hint } from "./ui/hint";
import { Progress } from "./ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

/** Each step's icon and what it is for, under its title. */
const ABOUT: Record<OnboardingStep, { icon: ReactNode; lead: string }> = {
  ai: {
    icon: <Sparkles size={16} />,
    lead: "g1t works with models on your own keys: Ask and @g1t in Chat answer with one, and an Anthropic key starts sessions on work items. Add a frontier lab, a platform, or a model you host yourself. g1t bills nothing for it; what it costs is on your provider's bill.",
  },
  ask: {
    icon: <Bot size={16} />,
    lead: "Choose which provider and model answer Ask in the top bar and @g1t in Chat. Auto picks a fast model for lookups and a stronger one when a question needs it.",
  },
  code: {
    icon: <Code2 size={16} />,
    lead: "Start a project with a new repository, or bring repositories you already have across from GitHub. Work items, pull requests, checks and deployments live beside the code.",
  },
  harness: {
    icon: <Laptop size={16} />,
    lead: "Connect your AI client to work with g1t projects through MCP. Choose a coding agent or chat app and sign in through your browser. For local coding, install the g1t CLI too.",
  },
  people: {
    icon: <Users size={16} />,
    lead: "Bring your team in: they get the workspace's projects, chat and artifacts, with the roles you give them.",
  },
  runner: {
    icon: <Rocket size={16} />,
    lead: "Run workflows and sessions on your own machine: the desktop app registers it as a runner, and g1t's cloud takes over whenever it's off.",
  },
};

/** The step's tick in the rail: done, skipped, or its number. */
function StepMark({ step, index }: { step: OnboardingStepView; index: number }) {
  if (step.done) {
    return (
      <Badge tone="success" shape="mark" aria-label="Done">
        <Check size={13} strokeWidth={2.5} />
      </Badge>
    );
  }
  if (step.skipped) {
    return (
      <Badge shape="mark" aria-label="Skipped">
        <CircleDashed size={13} />
      </Badge>
    );
  }
  return (
    <Badge tone="accent" shape="mark" className="tabular-nums">
      {index + 1}
    </Badge>
  );
}

/** Getting started's whole state, from what the page loaded or, opened from elsewhere, from `-/onboarding`. */
function useView(slug: string, initial: OnboardingView | null, open: boolean): OnboardingView | null {
  const fetcher = useFetcher<{ onboarding: OnboardingView }>({ key: `onboarding-${slug}` });
  const asked = useRef(false);
  useEffect(() => {
    if (!open || initial || asked.current) return;
    asked.current = true;
    fetcher.load(`/${slug}/-/onboarding`);
  }, [open, initial, slug, fetcher]);
  return fetcher.data?.onboarding ?? initial;
}

/**
 * The dialog. `view` is what the page loaded, or null to read it as it
 * opens. Closing it dismisses it for the person; it can always be opened
 * again.
 */
export function OnboardingDialog({
  slug,
  view: loaded,
  open,
  onOpenChange,
}: {
  slug: string;
  view: OnboardingView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const view = useView(slug, loaded, open);
  const saver = useFetcher({ key: `onboarding-save-${slug}` });
  const [step, setStep] = useState<OnboardingStep | null>(null);
  const current = step ?? (view ? firstOpenStep(view.steps) : "ai");

  const close = () => {
    if (view && view.state.dismissed_at == null) {
      void saver.submit({ intent: "dismiss" }, { method: "post", action: `/${slug}/-/onboarding` });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        size="split"
        aria-describedby="onboarding-about"
        onOpenAutoFocus={(event) => {
          // On a phone the sheet itself takes focus, not the first step's
          // segment (a ring for no reason) or a field (the keyboard).
          if (!matchMedia("(max-width: 639px)").matches) return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        {view ? (
          <Guide view={view} step={current} onStep={setStep} onFinish={close} />
        ) : (
          <>
            <DialogTitle className="sr-only">Getting started</DialogTitle>
            <DialogDescription id="onboarding-about" className="sr-only">
              Loading the steps.
            </DialogDescription>
            <GuideSkeleton />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function GuideSkeleton() {
  return (
    <>
      <div className="space-y-3 border-line p-5 max-sm:hidden sm:border-r">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-2 w-full rounded-full" />
        {STEP_ORDER.map((key) => (
          <Skeleton key={key} className="h-11 w-full rounded-lg" />
        ))}
      </div>
      <div aria-busy="true" className="space-y-3 p-6">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-6 h-40 w-full rounded-xl" />
      </div>
    </>
  );
}

function Guide({ view, step, onStep, onFinish }: { view: OnboardingView; step: OnboardingStep; onStep: (step: OnboardingStep) => void; onFinish: () => void }) {
  const { steps, slug } = view;
  const progress = progressOf(steps);
  const done = finished(steps);
  const index = Math.max(
    0,
    steps.findIndex((s) => s.key === step),
  );
  const here = steps[index]!;
  return (
    <Tabs value={step} onValueChange={(value) => onStep(value as OnboardingStep)} orientation="vertical" className="contents">
      {/* The rail: where you are in the guide. A phone has the sheet's header instead. */}
      <aside className="flex min-h-0 flex-col border-line bg-bg/40 max-sm:hidden sm:border-r">
        <div className="space-y-3 p-5 pb-4">
          <div className="flex items-center gap-2.5">
            <Avatar name={slug} size={28} square />
            <div className="min-w-0">
              <p className="text-xs text-muted">Getting started</p>
              <p className="truncate text-sm font-semibold tracking-tight">{view.name}</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Progress value={progress.percent} aria-label="Setup progress" indicatorClassName={done ? "bg-success" : undefined} />
            <p className="text-xs text-muted tabular-nums">{done ? "All set" : `${progress.settled} of ${progress.total} done`}</p>
          </div>
        </div>
        <TabsList variant="rail" aria-label="Steps" className="min-h-0 grow overflow-y-auto px-2 pb-2">
          {steps.map((s, i) => (
            <TabsTrigger key={s.key} value={s.key} variant="rail">
              <StepMark step={s} index={i} />
              <span className="min-w-0">
                <span className="block font-medium text-fg">{s.title}</span>
                <span className="block truncate text-xs text-muted">{s.skipped ? "Skipped" : s.summary}</span>
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        <p className="border-t border-line px-5 py-3 text-xs leading-relaxed text-faint">Closing this puts it away. Open it again from Settings or AI.</p>
      </aside>

      {/* The step at hand. On a touch screen its buttons are a finger's
          size (`h-8` and `h-7` ones grow to 40 and 36 pixels). */}
      <section className="flex min-h-0 flex-col pointer-coarse:[&_[data-slot=button].h-7]:h-9 pointer-coarse:[&_[data-slot=button].h-8]:h-10 pointer-coarse:**:[[role=tab]]:py-2">
        <StepStrip view={view} index={index} onStep={onStep} done={done} />
        {/* Keyed by step, so each one starts at its top. */}
        <div key={step} className="min-h-0 grow overflow-y-auto overscroll-contain p-6 max-sm:px-4 max-sm:pt-5">
          {steps.map((s) => (
            <TabsContent key={s.key} value={s.key} className="mt-0 space-y-5">
              <header className="space-y-2 pr-8">
                <div className="flex items-center gap-2 text-accent">
                  {ABOUT[s.key].icon}
                  <span className="text-xs font-medium tracking-wide uppercase">{s.optional ? "Optional" : "Start here"}</span>
                </div>
                <DialogTitle className="text-xl">{s.title}</DialogTitle>
                <DialogDescription id={s.key === step ? "onboarding-about" : undefined} className="leading-relaxed">
                  {ABOUT[s.key].lead}
                </DialogDescription>
              </header>
              {s.done && (
                <Alert tone="success" role="status">
                  <AlertTitle className="flex items-center gap-1.5">
                    <Check size={14} className="text-success" /> Done
                  </AlertTitle>
                  <AlertDescription>{s.summary}.</AlertDescription>
                </Alert>
              )}
              {s.skipped && (
                <Alert tone="info">
                  <AlertDescription className="mt-0">You skipped this. It's here whenever you want it.</AlertDescription>
                </Alert>
              )}
              <StepBody step={s.key} view={view} onStep={onStep} />
            </TabsContent>
          ))}
        </div>
        <Footer view={view} here={here} index={index} onStep={onStep} onFinish={onFinish} />
      </section>
    </Tabs>
  );
}

/**
 * A phone's rail: where the guide stands, as one segment per step to tap
 * to go to it (green done, lavender here, dimmed skipped), under the
 * workspace's name and the step's place.
 */
function StepStrip({ view, index, onStep, done }: { view: OnboardingView; index: number; onStep: (step: OnboardingStep) => void; done: boolean }) {
  const { steps } = view;
  const progress = progressOf(steps);
  return (
    <nav aria-label="Steps" className="border-b border-line px-4 pt-4 pr-14 sm:hidden">
      <p className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted tabular-nums">
        <span className="truncate font-medium text-fg">{view.name}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{done ? "All set" : `Step ${index + 1} of ${steps.length} · ${progress.settled} done`}</span>
      </p>
      <ol className="-mx-0.5 flex">
        {steps.map((s, i) => (
          <li key={s.key} className="min-w-0 grow">
            <button
              type="button"
              onClick={() => onStep(s.key)}
              aria-current={i === index ? "step" : undefined}
              aria-label={`${s.title}: ${s.done ? "done" : s.skipped ? "skipped" : "to do"}`}
              className="group flex h-10 w-full items-center px-0.5 outline-none"
            >
              <span
                className={cn(
                  "h-1.5 w-full rounded-full transition-[background-color,height] group-focus-visible:ring-2 group-focus-visible:ring-accent/50",
                  s.done ? "bg-success" : s.skipped ? "bg-line" : "bg-line-strong",
                  i === index && (s.done ? "h-2" : "h-2 bg-accent"),
                  i !== index && s.done && "opacity-60",
                )}
              />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Skip, back and next; Finish when there is nothing left, or on the last step. */
function Footer({
  view,
  here,
  index,
  onStep,
  onFinish,
}: {
  view: OnboardingView;
  here: OnboardingStepView;
  index: number;
  onStep: (step: OnboardingStep) => void;
  onFinish: () => void;
}) {
  const skipper = useFetcher({ key: `onboarding-skip-${view.slug}` });
  const steps = view.steps;
  const last = index === steps.length - 1;
  const done = finished(steps);
  const next = () => {
    // Onward to the next step still to do, else simply the next one.
    const later = steps.slice(index + 1);
    const target = later.find((s) => !s.done && !s.skipped) ?? later[0];
    if (target) onStep(target.key);
  };
  const canSkip = here.optional && !here.done;
  return (
    <div className="flex items-center gap-2 border-t border-line bg-surface px-6 py-3.5 max-sm:sticky max-sm:bottom-0 max-sm:px-4">
      {canSkip && (
        <skipper.Form method="post" action={`/${view.slug}/-/onboarding`}>
          <input type="hidden" name="step" value={here.key} />
          <SubmitButton
            fetcher={skipper}
            variant="ghost"
            size="sm"
            name="intent"
            value={here.skipped ? "unskip" : "skip"}
            pending={here.skipped ? "Saving…" : "Skipping…"}
            onClick={() => {
              if (!here.skipped && !last) setTimeout(next, 0);
            }}
          >
            {here.skipped ? "Don't skip" : "Skip for now"}
          </SubmitButton>
        </skipper.Form>
      )}
      <div className="ml-auto flex items-center gap-2">
        {index > 0 && (
          <Button variant="ghost" size="sm" onClick={() => onStep(steps[index - 1]!.key)}>
            <ArrowLeft size={14} />
            Back
          </Button>
        )}
        {/* All done, the steps are still there to look back over. */}
        {done && !last && (
          <Button variant="outline" size="sm" onClick={next}>
            Next
            <ArrowRight size={14} />
          </Button>
        )}
        {done || last ? (
          <Button variant="accent" size="sm" onClick={onFinish}>
            {done ? "Finish" : "Done for now"}
          </Button>
        ) : (
          <Button variant="accent" size="sm" onClick={next}>
            Next
            <ArrowRight size={14} />
          </Button>
        )}
      </div>
    </div>
  );
}

function StepBody({ step, view, onStep }: { step: OnboardingStep; view: OnboardingView; onStep: (step: OnboardingStep) => void }) {
  switch (step) {
    case "ai":
      return <AiStep view={view} />;
    case "ask":
      return <AskStep view={view} onStep={onStep} />;
    case "code":
      return <CodeStep view={view} />;
    case "harness":
      return <HarnessStep view={view} />;
    case "people":
      return <PeopleStep view={view} />;
    case "runner":
      return <RunnerStep view={view} />;
  }
}

// --- 1. An AI provider -------------------------------------------------------

/** The frontier labs, offered first as a row of choices; the rest are in "More". */
const LABS = aiProvidersIn("labs");

function AiStep({ view }: { view: OnboardingView }) {
  const connections = view.connections ?? [];
  const [adding, setAdding] = useState(connections.length === 0);
  return (
    <div className="space-y-5">
      {view.connections == null && <ErrorText>Your AI providers couldn't be read just now. Adding one still works.</ErrorText>}
      {connections.length > 0 && (
        <Card asChild divided className="overflow-hidden">
          <ul aria-label="AI providers">
            {connections.map((connection) => (
              <li key={connection.id} className="p-3.5">
                <ProviderRow slug={view.slug} connection={connection} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {connections.length > 0 ? (
        <Collapsible open={adding} onOpenChange={setAdding}>
          <CollapsibleTrigger>
            <Plus size={14} />
            Add another provider
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-4">
            <AddProvider slug={view.slug} />
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <AddProvider slug={view.slug} />
      )}
      <p className="text-xs text-faint">
        Keys are sealed when saved and never shown again. Everything here is on the{" "}
        <Link to={`/${view.slug}/-/ai`} className="text-muted underline-offset-2 hover:text-fg hover:underline">
          AI page
        </Link>{" "}
        too.
      </p>
    </div>
  );
}

/** A provider the workspace has: whether its key works, and checking it again. */
function ProviderRow({ slug, connection }: { slug: string; connection: AiConnection }) {
  const tester = useFetcher<{ tested?: { id: string; ok: boolean; message: string }; error?: string }>();
  const tested = tester.data?.tested?.id === connection.id ? tester.data.tested : null;
  const working = tested ? tested.ok : !connection.lastError;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <AiProviderMark provider={connection.provider} size={28} />
        <div className="min-w-0 grow">
          <p className="truncate text-sm font-medium">{connection.name}</p>
          <p className="text-xs text-muted sm:truncate">
            {[
              AI_PROVIDERS[connection.provider].label,
              connection.models.length > 0 && `${connection.models.length} models`,
              connection.secretHint && `key ${connection.secretHint}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Badge tone={working ? "success" : "warn"} size="md">
          {working ? "Working" : "Check failed"}
        </Badge>
        <tester.Form method="post" action={`/${slug}/-/ai`}>
          <input type="hidden" name="id" value={connection.id} />
          <SubmitButton fetcher={tester} variant="outline" size="xs" name="intent" value="test" pending="Testing…">
            Test
          </SubmitButton>
        </tester.Form>
      </div>
      {tested ? (
        <p className={tested.ok ? "text-xs text-success" : "text-xs text-danger"} role="status">
          {tested.message}
        </p>
      ) : (
        connection.lastError && <p className="text-xs text-warn">{connection.lastError}</p>
      )}
      <ErrorText>{tester.data?.error}</ErrorText>
    </div>
  );
}

/** Choosing a provider and giving its key, checked as it is saved (the AI page's own action). */
function AddProvider({ slug }: { slug: string }) {
  const adder = useFetcher<{ added?: AiConnection; error?: string; provider?: string }>();
  const [provider, setProvider] = useState<AiProvider>("anthropic");
  const added = adder.data?.added ?? null;
  const more = AI_PROVIDER_GROUPS.filter(({ group }) => group !== "labs");
  const elsewhere = !LABS.includes(provider);
  return (
    <div className="space-y-4">
      {added && (
        <Alert tone={added.lastError ? "warn" : "success"} role="status">
          <AlertTitle>{added.name} is added.</AlertTitle>
          <AlertDescription>
            {added.lastError
              ? `It was saved, but the check failed: ${added.lastError}`
              : added.models.length > 0
                ? `The key works, and it offers ${added.models.length} models.`
                : "The key is saved and works."}
          </AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {LABS.map((key) => (
          <Button
            key={key}
            type="button"
            variant={provider === key ? "soft" : "outline"}
            aria-pressed={provider === key}
            className="h-11 justify-start"
            onClick={() => setProvider(key)}
          >
            <AiProviderMark provider={key} size={20} />
            {AI_PROVIDERS[key].label}
          </Button>
        ))}
      </div>
      <Field label="Or a platform, or your own endpoint">
        <Select value={elsewhere ? provider : ""} onValueChange={(value) => setProvider(value as AiProvider)}>
          <SelectTrigger aria-label="More providers">
            <SelectValue placeholder="More providers" />
          </SelectTrigger>
          <SelectContent>
            {more.map(({ group, title }) => (
              <SelectGroup key={group}>
                <SelectLabel>{title}</SelectLabel>
                {aiProvidersIn(group).map((key) => (
                  <SelectItem key={key} value={key} description={AI_PROVIDER_LOOKS[key].blurb}>
                    {AI_PROVIDERS[key].label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Card tone="plain" className="space-y-4 p-4">
        <div className="flex items-center gap-3">
          <AiProviderMark provider={provider} size={28} />
          <div className="min-w-0">
            <p className="text-sm font-medium">{AI_PROVIDERS[provider].label}</p>
            <p className="text-xs text-muted">{AI_PROVIDER_LOOKS[provider].blurb}</p>
          </div>
        </div>
        {/* Keyed by provider so its fields start empty for each. */}
        <adder.Form key={provider} method="post" action={`/${slug}/-/ai`} className="grid gap-4">
          <input type="hidden" name="provider" value={provider} />
          <ModelProviderFields provider={provider} />
          {adder.data?.provider === provider && <ErrorText>{adder.data.error}</ErrorText>}
          <div>
            <SubmitButton fetcher={adder} variant="accent" pending="Checking the key…">
              <KeyRound size={14} />
              Add and check the key
            </SubmitButton>
          </div>
        </adder.Form>
      </Card>
    </div>
  );
}

// --- 2. Ask's model ----------------------------------------------------------

function AskStep({ view, onStep }: { view: OnboardingView; onStep: (step: OnboardingStep) => void }) {
  const working = (view.connections ?? []).filter((c) => !c.lastError);
  const setup = view.ask;
  const saver = useFetcher<{ asked?: boolean; error?: string }>();
  const current = working.find((c) => c.id === setup?.provider_id) ?? null;
  const [chosen, setChosen] = useState(current?.id ?? working[0]?.id ?? "");
  const connection = working.find((c) => c.id === chosen) ?? null;
  const azure = connection?.provider === "azure_openai";
  if (working.length === 0) {
    return (
      <Card tone="plain" className="space-y-3 p-4">
        <p className="text-sm text-muted">Ask answers with one of the workspace's AI providers. Add one first.</p>
        <Button variant="outline" size="sm" onClick={() => onStep("ai")}>
          <Sparkles size={14} />
          Add an AI provider
        </Button>
      </Card>
    );
  }
  return (
    <saver.Form method="post" action={`/${view.slug}/-/ai`} className="grid gap-4">
      <input type="hidden" name="intent" value="ask" />
      {setup?.problem && (
        <Alert tone="warn">
          <AlertDescription className="mt-0">{setup.problem}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <Select name="providerId" value={chosen} onValueChange={setChosen}>
            <SelectTrigger aria-label="Provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {working.map((c) => (
                <SelectItem key={c.id} value={c.id} description={AI_PROVIDERS[c.provider].label}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={azure ? "Deployment" : "Model"}>
          {connection && autoOffered(connection) ? (
            <Combobox
              key={connection.id}
              name="model"
              defaultValue={defaultModel(connection, setup)}
              aria-label="Model"
              searchPlaceholder="Find a model"
              emptyText="It offers no model by that name."
              options={modelOptions(connection)}
              className="font-mono text-[0.8125rem]"
            />
          ) : (
            <Input
              key={connection?.id}
              name="model"
              required
              defaultValue={defaultModel(connection, setup)}
              placeholder={azure ? "The deployment's name" : "The model's name"}
              className="font-mono text-[0.8125rem]"
              autoComplete="off"
            />
          )}
        </Field>
      </div>
      {saver.data?.asked && !saver.data.error && (
        <p className="text-sm text-success" role="status">
          Saved. Ask answers with it from now on.
        </p>
      )}
      <ErrorText>{saver.data?.error}</ErrorText>
      <div>
        <SubmitButton fetcher={saver} variant="accent" pending="Saving…">
          Use for Ask
        </SubmitButton>
      </div>
    </saver.Form>
  );
}

// --- 3. Code -----------------------------------------------------------------

/** One way in, as a card with its action. */
function Choice({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action: ReactNode }) {
  return (
    <Card tone="plain" className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="text-muted">{icon}</span>
        {title}
      </div>
      <p className="grow text-sm text-muted">{children}</p>
      <div>{action}</div>
    </Card>
  );
}

function CodeStep({ view }: { view: OnboardingView }) {
  const { projects, github } = view.facts;
  return (
    <div className="space-y-4">
      {(projects ?? 0) > 0 && (
        <ButtonLink to={`/${view.slug}/-/projects`} variant="outline" size="sm">
          See its projects
          <ArrowRight size={14} />
        </ButtonLink>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Choice
          icon={<Plus size={15} />}
          title="Start a new project"
          action={
            <ButtonLink to={`/new?workspace=${view.slug}`} variant="accent" size="sm">
              New project
            </ButtonLink>
          }
        >
          An empty repository to push to, or one made from a template.
        </Choice>
        {github?.configured !== false && (
          <Choice
            icon={<GitBranch size={15} />}
            title="Import from GitHub"
            action={
              github?.connected ? (
                <ButtonLink to="/new/github" variant="outline" size="sm">
                  Choose repositories
                </ButtonLink>
              ) : (
                <ButtonLink to={`/integrations/github/install?workspace=${view.slug}`} variant="outline" size="sm">
                  Connect GitHub
                </ButtonLink>
              )
            }
          >
            {github?.connected
              ? "GitHub is connected. Choose the repositories to bring across, with their history."
              : "Connect GitHub in one step, then choose the repositories to bring across, with their history."}
          </Choice>
        )}
      </div>
    </div>
  );
}

// --- 4. The harness ----------------------------------------------------------

function Signed({ on, children }: { on: boolean | null; children: ReactNode }) {
  return (
    <Badge tone={on ? "success" : "neutral"} size="md">
      {on ? <Check size={12} /> : <CircleDashed size={12} />}
      {children}
    </Badge>
  );
}

function Numbered({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
      <Badge shape="mark" className="tabular-nums">
        {n}
      </Badge>
      <p className="self-center text-sm font-medium">{title}</p>
      <div className="col-start-2 space-y-2 max-sm:col-span-2 max-sm:col-start-1">{children}</div>
    </li>
  );
}

function HarnessStep({ view }: { view: OnboardingView }) {
  const { cli, harnessApp } = view.facts;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Signed on={cli}>g1t CLI {cli ? "signed in" : "not signed in yet"}</Signed>
        <Signed on={harnessApp}>AI client {harnessApp ? "signed in" : "not signed in yet"}</Signed>
      </div>
      <ol className="space-y-5">
        <Numbered n={1} title="For local coding: install the g1t CLI and sign in">
          <Tabs defaultValue="unix">
            <TabsList aria-label="Your system">
              <TabsTrigger value="unix">macOS and Linux</TabsTrigger>
              <TabsTrigger value="windows">Windows</TabsTrigger>
            </TabsList>
            <TabsContent value="unix" className="mt-2">
              <CopyLine prompt text="curl -fsSL https://g1t.sh/install | sh" />
            </TabsContent>
            <TabsContent value="windows" className="mt-2">
              <CopyLine prompt text="irm https://g1t.sh/install.ps1 | iex" />
            </TabsContent>
          </Tabs>
          <CopyLine prompt text="g1t auth login" />
        </Numbered>
        <Numbered n={2} title="Connect your AI client">
          <AgentSetup />
        </Numbered>
        <Numbered n={3} title="Approve access in your browser">
          <p className="text-sm text-muted">
            Follow your client's sign-in instructions, review the permissions, and approve the access you want it to have. You can change or revoke access in
            Settings &gt; Connected applications.
          </p>
        </Numbered>
      </ol>
      <ButtonLink to="https://docs.g1t.sh/guides/bring-your-own-agent/" target="_blank" rel="noreferrer" variant="link" size="inline" className="text-sm">
        AI client connection guide
        <ExternalLink size={13} />
      </ButtonLink>
    </div>
  );
}

// --- 5. People ---------------------------------------------------------------

function PeopleStep({ view }: { view: OnboardingView }) {
  const { people, invitesNeedPlan } = view.facts;
  if (invitesNeedPlan) {
    return (
      <div className="space-y-4">
        <Alert tone="info">
          <AlertTitle>Workspace invites come with the plan</AlertTitle>
          <AlertDescription>
            Start the plan to invite your team into {view.name}. Until then, you can invite a friend to g1t with one of your own invites.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <ButtonLink to={`/${view.slug}/-/billing#plan`} variant="accent" size="sm">
            See the plan
          </ButtonLink>
          <ButtonLink to="/settings/invites" variant="outline" size="sm">
            Invite a friend to g1t
          </ButtonLink>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {people && (people.others > 0 || people.pending > 0) && (
        <p className="text-sm text-muted">
          {people.others} {people.others === 1 ? "other member" : "other members"}
          {people.pending > 0 && `, ${people.pending} ${people.pending === 1 ? "invitation" : "invitations"} waiting for an answer`}.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <ButtonLink to={`/${view.slug}/-/members`} variant="accent" size="sm">
          <Users size={14} />
          Invite people
        </ButtonLink>
        {people && people.pending > 0 && (
          <ButtonLink to={`/${view.slug}/-/members/invitations`} variant="outline" size="sm">
            See invitations
          </ButtonLink>
        )}
      </div>
    </div>
  );
}

// --- 6. A runner -------------------------------------------------------------

function RunnerStep({ view }: { view: OnboardingView }) {
  return (
    <div className="flex flex-wrap gap-2">
      <ButtonLink to="/download" variant="accent" size="sm">
        <Laptop size={14} />
        Get the desktop app
      </ButtonLink>
      <ButtonLink to={`/${view.slug}/-/runners`} variant="outline" size="sm">
        {(view.facts.runners ?? 0) > 0 ? "See its runners" : "Other ways to add one"}
      </ButtonLink>
    </div>
  );
}

// --- Opening it ---------------------------------------------------------------

/**
 * Getting started on a page that loaded it (Home, the Workspace page):
 * opens by itself once, when it arrives, for an owner who has not
 * dismissed it, or when the address asks (`?setup`). Later loads of the
 * page (after adding a provider, say) refresh what it shows without
 * opening or closing it.
 */
export function OnboardingOnPage({ slug, view: pending, asked }: { slug: string; view: Promise<OnboardingView | null>; asked: boolean }) {
  const [view, setView] = useState<OnboardingView | null>(null);
  const [open, setOpen] = useState(false);
  const decided = useRef(false);
  useEffect(() => {
    let live = true;
    void pending.then((arrived) => {
      if (!live || !arrived) return;
      setView(arrived);
      if (!decided.current) {
        decided.current = true;
        if (opensByItself(arrived, asked)) setOpen(true);
      }
    });
    return () => {
      live = false;
    };
  }, [pending, asked]);
  if (!view) return null;
  return <OnboardingDialog slug={slug} view={view} open={open} onOpenChange={setOpen} />;
}

/** The button that opens Getting started from a page that did not load it: Settings → General and the AI page. */
export function GettingStartedButton({ slug, variant = "outline" }: { slug: string; variant?: "outline" | "soft" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Hint label="Your AI provider, code, harness, team and runner, step by step">
        <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
          <Rocket size={14} />
          Getting started
        </Button>
      </Hint>
      {open && <OnboardingDialog slug={slug} view={null} open={open} onOpenChange={setOpen} />}
    </>
  );
}
