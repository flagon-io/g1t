import { useCallback, useContext, useSyncExternalStore } from "react";
import { UNSAFE_DataRouterContext, useLocation, useNavigation } from "react-router";
import { sidebarLocation } from "./navigation-owner";

/** Keep the navigation chrome on the latest destination, even while React commits a route transition. */
export function useSidebarLocation() {
  const context = useContext(UNSAFE_DataRouterContext);
  const location = useLocation();
  const navigation = useNavigation();
  const router = context?.router;
  const subscribe = useCallback((notify: () => void) => router?.subscribe(notify) ?? (() => {}), [router]);
  const snapshot = useCallback(() => (router ? sidebarLocation(router.state) : location), [router, location]);
  const serverSnapshot = () => navigation.location ?? location;
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
