import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import { Link, NavLink, data } from "react-router";

import type { Route } from "./+types/docs";
import { Markdown } from "../components/markdown";

const sources = import.meta.glob<string>("../docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

type Page = { slug: string; title: string };

const SECTIONS: { title: string; pages: Page[] }[] = [
  {
    title: "Get started",
    pages: [
      { slug: "", title: "Quickstart" },
      { slug: "concepts", title: "Concepts" },
    ],
  },
  {
    title: "Guides",
    pages: [
      { slug: "authentication", title: "Accounts and authentication" },
      { slug: "git", title: "Git" },
      { slug: "g1t-agents", title: "g1t agents" },
      { slug: "agents", title: "Bring your own agent" },
    ],
  },
  {
    title: "Reference",
    pages: [{ slug: "api", title: "API overview" }],
  },
];

const PAGES = SECTIONS.flatMap((section) => section.pages);

function href(page: Page): string {
  return page.slug ? `/docs/${page.slug}` : "/docs";
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: `${loaderData?.title ?? "Docs"} · g1t docs` },
    {
      tagName: "link",
      rel: "canonical",
      href: `https://docs.g1t.sh/${loaderData?.slug ?? ""}`,
    },
  ];
}

export function loader({ params }: Route.LoaderArgs) {
  const slug = params.page ?? "";
  const index = PAGES.findIndex((candidate) => candidate.slug === slug);
  const source = sources[`../docs/${slug || "index"}.md`];
  if (index < 0 || !source) throw data(null, { status: 404 });
  return {
    slug,
    title: PAGES[index].title,
    source,
    previous: PAGES[index - 1] ?? null,
    next: PAGES[index + 1] ?? null,
  };
}

export default function Docs({ loaderData }: Route.ComponentProps) {
  const { source, previous, next } = loaderData;
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-10 md:grid-cols-[14rem_1fr]">
      <nav
        aria-label="Documentation"
        className="space-y-6 md:sticky md:top-24 md:self-start"
      >
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <p className="px-3 text-xs font-medium tracking-wide text-faint uppercase">
              {section.title}
            </p>
            <ul className="mt-2 space-y-0.5">
              {section.pages.map((page) => (
                <li key={page.slug}>
                  <NavLink
                    to={href(page)}
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
              {section.title === "Reference" && (
                <>
                  <li>
                    <a
                      href="/docs/api/reference"
                      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted hover:text-fg"
                    >
                      API reference
                      <ExternalLink size={12} />
                    </a>
                  </li>
                  <li>
                    <a
                      href="/llms.txt"
                      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted hover:text-fg"
                    >
                      llms.txt
                      <ExternalLink size={12} />
                    </a>
                  </li>
                </>
              )}
            </ul>
          </div>
        ))}
      </nav>
      <article className="max-w-3xl min-w-0">
        <Markdown source={source} />
        <nav className="mt-16 grid gap-3 border-t border-line pt-6 sm:grid-cols-2">
          {previous ? (
            <Link
              to={href(previous)}
              className="rounded-xl border border-line p-4 transition-colors hover:border-line-strong"
            >
              <span className="flex items-center gap-1.5 text-xs text-faint">
                <ArrowLeft size={12} /> Previous
              </span>
              <span className="mt-1 block font-medium">{previous.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link
              to={href(next)}
              className="rounded-xl border border-line p-4 text-right transition-colors hover:border-line-strong"
            >
              <span className="flex items-center justify-end gap-1.5 text-xs text-faint">
                Next <ArrowRight size={12} />
              </span>
              <span className="mt-1 block font-medium">{next.title}</span>
            </Link>
          )}
        </nav>
      </article>
    </div>
  );
}
