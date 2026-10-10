import { Hash } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, data, useNavigation } from "react-router";

import type { ChannelManagers, ChatAllowed, ChatSettings, EmojiUpload } from "@g1t/contracts";

import type { Route } from "./+types/chat-settings";
import { ErrorText } from "../../components/ui";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { CheckboxOption } from "../../components/ui/checkbox";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { page } from "../../lib/meta";
import { chat } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Chat settings · ${params.owner} · g1t` });
}

/**
 * Settings, Chat: what members may do in the workspace's chat. Every
 * member can read it, so nobody has to guess why a button is off; only
 * owners change it. The chat service enforces each setting.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const view = await chat.chatSettings(slug, viewer).catch(() => null);
  if (!view?.ok) return { slug, view: null, error: view ? view.error.message : "Chat didn't answer. Try again in a moment." };
  return { slug, view: view.value, error: null };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const form = await request.formData();
  const who = (key: string): ChatAllowed => (form.get(key) === "owners" ? "owners" : "members");
  const change: Partial<ChatSettings> = {
    public_channels: who("public_channels"),
    private_channels: who("private_channels"),
    manage_channels: (form.get("manage_channels") === "owners" ? "owners" : "channel_owners") as ChannelManagers,
    emoji_upload: (form.get("emoji_upload") === "admins" ? "admins" : "members") as EmojiUpload,
    default_channels: form.getAll("default_channels").map(String),
  };
  try {
    const saved = await chat.setChatSettings(slug, viewer, change);
    return saved.ok ? { ok: true as const, settings: saved.value } : { ok: false as const, error: saved.error.message };
  } catch (error) {
    console.error("chat settings: the chat service did not answer", error);
    return { ok: false as const, error: "Chat didn't answer. Try again in a moment." };
  }
}

const SECTION = "border-t border-line pt-8 first:border-t-0 first:pt-0";

export default function ChatSettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, view } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formMethod === "POST";
  const [settings, setSettings] = useState<ChatSettings | null>(view?.settings ?? null);
  // What the service saved, once it answers.
  useEffect(() => {
    if (actionData?.ok) setSettings(actionData.settings);
  }, [actionData]);
  if (!view || !settings) {
    return (
      <div className="max-w-2xl">
        <Header />
        <ErrorText>{loaderData.error}</ErrorText>
      </div>
    );
  }
  const owner = view.can.manage_settings;
  const saved = actionData?.ok ? actionData.settings : view.settings;
  const changed = JSON.stringify(settings) !== JSON.stringify(saved);
  const set = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => setSettings((now) => (now ? { ...now, [key]: value } : now));
  const defaults = new Set(settings.default_channels);
  return (
    <div className="max-w-2xl">
      <Header />
      {!owner && (
        <Card asChild radius="lg" className="mb-8 px-4 py-3 text-sm text-muted">
          <p>
            Only workspace owners can change these. They are shown so you know what members can do here.
          </p>
        </Card>
      )}
      <Form method="post" className="space-y-8">
        <fieldset disabled={!owner} className="space-y-8">
          <section className={SECTION}>
            <h2 className="font-medium">Creating channels</h2>
            <p className="mt-1.5 text-xs text-faint">Who can create channels. Whoever creates one becomes its first owner.</p>
            <div className="mt-5 grid gap-6 sm:grid-cols-2">
              <Choice
                name="public_channels"
                title="Public channels"
                value={settings.public_channels}
                onChange={(value) => set("public_channels", value as ChatAllowed)}
                options={[
                  { value: "members", label: "Any member", description: "The default." },
                  { value: "owners", label: "Owners only", description: "Members join and read public channels, but ask an owner for a new one." },
                ]}
                disabled={!owner}
              />
              <Choice
                name="private_channels"
                title="Private channels"
                value={settings.private_channels}
                onChange={(value) => set("private_channels", value as ChatAllowed)}
                options={[
                  { value: "members", label: "Any member", description: "The default." },
                  { value: "owners", label: "Owners only", description: "Only owners can make a channel that is kept to the people invited." },
                ]}
                disabled={!owner}
              />
            </div>
          </section>

          <section className={SECTION}>
            <h2 className="font-medium">Renaming and archiving channels</h2>
            <p className="mt-1.5 text-xs text-faint">
              Who can rename a channel, archive it, and bring it back. Any member of a channel can change its topic. #general is never renamed or
              archived.
            </p>
            <div className="mt-5">
              <Choice
                name="manage_channels"
                title="Who can rename and archive"
                hideTitle
                value={settings.manage_channels}
                onChange={(value) => set("manage_channels", value as ChannelManagers)}
                options={[
                  { value: "channel_owners", label: "Channel owners and workspace owners", description: "Whoever created a channel looks after it. The default." },
                  { value: "owners", label: "Workspace owners only" },
                ]}
                disabled={!owner}
              />
            </div>
          </section>

          <section className={SECTION}>
            <h2 className="font-medium">Custom emoji</h2>
            <p className="mt-1.5 text-xs text-faint">
              Who can add the workspace&apos;s own emoji and aliases. Whoever added one, and owners, can remove it.{" "}
              <Link to={`/${slug}/-/emoji`} className="text-muted underline decoration-line-strong underline-offset-2 hover:text-fg">
                Manage emoji
              </Link>
            </p>
            <div className="mt-5">
              <Choice
                name="emoji_upload"
                title="Who can add emoji"
                hideTitle
                value={settings.emoji_upload}
                onChange={(value) => set("emoji_upload", value as EmojiUpload)}
                options={[
                  { value: "members", label: "Any member", description: "The default." },
                  { value: "admins", label: "Owners only", description: "Members use the workspace's emoji; only owners add them." },
                ]}
                disabled={!owner}
              />
            </div>
          </section>

          <section className={SECTION}>
            <h2 className="font-medium">Default channels</h2>
            <p className="mt-1.5 text-xs text-faint">
              The public channels someone new is put in the first time they open Chat. They can leave any of them. People already here are not
              moved.
            </p>
            {view.channels.length === 0 ? (
              <p className="mt-5 text-sm text-muted">No public channels yet.</p>
            ) : (
              <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
                {view.channels.map((channel) => (
                  <li key={channel.id}>
                    {defaults.has(channel.id) && <input type="hidden" name="default_channels" value={channel.id} />}
                    <CheckboxOption
                      checked={defaults.has(channel.id)}
                      disabled={!owner}
                      onCheckedChange={(on) =>
                        set("default_channels", on === true ? [...settings.default_channels, channel.id] : settings.default_channels.filter((id) => id !== channel.id))
                      }
                      label={
                        <span className="inline-flex items-center gap-1">
                          <Hash size={13} className="text-faint" />
                          {channel.name}
                        </span>
                      }
                      description={channel.topic ?? undefined}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </fieldset>

        {owner && (
          <div className="flex items-center gap-3 border-t border-line pt-6">
            <Button type="submit" variant="accent" disabled={saving || !changed}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {actionData && !actionData.ok && <ErrorText>{actionData.error}</ErrorText>}
            {actionData?.ok && !changed && (
              <p role="status" className="text-xs text-muted">
                Saved.
              </p>
            )}
          </div>
        )}
      </Form>
    </div>
  );
}

function Header() {
  return (
    <header className="mb-8 border-b border-line pb-6">
      <h1 className="text-2xl font-semibold tracking-tight">Chat</h1>
      <p className="mt-1.5 text-sm text-muted">What members can do in the workspace&apos;s chat: channels, emoji, and where someone new starts.</p>
    </header>
  );
}

/** One setting's choices, posted as `name`. */
function Choice({
  name,
  title,
  hideTitle,
  value,
  onChange,
  options,
  disabled,
}: {
  name: string;
  title: string;
  hideTitle?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; description?: string }[];
  disabled?: boolean;
}) {
  return (
    <div>
      {!hideTitle && <h3 className="mb-2.5 text-sm font-medium text-fg-soft">{title}</h3>}
      <RadioGroup name={name} value={value} onValueChange={onChange} aria-label={title} disabled={disabled}>
        {options.map((option) => (
          <RadioOption key={option.value} value={option.value} label={option.label} description={option.description} disabled={disabled} />
        ))}
      </RadioGroup>
    </div>
  );
}
