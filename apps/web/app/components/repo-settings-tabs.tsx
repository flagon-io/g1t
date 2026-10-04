import { Lock, Rocket, Settings, Webhook } from "lucide-react";

import { TabLink } from "./ui";

/** The parts of a repository's settings. */
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
      <TabLink to={`${base}/settings/webhooks`} icon={<Webhook size={15} />}>
        Webhooks
      </TabLink>
    </nav>
  );
}
