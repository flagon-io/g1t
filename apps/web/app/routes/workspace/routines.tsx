/**
 * Routines: standing work for @g1t. Someone says what to do, when, and
 * where the result lands, and it runs by itself after that, whether or not
 * anyone is at a keyboard. A routine is not only about code: a morning
 * brief, a digest posted to a channel, a watch on production or a topic,
 * a reminder, as much as triaging issues or fixing CI on main.
 *
 * Not on yet. The page is here so Routines has its place in the rail and
 * its shape is settled: every control is drawn and none can be used (the
 * composer is a disabled <fieldset>, the lists are empty, the starting
 * points cannot be picked). Nothing is read or saved.
 */
import {
  AtSign,
  Bell,
  CalendarClock,
  FileText,
  GitPullRequest,
  Hash,
  type LucideIcon,
  MousePointerClick,
  Plus,
  Repeat,
  Tag,
  Users,
  Zap,
} from "lucide-react";
import { data } from "react-router";

import type { Route } from "./+types/routines";
import { EmptyState, SoonPill } from "../../components/ui";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { page } from "../../lib/meta";
import { getViewer } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Routines · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const membership = viewer?.workspaces?.find((m) => m.slug === slug);
  if (!viewer || !membership) throw data(null, { status: 404 });
  return { slug, name: membership.name?.trim() || slug };
}

/** A starting point: what it asks, when it runs, and where what it does lands. */
type Starter = { title: string; prompt: string; when: { icon: LucideIcon; text: string }; lands: { icon: LucideIcon; text: string } };

const SCHEDULE = CalendarClock;
const EVENT = Zap;

/** Starting points, by what they are for: code is one kind among several. */
const STARTERS: { title: string; about: string; items: Starter[] }[] = [
  {
    title: "Keep up",
    about: "Yours alone: what needs you, gathered for you.",
    items: [
      {
        title: "Morning brief",
        prompt: "Tell me what shipped overnight, what is waiting on me, and what I said I would do today.",
        when: { icon: SCHEDULE, text: "Weekdays at 8:30" },
        lands: { icon: AtSign, text: "Your DM with @g1t" },
      },
      {
        title: "Follow up for me",
        prompt: "When a pull request I am reviewing has waited two days, nudge me. After four, tell its author I am behind.",
        when: { icon: EVENT, text: "When a review waits" },
        lands: { icon: Bell, text: "Your notifications" },
      },
      {
        title: "Remind me, with a draft",
        prompt: "Remind me to write the week's notes, with a first draft from what I did this week.",
        when: { icon: SCHEDULE, text: "Once, Friday at 16:00" },
        lands: { icon: AtSign, text: "Your DM with @g1t" },
      },
    ],
  },
  {
    title: "Team",
    about: "The workspace's: kept by a team, so they outlive anyone leaving.",
    items: [
      {
        title: "What changed",
        prompt: "Post what shipped yesterday, what is in review, and what is stuck, with links.",
        when: { icon: SCHEDULE, text: "Weekdays at 9:00" },
        lands: { icon: Hash, text: "#general" },
      },
      {
        title: "The week's decisions",
        prompt: "Collect the decisions made this week in sessions, pull requests and chat into one page, newest first.",
        when: { icon: SCHEDULE, text: "Fridays at 15:00" },
        lands: { icon: FileText, text: "An artifact" },
      },
      {
        title: "Thread digest",
        prompt: "When a thread passes 20 messages, sum up where it landed and what is still open.",
        when: { icon: EVENT, text: "When a thread grows" },
        lands: { icon: Hash, text: "A reply in the thread" },
      },
    ],
  },
  {
    title: "Code",
    about: "On a repository: what they change goes through review and checks like anyone's.",
    items: [
      {
        title: "Triage new issues",
        prompt: "Label each new issue, find what it duplicates, and ask the reporter for what is missing.",
        when: { icon: EVENT, text: "When an issue opens" },
        lands: { icon: Tag, text: "Labels and a comment" },
      },
      {
        title: "Fix CI on main",
        prompt: "Find why the run on main failed and open a pull request that fixes it.",
        when: { icon: EVENT, text: "When CI fails on main" },
        lands: { icon: GitPullRequest, text: "A draft pull request" },
      },
      {
        title: "Dependency pass",
        prompt: "Update what is out of date, read the changelogs, and fix what the updates break.",
        when: { icon: SCHEDULE, text: "Mondays at 6:00" },
        lands: { icon: GitPullRequest, text: "A draft pull request" },
      },
      {
        title: "Docs in step",
        prompt: "When a pull request merges, check the docs about what it changed still say what is true.",
        when: { icon: EVENT, text: "When a pull request merges" },
        lands: { icon: GitPullRequest, text: "A draft pull request" },
      },
    ],
  },
  {
    title: "Watch",
    about: "Keeping an eye on something, and saying only when it matters.",
    items: [
      {
        title: "Errors in production",
        prompt: "When errors jump, find the requests behind them and the change that started it.",
        when: { icon: EVENT, text: "When errors spike" },
        lands: { icon: Hash, text: "#incidents" },
      },
      {
        title: "Spend",
        prompt: "When spend passes 80% of the month's budget, say what is driving it and what could stop.",
        when: { icon: EVENT, text: "At 80% of budget" },
        lands: { icon: Users, text: "Workspace owners" },
      },
      {
        title: "A topic",
        prompt: "Read what is new on a topic through our connectors and keep a running brief, changes at the top.",
        when: { icon: SCHEDULE, text: "Daily at 7:00" },
        lands: { icon: FileText, text: "An artifact" },
      },
    ],
  },
];

/** How a routine works, in three parts. */
const PARTS = [
  {
    icon: FileText,
    title: "Say what",
    body: "In plain words, as you would ask a person. About code, or about anything @g1t can reach: chat, artifacts, issues, production, and what your connectors let it read.",
  },
  {
    icon: Repeat,
    title: "Say when",
    body: "On a schedule or once; when something happens (an issue opens, CI fails, a thread grows, errors spike); or by hand and through the API.",
  },
  {
    icon: MousePointerClick,
    title: "Say where it lands",
    body: "A message, an artifact, a comment, an issue, a draft pull request. What it writes goes through the same review and checks as anyone's.",
  },
];

export default function Routines({ loaderData }: Route.ComponentProps) {
  const { name } = loaderData;
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Routines</h1>
            <SoonPill />
          </div>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Standing work for @g1t. Say what to do, when, and where it lands, and it gets done whether or not anyone is at a keyboard.
          </p>
        </div>
        <Button disabled>
          <Plus size={15} />
          New routine
        </Button>
      </div>

      <Alert tone="info" className="mt-6" id="routines-soon">
        Routines are not on yet. This is what they will be: nothing here can be turned on, and nothing you type is kept.
      </Alert>

      <Card asChild className="mt-6 p-4 sm:p-5">
        <section aria-labelledby="compose">
          <h2 id="compose" className="text-sm font-semibold">
            New routine
          </h2>
          <fieldset disabled aria-describedby="routines-soon" className="mt-4 flex min-w-0 flex-col gap-5">
            <Field>
              <FieldLabel htmlFor="routine-prompt">What should it do?</FieldLabel>
              <Textarea
                id="routine-prompt"
                placeholder="Every weekday at 9, post what shipped yesterday and what is waiting on review to #general."
              />
              <FieldDescription>Each run starts fresh, so say everything it needs to know.</FieldDescription>
            </Field>
            <div className="grid gap-5 md:grid-cols-2">
              <Field>
                <FieldLabel>When</FieldLabel>
                <ToggleGroup className="self-start" type="single" variant="outline" size="sm" defaultValue="schedule" disabled aria-label="When it runs">
                  <ToggleGroupItem value="schedule">On a schedule</ToggleGroupItem>
                  <ToggleGroupItem value="once">Once</ToggleGroupItem>
                  <ToggleGroupItem value="event">When something happens</ToggleGroupItem>
                  <ToggleGroupItem value="manual">By hand</ToggleGroupItem>
                </ToggleGroup>
                <Input aria-label="Schedule" placeholder="Every weekday at 9:00" />
              </Field>
              <Field>
                <FieldLabel>Where it lands</FieldLabel>
                <ToggleGroup className="self-start" type="single" variant="outline" size="sm" defaultValue="dm" disabled aria-label="Where it lands">
                  <ToggleGroupItem value="dm">Your DM</ToggleGroupItem>
                  <ToggleGroupItem value="channel">A channel</ToggleGroupItem>
                  <ToggleGroupItem value="artifact">An artifact</ToggleGroupItem>
                  <ToggleGroupItem value="pull">A pull request</ToggleGroupItem>
                </ToggleGroup>
                <FieldDescription>It writes nowhere else: anything bigger waits for a person to say yes.</FieldDescription>
              </Field>
            </div>
            <Field>
              <FieldLabel>Whose it is</FieldLabel>
              <ToggleGroup className="self-start" type="single" variant="outline" size="sm" defaultValue="mine" disabled aria-label="Whose it is">
                <ToggleGroupItem value="mine">Yours</ToggleGroupItem>
                <ToggleGroupItem value="workspace">{name}'s</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                Yours runs as you, with what you can reach. {name}'s is kept by a team and seen by everyone in it.
              </FieldDescription>
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
              <Button variant="outline">Try it once</Button>
              <Button>Create routine</Button>
            </div>
          </fieldset>
        </section>
      </Card>

      <section aria-labelledby="listed" className="mt-10">
        <h2 id="listed" className="sr-only">
          Routines and their runs
        </h2>
        <Tabs defaultValue="yours">
          <TabsList aria-label="Which routines">
            <TabsTrigger value="yours">Yours</TabsTrigger>
            <TabsTrigger value="workspace" disabled>
              {name}'s
            </TabsTrigger>
            <TabsTrigger value="runs" disabled>
              Runs
            </TabsTrigger>
          </TabsList>
          <TabsContent value="yours">
            <EmptyState title="No routines yet">
              Each one will show here with when it last ran, what it did, and what it cost. Every run is a session you can open and read.
            </EmptyState>
          </TabsContent>
        </Tabs>
      </section>

      <section aria-labelledby="starters" className="mt-10">
        <h2 id="starters" className="text-sm font-semibold">
          Start from one of these
        </h2>
        <p className="mt-1 text-sm text-muted">Code is one kind of routine among several.</p>
        <div className="mt-4 flex flex-col gap-8">
          {STARTERS.map((group) => (
            <div key={group.title}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{group.title}</h3>
                <p className="text-xs text-faint">{group.about}</p>
              </div>
              <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
                {group.items.map((starter) => (
                  <StarterCard key={starter.title} starter={starter} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="how" className="mt-12">
        <h2 id="how" className="text-sm font-semibold">
          How a routine works
        </h2>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {PARTS.map(({ icon: Icon, title, body }) => (
            <Card key={title} tone="plain" radius="lg" className="p-4">
              <Icon size={16} className="text-accent" aria-hidden="true" />
              <h3 className="mt-2 text-sm font-medium">{title}</h3>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </Card>
          ))}
        </div>
        <p className="mt-4 max-w-3xl text-sm text-muted">
          Every run is a session: titled, recorded and on {name}'s bill, so you can see what each routine did, when, and why. It thinks with
          your workspace's AI, or runs as your own agent on a runner, in a sandbox. Each has a budget per run and per day, and can be paused
          at any time.
        </p>
      </section>
    </main>
  );
}

/** One starting point: its name, what it asks, when, and where it lands. Picking it comes with Routines. */
function StarterCard({ starter }: { starter: Starter }) {
  const When = starter.when.icon;
  const Lands = starter.lands.icon;
  return (
    <Card radius="lg" className="flex flex-col p-4" aria-disabled="true">
      <h4 className="text-sm font-medium">{starter.title}</h4>
      <p className="mt-1 grow text-sm text-muted">{starter.prompt}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge>
          <When size={11} aria-hidden="true" />
          {starter.when.text}
        </Badge>
        <Badge>
          <Lands size={11} aria-hidden="true" />
          {starter.lands.text}
        </Badge>
      </div>
      <Button variant="outline" size="xs" className="mt-3 self-start" disabled>
        Use this
      </Button>
    </Card>
  );
}
