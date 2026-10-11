import { Bot } from "lucide-react-native";

import { ComingSoon } from "@/components/coming-soon";

/** Agents: the workspace's agents, their sessions, budgets and memory. */
export default function Agents() {
  return (
    <ComingSoon
      title="Agents"
      icon={Bot}
      body="Your workspace's agents, what they are doing and what they cost. Message any of them from Chat meanwhile."
      path={(workspace) => `/${workspace}/-/agents`}
    />
  );
}
