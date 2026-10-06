import { redirect } from "react-router";

import { FIRST_SETTINGS_PAGE } from "../../lib/account-settings";

/**
 * `/settings` is the first of its pages. A browser keeps the `#anchor` of
 * an old link across this redirect, and the settings layout sends it on to
 * the page that anchor now has.
 */
export function loader() {
  throw redirect(FIRST_SETTINGS_PAGE);
}

export default function SettingsIndex() {
  return null;
}
