import { GitBranch, Lock, Rocket, Settings, Webhook } from "lucide-react";

import { TabLink } from "./ui";

/**
 * A project's settings, and its repository's: what is about running it
 * first, then what is about the code.
 */
export function RepoSettingsTabs({ base }: { base: string }) {
  return (
    <nav className="mb-8 flex gap-x-6 border-b border-line">
      <TabLink to={`${base}/settings`} end icon={<Settings size={15} />}>
        General
      </TabLink>
      <TabLink to={`${base}/settings/deployments`} icon={<Rocket size={15} />}>
        Deployments
      </TabLink>
      <TabLink to={`${base}/settings/secrets`} icon={<Lock size={15} />}>
        Secrets and variables
      </TabLink>
      <TabLink to={`${base}/settings/repository`} icon={<GitBranch size={15} />}>
        Repository
      </TabLink>
      <TabLink to={`${base}/settings/webhooks`} icon={<Webhook size={15} />}>
        Webhooks
      </TabLink>
    </nav>
  );
}
