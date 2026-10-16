import { ArrowRight, Bot, GitBranch, GitMerge, MessagesSquare, Rocket, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import type { Route } from "./+types/features";
import { TrustPage } from "../components/trust-page";
import { Card } from "../components/ui/card";
import { ButtonLink } from "../components/ui";
import { FEATURES } from "../lib/features";
import { page } from "../lib/meta";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "g1t features · Code, agents, chat and deployments",
    canonical: true,
    description: "Explore g1t features: git repositories, pull requests, coding agents over MCP and REST, workflows, merge queues, deployments, team chat and security.",
  });
}

const ICONS = [GitBranch, Bot, GitMerge, Rocket, MessagesSquare, ShieldCheck];

export default function Features() {
  return (
    <TrustPage eyebrow="g1t features" title="From the first conversation to shipped code." lede="One workspace for your team's code and the coding agents you already use. Plan the work, review the changes and follow them into production.">
      <div className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map((feature, index) => {
          const Icon = ICONS[index]!;
          return (
            <Card asChild key={feature.id} className="flex flex-col p-6">
              <section aria-labelledby={feature.id}>
                <Icon size={22} className="mb-5 text-accent" aria-hidden />
                <h2 id={feature.id} className="text-xl font-semibold tracking-tight">{feature.title}</h2>
                <p className="mt-3 grow text-sm leading-relaxed text-muted">{feature.description}</p>
                <div className="mt-5 flex flex-wrap gap-x-5 gap-y-3">
                  {feature.links.map((link) => <Link key={link.href} to={link.href} className="inline-flex items-center gap-1.5 text-sm font-medium hover:text-accent">{link.label}<ArrowRight size={14} aria-hidden /></Link>)}
                </div>
              </section>
            </Card>
          );
        })}
      </div>
      <section className="mt-10 border-t border-line pt-8">
        <h2 className="text-2xl font-semibold tracking-tight">Start with the free forge.</h2>
        <p className="mt-3 max-w-2xl text-muted">Create an account and a scoped access token yourself. Public repository reads need no token. Compute has separate usage costs; the pricing page explains what is included.</p>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <ButtonLink to="/register">Get started</ButtonLink>
          <Link to="/pricing" className="text-sm font-medium hover:text-accent">See pricing</Link>
          <Link to="https://docs.g1t.sh/about/limitations/" className="text-sm text-muted hover:text-fg">Current limitations</Link>
        </div>
      </section>
    </TrustPage>
  );
}
