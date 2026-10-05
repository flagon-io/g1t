/**
 * The changes staff make to how a workspace or an enterprise pays: terms,
 * moving workspaces on and off enterprises, credits, and Stripe billing
 * links. What is acted on comes from the billing service and identity, not
 * from the form; each change shows a confirmation first, and a credit
 * needs the workspace's slug typed out.
 */
import type { Terms } from "@g1t/contracts";
import { data, redirect } from "react-router";

import { fields, parseCredit, parseEmail, parseNote, parseSlug, parseTerms, text } from "./forms";
import type { ActionData } from "./review";
import { admin, identity } from "./services.server";
import type { Staff } from "./staff";
import type { Enterprise } from "./workspaces";

/** What a page acts on. `accountId` is billing's internal id, never shown. */
export type Subject =
  | { kind: "workspace"; slug: string; accountId: string; terms: Terms; billedTo: Enterprise | null }
  | { kind: "enterprise"; accountId: string; name: string; terms: Terms; workspaces: string[]; billingEmail: string | null };

function failed(section: string, error: string, values?: Record<string, string>) {
  return data<ActionData>({ error, section, values }, { status: 422 });
}

export async function billingAction(request: Request, staff: Staff, subject: Subject, path: string) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const confirmed = text(form, "confirm") === "yes";
  const back = (done: string) => redirect(`${path}?done=${done}#top`);
  const isEnterprise = subject.kind === "enterprise";

  if (intent === "terms") {
    const values = fields(form, "kind", "discount", "ceiling", "note", "until");
    if (subject.kind === "workspace" && subject.billedTo) {
      return failed("terms", `This workspace is charged on ${subject.billedTo.name}'s terms. Change them on the enterprise.`, values);
    }
    const terms = parseTerms(form, staff.email);
    if (!terms.ok) return failed("terms", terms.error, values);
    if (!confirmed) return { review: { intent, before: subject.terms, after: terms.value, fields: values } } satisfies ActionData;
    const result = await admin.setTerms(subject.accountId, terms.value, staff.email);
    if (!result.ok) return failed("terms", result.error.message, values);
    return back("terms");
  }

  if (intent === "attach") {
    const values = fields(form, "workspace", "target");
    const section = isEnterprise ? "members" : "billed-to";
    let slug: string;
    let target: Enterprise;
    if (subject.kind === "enterprise") {
      const parsed = parseSlug(values.workspace);
      if (!parsed.ok) return failed(section, parsed.error, values);
      slug = parsed.value;
      if (subject.workspaces.includes(slug)) return failed(section, `${slug} is already on this enterprise.`, values);
      if (!(await identity.workspace(slug))) return failed(section, `There is no workspace called ${slug}.`, values);
      target = { id: subject.accountId, name: subject.name };
    } else {
      slug = subject.slug;
      const enterprise = (await admin.accounts()).find((row) => row.account.kind === "enterprise" && row.account.id === values.target);
      if (!enterprise) return failed(section, "Choose an enterprise to move onto.", values);
      target = { id: enterprise.account.id, name: enterprise.account.name };
    }
    if (!confirmed) return { review: { intent, workspace: slug, targetName: target.name, fields: values } } satisfies ActionData;
    const result = await admin.attach(slug, target.id, staff.email);
    if (!result.ok) return failed(section, result.error.message, values);
    return back("attach");
  }

  if (intent === "detach") {
    const values = fields(form, "workspace");
    const section = isEnterprise ? "members" : "billed-to";
    let slug: string;
    let from: string;
    if (subject.kind === "enterprise") {
      slug = values.workspace;
      if (!subject.workspaces.includes(slug)) return failed(section, `${slug} is not on this enterprise.`);
      from = subject.name;
    } else {
      if (!subject.billedTo) return failed(section, `${subject.slug} already pays for itself.`);
      slug = subject.slug;
      from = subject.billedTo.name;
    }
    if (!confirmed) return { review: { intent, workspace: slug, from, fields: values } } satisfies ActionData;
    const result = await admin.attach(slug, null, staff.email);
    if (!result.ok) return failed(section, result.error.message);
    return back("detach");
  }

  if (intent === "credit") {
    const values = fields(form, "workspace", "amount", "note", "confirmation");
    const workspace = subject.kind === "enterprise" ? values.workspace : subject.slug;
    if (subject.kind === "enterprise" && !subject.workspaces.includes(workspace)) {
      return failed("credit", "Choose one of this enterprise's workspaces.", values);
    }
    const amount = parseCredit(values.amount);
    if (!amount.ok) return failed("credit", amount.error, values);
    const note = parseNote(values.note);
    if (!note.ok) return failed("credit", note.error, values);
    if (values.confirmation !== workspace) {
      return failed("credit", `Type the workspace's slug, ${workspace}, exactly, to issue the credit.`, { ...values, confirmation: "" });
    }
    const result = await admin.credit(workspace, amount.value, note.value, staff.email);
    if (!result.ok) return failed("credit", result.error.message, values);
    return back("credit");
  }

  if (intent === "billing-link") {
    if (subject.kind !== "workspace") return failed("top", "Billing links are made from a workspace's page.");
    if (!confirmed) return { review: { intent, workspace: subject.slug, fields: {} } } satisfies ActionData;
    const result = await admin.billingLink(subject.slug, staff.email);
    if (!result.ok) return failed("billing-link", result.error.message);
    // Shown once, in this response only: it is never stored or redirected to.
    return { link: result.value, workspace: subject.slug } satisfies ActionData;
  }

  if (intent === "billing-email") {
    const values = fields(form, "email");
    if (subject.kind !== "enterprise") return failed("top", "Only an enterprise has an invoice email.");
    const email = parseEmail(values.email);
    if (!email.ok) return failed("invoices", email.error, values);
    if (email.value === subject.billingEmail) return failed("invoices", "That is already where its invoices go.", values);
    if (!confirmed) {
      return {
        review: { intent, name: subject.name, before: subject.billingEmail, after: email.value, fields: { email: email.value } },
      } satisfies ActionData;
    }
    const result = await admin.enterpriseBilling(subject.accountId, email.value, staff.email);
    if (!result.ok) return failed("invoices", result.error.message, values);
    return back("billing-email");
  }

  if (intent === "invoice") {
    if (subject.kind !== "enterprise") return failed("top", "Only an enterprise is invoiced from sudo.");
    if (!confirmed) {
      return {
        review: { intent, name: subject.name, email: subject.billingEmail, workspaces: subject.workspaces.length, fields: {} },
      } satisfies ActionData;
    }
    const result = await admin.invoiceEnterprise(subject.accountId, staff.email);
    if (!result.ok) return failed("invoices", result.error.message);
    // Shown in this response; the invoice is also in the list from now on.
    return { invoice: result.value } satisfies ActionData;
  }

  return failed("top", "Unknown action.");
}
