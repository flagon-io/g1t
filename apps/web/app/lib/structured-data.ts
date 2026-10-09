/**
 * Schema.org JSON-LD for the pages that say what g1t is and what it costs,
 * so search engines and AI assistants read it without parsing the prose.
 * Each is a `script:ld+json` meta descriptor, added after `page(…)`.
 */
import type { MetaDescriptor } from "react-router";

import { COMPANY, SOCIAL } from "./legal";
import { DESCRIPTION, SITE } from "./meta";

export function organization(): MetaDescriptor {
  return {
    "script:ld+json": {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: COMPANY.name,
      url: COMPANY.url,
      founder: { "@type": "Person", name: COMPANY.founder },
      brand: { "@type": "Brand", name: "g1t", url: SITE, sameAs: SOCIAL.map((account) => account.url) },
    },
  };
}

/** g1t as an application, with the plan's monthly price per workspace. */
export function application(monthlyDollars: number): MetaDescriptor {
  return {
    "script:ld+json": {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "g1t",
      url: SITE,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      description: DESCRIPTION,
      publisher: { "@type": "Organization", name: COMPANY.name, url: COMPANY.url },
      license: "https://opensource.org/licenses/MIT",
      offers: [
        {
          "@type": "Offer",
          name: "Free",
          price: "0",
          priceCurrency: "USD",
          description: "Chat and the forge, with no card.",
        },
        {
          "@type": "Offer",
          name: "The g1t plan",
          price: String(monthlyDollars),
          priceCurrency: "USD",
          description: "A month per workspace, never per seat, with $10 of usage included.",
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            price: String(monthlyDollars),
            priceCurrency: "USD",
            unitText: "month per workspace",
          },
        },
      ],
    },
  };
}

export function faqPage(questions: { q: string; a: string }[]): MetaDescriptor {
  return {
    "script:ld+json": {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: questions.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  };
}
