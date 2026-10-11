import { Bell } from "lucide-react-native";

import { ComingSoon } from "@/components/coming-soon";

/** Notifications: reviews, approvals and alerts, your inbox. */
export default function NotificationsTab() {
  return (
    <ComingSoon
      title="Notifications"
      icon={Bell}
      body="Reviews, approvals and alerts. Messages to you already arrive as notifications on this phone."
      path={() => "/notifications"}
    />
  );
}
