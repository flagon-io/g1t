import { Link } from "react-router";

import { cloneUrl, useAddresses } from "../lib/addresses";
import { AgentSetup } from "./agent-setup";
import { CopyLine } from "./ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

/** The ways to get a repository onto a machine or in front of an agent. */
export function CloneBox({ path }: { path: string }) {
  const addresses = useAddresses();
  return (
    <Tabs defaultValue="https">
      <TabsList>
        <TabsTrigger value="https">HTTPS</TabsTrigger>
        <TabsTrigger value="ssh">SSH</TabsTrigger>
        <TabsTrigger value="agent">Agent</TabsTrigger>
      </TabsList>
      <TabsContent value="https">
        <CopyLine text={cloneUrl(addresses, path)} />
        <p className="mt-2 text-xs text-muted">
          To push, use your username and an{" "}
          <Link to="/settings/tokens" className="text-fg underline underline-offset-4">
            access token
          </Link>{" "}
          as the password.
        </p>
      </TabsContent>
      <TabsContent value="ssh">
        <p className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">
          Git over SSH is waiting on inbound TCP on Cloudflare, which g1t has applied for. Use HTTPS for now: it
          clones, fetches and pushes the same. Keys you add under Settings → SSH keys will work as soon as SSH is on.
        </p>
      </TabsContent>
      <TabsContent value="agent">
        <AgentSetup />
        <p className="mt-2 text-xs text-muted">
          Then ask it to work on an issue in <span className="font-mono text-fg">{path}</span>.{" "}
          <Link to="https://docs.g1t.sh/guides/bring-your-own-agent/" className="text-fg underline underline-offset-4">
            More
          </Link>
        </p>
      </TabsContent>
    </Tabs>
  );
}
