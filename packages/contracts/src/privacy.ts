import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";

export type ErasureStatus = { id: string; requested_at: string; due_at: string; status: "received" | "reviewing" | "completed" | "refused" };
export type ErasureRequest = ErasureStatus & {
  user_id: string;
  username: string;
  scope: string;
  evidence: string;
  updated_at: string;
  updated_by: string | null;
  closed_at: string | null;
  reviews: ErasureReview[];
};
/** One entry in a case's trail: intake notes, a review, a refusal or the completion evidence. Staff only. */
export type ErasureReview = { at: string; staff: string; status: string; evidence: string };
export type PurgeJob = { subject_id: string; kind: string; target: string; attempts: number; retry_at: string; last_error: string | null; created_at: string };

export function privacyClient(service: ServiceBinding) {
  async function rpc<T>(method: string, args: object = {}): Promise<T> {
    const response = await service.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error("Privacy service unavailable");
    return response.json() as Promise<T>;
  }
  return {
    request: (user: User) => rpc<Result<ErasureStatus>>("request_erasure", { user }),
    mine: (user: User) => rpc<ErasureStatus | null>("my_erasure", { user }),
    intake: (username: string, received_at: string, staff: string, evidence: string) =>
      rpc<Result<boolean>>("admin_intake_erasure", { username, received_at, staff, evidence }),
    requests: () => rpc<ErasureRequest[]>("admin_erasure_requests"),
    pending: () => rpc<PurgeJob[]>("admin_pending_purges"),
    review: (id: string, staff: string, status: string, evidence: string) => rpc<Result<boolean>>("admin_review_erasure", { id, staff, status, evidence }),
  };
}
