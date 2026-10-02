import { Link } from "react-router";

import { CopyLine } from "./ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

/** The ways to get a repository onto a machine or in front of an agent. */
export function CloneBox({ path }: { path: string }) {
  return (
    <Tabs defaultValue="https">
      <TabsList>
        <TabsTrigger value="https">HTTPS</TabsTrigger>
        <TabsTrigger value="ssh">SSH</TabsTrigger>
        <TabsTrigger value="agent">Agent</TabsTrigger>
      </TabsList>
      <TabsContent value="https">
        <CopyLine text={`https://g1t.sh/${path}.git`} />
        <p className="mt-2 text-xs text-muted">
          To push, use your username and an{" "}
          <Link to="/settings" className="text-fg underline underline-offset-4">
            access token
          </Link>{" "}
          as the password.
        </p>
      </TabsContent>
      <TabsContent value="ssh">
        <p className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">
          Git over SSH is not available yet. Use HTTPS for now.
        </p>
      </TabsContent>
      <TabsContent value="agent">
        <CopyLine
          prompt
          text='claude mcp add --transport http g1t https://mcp.g1t.sh --header "Authorization: Bearer $G1T_TOKEN"'
        />
        <p className="mt-2 text-xs text-muted">
          Connects Claude Code to g1t. Then ask it to work on an intent in{" "}
          <span className="font-mono text-fg">{path}</span>.{" "}
          <Link to="https://docs.g1t.sh/guides/bring-your-own-agent/" className="text-fg underline underline-offset-4">
            More
          </Link>
        </p>
      </TabsContent>
    </Tabs>
  );
}
