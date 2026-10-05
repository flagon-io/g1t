import { ArrowRight, Check, Sparkles } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/soon";
import { page } from "../../lib/meta";
import { ROADMAP, roadmapIn, roadmapItem } from "../../lib/roadmap";

export function meta({ params, ...args }: Route.MetaArgs) {
  const item = roadmapItem(params.feature);
  return page(args, {
    title: `${item?.title ?? "Soon"} · ${params.owner}/${params.repo} · g1t`,
    description: item ? `Soon on g1t: ${item.summary}` : null,
    version: item ? [item.title, item.summary] : undefined,
  });
}

export function loader({ params }: Route.LoaderArgs) {
  const item = roadmapItem(params.feature);
  if (!item) throw data(null, { status: 404 });
  return { item };
}

/**
 * A page a project will have: what it is for, what it will do, and what
 * to use until then. Reached from the project menu's Soon items.
 */
export default function Soon({ loaderData, params }: Route.ComponentProps) {
  const { item } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const siblings = roadmapIn(item.section).filter((other) => other.key !== item.key);
  return (
    <div className="mx-auto max-w-3xl">
      <p className="flex items-center gap-2 text-sm text-muted">
        <span>{item.section}</span>
        <span className="text-line-strong">/</span>
        <span className="text-fg">{item.title}</span>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{item.title}</h1>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
          <Sparkles size={12} />
          Soon
        </span>
      </div>
      <p className="mt-3 text-lg text-muted">{item.summary}</p>

      <section className="mt-8 rounded-xl border border-line bg-surface p-6">
        <p className="leading-relaxed">{item.why}</p>
        <h2 className="mt-6 text-sm font-medium text-muted">What it will do</h2>
        <ul className="mt-3 space-y-2.5">
          {item.plans.map((plan) => (
            <li key={plan} className="flex gap-3 text-sm">
              <Check size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>{plan}</span>
            </li>
          ))}
        </ul>
      </section>

      {item.today && (
        <Link
          to={`${base}/${item.today.path}`}
          className="group mt-4 flex items-center justify-between gap-4 rounded-xl border border-line px-5 py-4 transition-colors hover:border-line-strong hover:bg-surface"
        >
          <span>
            <span className="block text-xs text-faint">Until then</span>
            <span className="mt-0.5 block text-sm font-medium">{item.today.label}</span>
          </span>
          <ArrowRight size={16} className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
        </Link>
      )}

      {siblings.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-muted">Also coming to {item.section}</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {siblings.map((other) => (
              <li key={other.key}>
                <Link
                  to={`${base}/soon/${other.key}`}
                  className="block h-full rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-surface"
                >
                  <span className="text-sm font-medium">{other.title}</span>
                  <span className="mt-1 block text-sm text-muted">{other.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-10 text-xs text-faint">
        {ROADMAP.length} things are on the way to every project. Want this one sooner, or something else?{" "}
        <a href="https://g1t.sh/syntaqx/g1t/issues/new" className="text-muted hover:text-fg">
          Tell us
        </a>
        .
      </p>
    </div>
  );
}
