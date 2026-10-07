import { identity } from "../../lib/services.server";

import type { Route } from "./+types/profile";
import { page } from "../../lib/meta";
import { AvatarField } from "../../components/avatar-field";
import { readAvatarUpload } from "../../lib/avatar-upload";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { ProfileSection } from "../../components/profile-form";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Profile · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const profile = await identity.profile(user.username);
  return { user, profile };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  switch (form.get("intent")) {
    // Identity checks every field again, and the website most of all.
    case "profile": {
      const text = (name: string) => String(form.get(name) ?? "");
      const result = await identity.updateProfile(user, {
        name: text("name"),
        bio: text("bio"),
        location: text("location"),
        website: text("website"),
        pronouns: text("pronouns"),
      });
      return result.ok ? { profileSaved: true } : { profileError: result.error.message };
    }
    // The picture: identity checks the image's bytes again.
    case "avatar": {
      const upload = await readAvatarUpload(form);
      if ("error" in upload) return { avatarError: upload.error };
      const result = await identity.setUserAvatar(user, upload.image);
      return result.ok ? null : { avatarError: result.error.message };
    }
    case "remove-avatar": {
      const result = await identity.setUserAvatar(user, null);
      return result.ok ? null : { avatarError: result.error.message };
    }
  }
  return null;
}

export default function ProfileSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { user, profile } = loaderData;
  return (
    <div className="space-y-12">
      <section id="picture" className="scroll-mt-20">
        <h2 className="font-medium">Picture</h2>
        <div className="mt-4">
          <AvatarField
            name={user.username}
            image={user.avatar}
            error={actionData && "avatarError" in actionData ? actionData.avatarError : undefined}
            about="Shown beside your username in the sidebar and on mission control. Without one, g1t draws your first letter."
          />
        </div>
      </section>
      {/* Keyed on what was saved, so the fields show identity's copy once it answers. */}
      <ProfileSection
        key={JSON.stringify(profile)}
        username={user.username}
        profile={profile}
        error={actionData && "profileError" in actionData ? actionData.profileError : undefined}
        saved={Boolean(actionData && "profileSaved" in actionData)}
      />
    </div>
  );
}
