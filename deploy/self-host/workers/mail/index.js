// The Email Sending binding, for self-hosted g1t.
//
// The identity service sends mail through Cloudflare Email Sending:
// `env.EMAIL.send({ to, from, subject, text, html })`. Self-hosted, EMAIL is
// a service binding to this Worker, which offers the same method and:
//
// - always prints the message to the log, so a self-hoster with no mail
//   server can still confirm an address by following the link;
// - with MAIL_URL set, hands it to a Mailpit server's send API
//   (`POST <MAIL_URL>/api/v1/send`). Mailpit keeps it in its inbox, or
//   relays it to a real SMTP server when it is configured to.
//
// Links in messages name g1t.sh, where hosted g1t lives; they are rewritten
// to PUBLIC_URL so they come back to this installation.

import { WorkerEntrypoint } from "cloudflare:workers";

const HOSTED = /https:\/\/g1t\.sh/g;

function address(value) {
  const match = /^(.*)<([^>]+)>\s*$/.exec(value ?? "");
  return match ? { Name: match[1].trim(), Email: match[2].trim() } : { Email: String(value ?? "") };
}

export default class Mail extends WorkerEntrypoint {
  async send(message) {
    const site = (this.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
    const text = String(message?.text ?? "").replace(HOSTED, site);
    const html = String(message?.html ?? "").replace(HOSTED, site);
    const from = this.env.MAIL_FROM || message?.from;
    const to = Array.isArray(message?.to) ? message.to : [message?.to];

    console.log(`[mail] to ${to.join(", ")}: ${message?.subject}\n${text}`);

    if (this.env.MAIL_URL) {
      const response = await fetch(`${this.env.MAIL_URL.replace(/\/$/, "")}/api/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: address(from),
          To: to.map(address),
          Subject: message?.subject ?? "",
          Text: text,
          HTML: html,
        }),
      });
      if (!response.ok) {
        throw new Error(`mail server answered ${response.status}: ${await response.text()}`);
      }
    }
    return { messageId: crypto.randomUUID() };
  }

  async fetch() {
    return new Response("The Email Sending binding for self-hosted g1t.", { status: 404 });
  }
}
