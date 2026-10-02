import { NavLink, data } from "react-router";

import type { Route } from "./+types/docs";
import { Markdown } from "../components/markdown";

const sources = import.meta.glob<string>("../docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const PAGES: { slug: string; title: string }[] = [
  { slug: "", title: "Getting started" },
  { slug: "concepts", title: "Concepts" },
  { slug: "git", title: "Git" },
  { slug: "agents", title: "Connect an agent" },
  { slug: "api", title: "API" },
];

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.title ?? "Docs"} · g1t docs` }];
}

export function loader({ params }: Route.LoaderArgs) {
  const slug = params.page ?? "";
  const page = PAGES.find((candidate) => candidate.slug === slug);
  const source = sources[`../docs/${slug || "index"}.md`];
  if (!page || !source) throw data(null, { status: 404 });
  return { title: page.title, source };
}

export default function Docs({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 md:grid-cols-[13rem_1fr]">
      <nav aria-label="Documentation" className="md:sticky md:top-24 md:self-start">
        <p className="px-3 text-xs font-medium tracking-wide text-faint uppercase">
          Documentation
        </p>
        <ul className="mt-3 space-y-0.5">
          {PAGES.map((page) => (
            <li key={page.slug}>
              <NavLink
                to={page.slug ? `/docs/${page.slug}` : "/docs"}
                end
                className={({ isActive }) =>
                  `block rounded-md px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? "bg-raised font-medium text-fg"
                      : "text-muted hover:text-fg"
                  }`
                }
              >
                {page.title}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <article className="max-w-3xl min-w-0">
        <Markdown source={loaderData.source} />
      </article>
    </div>
  );
}
