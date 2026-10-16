import { useCallback, useContext } from "react";
import { UNSAFE_DataRouterContext, useLocation, useNavigate, type NavigateOptions, type To } from "react-router";
import { pageOwnsNavigation } from "./navigation-owner";

/** For automatic redirects and delayed work, never for an explicit link click. */
export function usePageNavigation() {
  const context = useContext(UNSAFE_DataRouterContext);
  const { key } = useLocation();
  const navigate = useNavigate();
  const owns = useCallback(() => context != null && pageOwnsNavigation(context.router.state, key), [context?.router, key]);
  const automaticNavigate = useCallback((to: To, options?: NavigateOptions) => {
    if (owns()) return navigate(to, options);
  }, [navigate, owns]);
  return { owns, navigate: automaticNavigate };
}
