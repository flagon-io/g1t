import { env } from "cloudflare:workers";

import { ssoClient } from "@g1t/contracts";

import { instrumented } from "./perf.server";

/** A workspace's single sign-on, kept by the identity service. */
export const sso = ssoClient(instrumented("identity", env.IDENTITY));
