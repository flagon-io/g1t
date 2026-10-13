import type { Pull } from "@g1t/contracts";

import type { Drift } from "../lib/branches";
import type { CommitPerson } from "../lib/commit-people";

/** A branch other than the default as Branches lists it: its head, how far it has moved, its pull request and preview. */
export type ActiveBranch = {
  name: string;
  /** The commit it points to. */
  head: string;
  commit: { hash: string; message: string; author: CommitPerson; coAuthors: CommitPerson[]; at: string } | null;
  /** Null when the two histories were not read far enough to meet. */
  drift: Drift | null;
  /** The open pull request from it, else the newest merged or closed one. */
  pull: { number: number; title: string; checkStatus: Pull["checkStatus"]; draft: boolean; status: Pull["status"] } | null;
  preview: string | null;
};
