import type { Collaborator } from "@g1t/contracts";

/**
 * The people given a role on the repository itself, as GitHub lists
 * collaborators: owners and what the base permission gives every member
 * are said once, and a team's members are on the team. The API's
 * `affiliation=direct`.
 */
export function givenHere<T extends Pick<Collaborator, "direct" | "source">>(people: readonly T[]): T[] {
  return people.filter((person) => person.direct != null && person.source !== "owner");
}
