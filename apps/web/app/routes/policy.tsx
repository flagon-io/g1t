import { data, Link } from "react-router";

import type { Route } from "./+types/policy";
import { Contents, PolicyText, TrustPage, outline } from "../components/legal-doc";
import { POLICIES, POLICIES_UPDATED, longDate } from "../lib/legal";
import { page } from "../lib/meta";
import acceptableUse from "../content/policies/acceptable-use.md?raw";
import privacy from "../content/policies/privacy.md?raw";
import refunds from "../content/policies/refunds.md?raw";
import subprocessors from "../content/policies/subprocessors.md?raw";
import terms from "../content/policies/terms.md?raw";

/** Each policy's text, written in Markdown in app/content/policies. */
const TEXT: Record<string, string> = {
  terms,
  privacy,
  "acceptable-use": acceptableUse,
  refunds,
  subprocessors,
};

export function loader({ params }: Route.LoaderArgs) {
  const policy = POLICIES.find((p) => p.slug === params.policy);
  if (!policy || !TEXT[policy.slug]) throw data(null, { status: 404 });
  return { policy };
}

export function meta({ loaderData, ...args }: Route.MetaArgs) {
  const policy = loaderData?.policy;
  return page(args, {
    title: policy ? `${policy.title} · g1t` : "Policies · g1t",
    description: policy?.summary,
  });
}

export default function Policy({ loaderData }: Route.ComponentProps) {
  const { policy } = loaderData;
  const source = TEXT[policy.slug];
  return (
    <TrustPage
      eyebrow={
        <Link to="/policies" className="hover:underline hover:underline-offset-4">
          Policies
        </Link>
      }
      title={policy.title}
      lede={<p className="text-sm">Last updated {longDate(POLICIES_UPDATED)}.</p>}
      aside={<Contents items={outline(source)} />}
    >
      <PolicyText source={source} />
      <nav aria-label="Other policies" className="mt-14 max-w-3xl border-t border-line pt-6">
        <p className="text-sm font-medium">Other policies</p>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
          {POLICIES.filter((p) => p.slug !== policy.slug).map((p) => (
            <li key={p.slug}>
              <Link to={`/policies/${p.slug}`} className="hover:text-fg">
                {p.title}
              </Link>
            </li>
          ))}
          <li>
            <Link to="/security" className="hover:text-fg">
              Security
            </Link>
          </li>
        </ul>
      </nav>
    </TrustPage>
  );
}
