/**
 * Email from the status page: subscription confirmations, incident and
 * maintenance updates to subscribers, and the staff alert when a draft is
 * detected. Sending goes through a `Sender`, so the page works the same
 * with no email at all (an installation without it, or tests): the feeds
 * still carry every update. On g1t.sh the sender is Cloudflare Email
 * Sending, the `send_email` binding identity uses too. No Workers imports.
 */

export type Mail = { to: string; subject: string; text: string; html: string; headers?: Record<string, string> };

export interface Sender {
  send(mail: Mail): Promise<void>;
}

/** The `send_email` binding, as Cloudflare Email Sending gives it. */
export type EmailBinding = {
  send(message: { to: string; from: string; subject: string; text: string; html: string; headers?: Record<string, string> }): Promise<unknown>;
};

export const DEFAULT_FROM = "g1t status <noreply@g1t.sh>";

/** A sender over the binding, or null when there is none. */
export function bindingSender(binding: EmailBinding | undefined, from = DEFAULT_FROM): Sender | null {
  if (!binding || typeof binding.send !== "function") return null;
  return { send: async ({ to, subject, text, html, headers }) => void (await binding.send({ to, from, subject, text, html, ...(headers ? { headers } : {}) })) };
}

/** Collects mail instead of sending it: for tests and previews. */
export function memorySender(): Sender & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { sent, send: async (mail) => void sent.push(mail) };
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type Letter = {
  /** A line over the body, such as "Identified · Pushes failing". */
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footer: string[];
  /** Where the reader leaves, as a link in the footer. */
  unsubscribe?: string;
};

/** The plain text and HTML of a letter; everything is escaped. */
export function render(letter: Letter): { text: string; html: string } {
  const text: string[] = [letter.heading, ""];
  let html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#16150f">`;
  html += `<p style="margin:0 0 6px;font-size:13px;color:#6e6a5e">g1t status</p>`;
  html += `<h1 style="margin:0 0 16px;font-size:19px;line-height:1.35">${escape(letter.heading)}</h1>`;
  for (const p of letter.paragraphs) {
    text.push(p, "");
    html += `<p style="font-size:15px;line-height:1.6;white-space:pre-line">${escape(p)}</p>`;
  }
  if (letter.action) {
    text.push(`${letter.action.label}: ${letter.action.url}`, "");
    html += `<p style="margin:24px 0"><a href="${escape(letter.action.url)}" style="background:#16150f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px">${escape(letter.action.label)}</a></p>`;
  }
  for (const line of letter.footer) {
    text.push(line);
    html += `<p style="font-size:13px;line-height:1.6;color:#6e6a5e;margin:4px 0">${escape(line)}</p>`;
  }
  if (letter.unsubscribe) {
    text.push(`Unsubscribe: ${letter.unsubscribe}`);
    html += `<p style="font-size:13px;line-height:1.6;color:#6e6a5e;margin:4px 0"><a href="${escape(letter.unsubscribe)}" style="color:#6e6a5e">Unsubscribe</a></p>`;
  }
  html += "</div>";
  return { text: `${text.join("\n").trim()}\n`, html };
}

/** The headers that let mail apps offer one-click unsubscribing (RFC 8058). */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

export function confirmLetter(link: string, parts: string[] | null): Letter {
  return {
    heading: "Confirm your subscription to g1t status",
    paragraphs: [
      `Someone, hopefully you, asked to get an email when g1t posts an incident or planned maintenance${parts ? ` affecting ${parts.join(", ")}` : ""}. Confirm to start.`,
    ],
    action: { label: "Confirm subscription", url: link },
    footer: ["The link works for 24 hours. If you did not ask for this, ignore this email and nothing happens."],
  };
}

export function updateLetter(input: { heading: string; text: string; url: string; affects: string[]; unsubscribe: string }): Letter {
  return {
    heading: input.heading,
    paragraphs: [input.text, ...(input.affects.length ? [`Affects: ${input.affects.join(", ")}.`] : [])],
    action: { label: "See it on the status page", url: input.url },
    footer: ["You get these because you subscribed at status.g1t.sh."],
    unsubscribe: input.unsubscribe,
  };
}

/**
 * The staff alert for a new detected draft. `lines` say what each part
 * did, slow and not answering told apart (detect.ts `troubleSentence`).
 */
export function alertLetter(input: { title: string; lines: string[]; link: string; note?: string }): Letter {
  return {
    heading: input.title,
    paragraphs: [
      input.lines.join("\n"),
      ...(input.note ? [input.note] : []),
      "A draft incident is waiting in sudo. It is not on the status page until someone publishes it.",
    ],
    action: { label: "Open it in sudo", url: input.link },
    footer: ["Sent by status.g1t.sh to the staff alert address (STATUS_ALERT_EMAIL)."],
  };
}

/** The follow-up when a detected draft recovered and was dismissed on its own. */
export function recoveredLetter(input: { title: string; text: string; link: string }): Letter {
  return {
    heading: `Recovered: ${input.title.replace(/^Detected: /, "")} — dismissed automatically`,
    paragraphs: [input.text, "Open it in sudo to read its timeline, or to declare an incident anyway."],
    action: { label: "Open it in sudo", url: input.link },
    footer: ["Sent by status.g1t.sh to the staff alert address (STATUS_ALERT_EMAIL)."],
  };
}
