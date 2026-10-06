import { redirect } from "react-router";

import type { Route } from "./+types/timezone";
import { Button, Field, PageHeader, Section, Select, When } from "~/components/ui";
import { text } from "~/lib/forms";
import { requireStaff, zoneContext } from "~/lib/staff";
import { ZONE_COOKIE, validZone, zoneAbbr } from "~/lib/time";

export const meta: Route.MetaFunction = () => [{ title: "Time zone · sudo" }, { name: "robots", content: "noindex, nofollow" }];

/** Where to go back to: a page of sudo's own, never another site. */
function backTo(raw: string | null): string {
  return raw && /^\/(?!\/)[^\s\\]*$/.test(raw) ? raw : "/";
}

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const { zone, chosen } = context.get(zoneContext);
  const placed = (request as { cf?: { timezone?: unknown } }).cf?.timezone;
  const zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return {
    zone,
    chosen,
    placed: validZone(placed) ? placed : null,
    zones: zones.includes("UTC") ? zones : ["UTC", ...zones],
    back: backTo(new URL(request.url).searchParams.get("back")),
    now: new Date().toISOString(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  requireStaff(context);
  const form = await request.formData();
  const zone = text(form, "zone");
  const back = backTo(text(form, "back"));
  const cookie =
    zone && validZone(zone)
      ? `${ZONE_COOKIE}=${encodeURIComponent(zone)}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`
      : `${ZONE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
  return redirect(back, { headers: { "set-cookie": cookie } });
}

export default function TimeZone({ loaderData }: Route.ComponentProps) {
  const { zone, chosen, placed, zones, back, now } = loaderData;
  const at = new Date(now);
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Time zone"
        description="Every time in sudo is shown in this zone, with its abbreviation. Hover a time to see it in UTC."
      />
      <form method="post" className="mt-6 space-y-6">
        <input type="hidden" name="back" value={back} />
        <Section title="Show times in">
          <div className="space-y-4">
            <Field
              label="Zone"
              hint={
                placed
                  ? `Where Cloudflare places you: ${placed} (${zoneAbbr(at, placed)}). Choose it to follow you when you travel.`
                  : "Cloudflare did not say where you are; without a choice, times are in UTC."
              }
            >
              <Select name="zone" defaultValue={chosen ? zone : ""}>
                <option value="">Where Cloudflare places me{placed ? ` (${placed})` : " (UTC)"}</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-sm text-muted">
              Now: <When at={now} time />
            </p>
            <Button type="submit">Save</Button>
          </div>
        </Section>
      </form>
    </main>
  );
}
