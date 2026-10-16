/** A page's automatic work cannot override a newer navigation or a later visit. */
export function pageOwnsNavigation(state: { location: { key: string }; navigation: { state: string } }, key: string): boolean {
  return state.location.key === key && state.navigation.state === "idle";
}

/** Compare navigation identities, not just paths: a repeat click is a new attempt. */
export function pendingNavigationOwns(state: { state: string; location?: { key: string } }, key: string | undefined): boolean {
  return key !== undefined && state.state === "loading" && state.location?.key === key;
}

export function sidebarLocation<T>(state: { location: T; navigation: { location?: T } }): T {
  return state.navigation.location ?? state.location;
}
