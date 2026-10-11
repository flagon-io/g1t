import { House } from "lucide-react-native";

import { ComingSoon } from "@/components/coming-soon";

/** Home: where you're needed now, and what happened while you were away. */
export default function Home() {
  return (
    <ComingSoon
      title="Home"
      icon={House}
      body="Where you're needed now and what happened while you were away. Chat already has what is waiting on you."
      path={(workspace) => `/${workspace}/-/home`}
    />
  );
}
