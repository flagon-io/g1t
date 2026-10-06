import { Check } from "lucide-react";
import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import { PROFILE_LIMITS, type Profile } from "@g1t/contracts";

import { Button } from "./ui";
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

/**
 * The Profile section of a person's settings: what everyone sees at
 * `/u/<username>`. Posts `intent=profile`; identity checks every field.
 */
export function ProfileSection({
  username,
  profile,
  error,
  saved,
}: {
  username: string;
  profile: Profile | null;
  error?: string;
  saved: boolean;
}) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting" && navigation.formData?.get("intent") === "profile";
  const [bio, setBio] = useState(profile?.bio ?? "");
  return (
    <section id="profile" className="scroll-mt-20">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Public profile</h2>
        <Link to={`/u/${username}`} className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
          View your profile
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted">
        Shown to everyone at <span className="font-mono text-fg">g1t.sh/u/{username}</span>. All of it is
        optional; your email address is never shown.
      </p>
      <Form method="post" className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="intent" value="profile" />
        <Field>
          <FieldLabel htmlFor="profile-name">Name</FieldLabel>
          <Input
            id="profile-name"
            name="name"
            defaultValue={profile?.name ?? ""}
            maxLength={PROFILE_LIMITS.name}
            placeholder={username}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="profile-pronouns">Pronouns</FieldLabel>
          <Input
            id="profile-pronouns"
            name="pronouns"
            defaultValue={profile?.pronouns ?? ""}
            maxLength={PROFILE_LIMITS.pronouns}
            placeholder="they/them"
          />
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="profile-bio">Bio</FieldLabel>
          <Textarea
            id="profile-bio"
            name="bio"
            rows={2}
            value={bio}
            onChange={(event) => setBio(event.currentTarget.value)}
            maxLength={PROFILE_LIMITS.bio}
            placeholder="What you work on, in a line or two."
          />
          <FieldDescription>
            {bio.length}/{PROFILE_LIMITS.bio} characters. Also what a link to your profile says.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="profile-location">Location</FieldLabel>
          <Input
            id="profile-location"
            name="location"
            defaultValue={profile?.location ?? ""}
            maxLength={PROFILE_LIMITS.location}
            placeholder="Portland, Oregon"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="profile-website">Website</FieldLabel>
          <Input
            id="profile-website"
            name="website"
            inputMode="url"
            defaultValue={profile?.website ?? ""}
            maxLength={PROFILE_LIMITS.website}
            placeholder="https://example.com"
          />
          <FieldDescription>An https:// address.</FieldDescription>
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save profile"}
          </Button>
          {saved && !busy && !error && (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted">
              <Check size={14} className="text-accent" />
              Saved
            </span>
          )}
          <FieldError>{error}</FieldError>
        </div>
      </Form>
    </section>
  );
}
