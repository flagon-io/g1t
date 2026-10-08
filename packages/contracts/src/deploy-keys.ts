// A repository's deploy keys: SSH keys that reach that one repository,
// read-only unless whoever added one allowed write access. Mirrors
// crates/contracts/src/deploy_keys.rs; identity answers in snake_case.

import type { Result } from "./result";
import type { User } from "./identity";

/** One deploy key, as identity and the API show it. */
export type DeployKey = {
  /** `dk_…`. */
  id: string;
  title: string;
  /** The public key, `<type> <base64>`, without its comment. */
  key: string;
  /** `SHA256:…`, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
  /** False when it may push. */
  read_only: boolean;
  /** RFC 3339. */
  created_at: string;
  /** Who added it; null once that account is gone. */
  created_by: string | null;
  /** RFC 3339, to within 5 minutes; null when it never signed in. */
  last_used_at: string | null;
};

/** The most deploy keys one repository may have. */
export const MAX_DEPLOY_KEYS = 100;

/** Identity's deploy key methods, by repository path. Admins of the repository only. */
export interface DeployKeysClient {
  listDeployKeys(viewer: User | null, owner: string, name: string): Promise<Result<DeployKey[]>>;
  /** `readOnly` is true unless said otherwise. */
  addDeployKey(
    actor: User,
    owner: string,
    name: string,
    key: { title: string; key: string; readOnly: boolean },
  ): Promise<Result<DeployKey>>;
  removeDeployKey(actor: User, owner: string, name: string, id: string): Promise<Result<boolean>>;
}
