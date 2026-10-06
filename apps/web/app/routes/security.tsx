import type { Route } from "./+types/security";
import { Contents, PolicyText, TrustPage, outline } from "../components/legal-doc";
import { CONTACT } from "../lib/legal";
import { page } from "../lib/meta";
import text from "../content/security.md?raw";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "Security · g1t",
    description:
      "How g1t protects your code, accounts and agents: per-run credentials, the audit log, guardrails, isolated sandboxes and push protection. And how to report a vulnerability.",
  });
}

export default function Security() {
  return (
    <TrustPage
      eyebrow="Security"
      title="How g1t keeps your code and accounts safe"
      lede={
        <p>
          What we actually do to protect what you build on g1t, and what we haven't built yet. Found a problem? Write
          to{" "}
          <a className="text-accent hover:underline" href={`mailto:${CONTACT.security}`}>
            {CONTACT.security}
          </a>
          .
        </p>
      }
      aside={<Contents items={outline(text)} />}
    >
      <PolicyText source={text} />
    </TrustPage>
  );
}
