import { Outlet } from "react-router";

import type { Route } from "./+types/page-boundary";
import { RouteError } from "../components/route-error";

/**
 * Around the pages of a repository, a workspace and your settings
 * (routes.ts): a page that fails shows its error where it would have been,
 * inside its frame, so the header, tabs and sidebar its layout drew stay
 * and the rest of g1t is a click away. Without it the error would replace
 * the layout too, which a layout's own boundary does.
 */
export default function PageBoundary() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError error={error} contained />;
}
