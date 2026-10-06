/**
 * The status page's feeds: every public incident update and maintenance
 * notice, newest first, as Atom (`/feed.xml`) and JSON Feed
 * (`/feed.json`). No Workers imports, so it is tested under Node.
 */
import type { StatusIncident, StatusMaintenance } from "@g1t/contracts";

import { INCIDENT_STATUS } from "./model.ts";

export type FeedItem = {
  /** Unique and stable: the page's address with the update's anchor. */
  id: string;
  url: string;
  title: string;
  text: string;
  at: string;
};

/** How many items a feed carries. */
export const FEED_SIZE = 50;

/** Feed items from incidents and maintenance, newest first. */
export function feedItems(incidents: StatusIncident[], maintenance: StatusMaintenance[], size = FEED_SIZE): FeedItem[] {
  const items: FeedItem[] = [];
  for (const incident of incidents) {
    for (const update of incident.updates) {
      items.push({
        id: `${incident.url}#update-${update.id}`,
        url: `${incident.url}#update-${update.id}`,
        title: `${INCIDENT_STATUS[update.status]}: ${incident.title}`,
        text: update.text,
        at: update.at,
      });
    }
  }
  for (const m of maintenance) {
    for (const update of m.updates) {
      items.push({ id: `${m.url}#update-${update.id}`, url: `${m.url}#update-${update.id}`, title: `Maintenance: ${m.title}`, text: update.text, at: update.at });
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, size);
}

function xml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export type FeedOptions = { origin: string; title: string; updated: string };

export function atom(items: FeedItem[], { origin, title, updated }: FeedOptions): string {
  const entries = items
    .map(
      (item) => `<entry>
<id>${xml(item.id)}</id>
<title>${xml(item.title)}</title>
<link rel="alternate" type="text/html" href="${xml(item.url)}"/>
<updated>${xml(item.at)}</updated>
<published>${xml(item.at)}</published>
<content type="text">${xml(item.text)}</content>
</entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<id>${xml(`${origin}/`)}</id>
<title>${xml(title)}</title>
<link rel="self" type="application/atom+xml" href="${xml(`${origin}/feed.xml`)}"/>
<link rel="alternate" type="text/html" href="${xml(`${origin}/`)}"/>
<updated>${xml(items[0]?.at ?? updated)}</updated>
<author><name>g1t</name></author>
${entries}
</feed>
`;
}

/** JSON Feed 1.1. */
export function jsonFeed(items: FeedItem[], { origin, title }: FeedOptions): object {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title,
    home_page_url: `${origin}/`,
    feed_url: `${origin}/feed.json`,
    language: "en",
    items: items.map((item) => ({ id: item.id, url: item.url, title: item.title, content_text: item.text, date_published: item.at })),
  };
}
