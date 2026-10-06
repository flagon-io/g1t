import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { ACCOUNT_SETTINGS, accountSettingsPage, settingsPathForHash } from "../../lib/account-settings";

/**
 * Your settings: each page under `/settings/<page>`, listed in the sidebar.
 * The heading is named from the address.
 *
 * The settings used to be one page with a section per `#anchor`. A server
 * never sees the anchor, so an old link (`/settings#emails`) arrives at the
 * first page with the anchor still on it, and is sent on to its own page
 * from here.
 */
export default function SettingsLayout() {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const to = settingsPathForHash(hash);
    if (to && to !== pathname) navigate(to, { replace: true });
  }, [hash, pathname, navigate]);
  const page = accountSettingsPage(pathname);
  const about = page ? ACCOUNT_SETTINGS[page] : null;
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
      {about && (
        <header className="mb-8 border-b border-line pb-5">
          <h1 className="text-lg font-semibold tracking-tight">{about.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">{about.about}</p>
        </header>
      )}
      <div className="max-w-2xl">
        <Outlet />
      </div>
    </main>
  );
}
