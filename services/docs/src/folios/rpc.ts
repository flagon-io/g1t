/**
 * The folio RPC: every method in FOLIO_RPC_METHODS (packages/contracts
 * folios.ts) and the Folios method that answers it. Typed against the
 * contract's list, so a method added there and not here fails the
 * typecheck. src/index.ts asks this table first, then Docs' own switch.
 */
import type { FolioRpcMethod } from "@g1t/contracts";

import type { Folios } from "./service.ts";

// Bodies come from other services as JSON; each method checks its own.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (service: Folios, args: any) => Promise<unknown>;

export const FOLIO_RPC: Record<FolioRpcMethod, Handler> = {
  folio_list: (s, a) => s.list(a),
  folio_sidebar: (s, a) => s.sidebar(a),
  folio: (s, a) => s.folio(a),
  create_folio: (s, a) => s.create(a),
  update_folio: (s, a) => s.update(a),
  move_folio: (s, a) => s.move(a),
  duplicate_folio: (s, a) => s.duplicate(a),
  trash_folio: (s, a) => s.trash(a),
  restore_folio: (s, a) => s.restore(a),
  delete_folio: (s, a) => s.delete(a),
  folio_trash: (s, a) => s.trashed(a),
  favorite_folio: (s, a) => s.favorite(a),
  folio_content: (s, a) => s.content(a),
  edit_folio: (s, a) => s.edit(a),
  folio_access: (s, a) => s.access(a),
  set_folio_grant: (s, a) => s.setGrant(a),
  set_folio_general_access: (s, a) => s.setGeneralAccess(a),
  request_folio_access: (s, a) => s.requestAccess(a),
  join_space: (s, a) => s.joinSpace(a),
  leave_space: (s, a) => s.leaveSpace(a),
  search_folios: (s, a) => s.search(a),
  folio_versions: (s, a) => s.versions(a),
  folio_version: (s, a) => s.version(a),
  restore_folio_version: (s, a) => s.restoreVersion(a),
  folio_templates: (s, a) => s.templates(a),
  save_folio_template: (s, a) => s.saveTemplate(a),
  delete_folio_template: (s, a) => s.deleteTemplate(a),
  export_folio: (s, a) => s.export(a),
  folio_suggestions: (s, a) => s.suggestions(a),
  decide_folio_suggestion: (s, a) => s.decideSuggestion(a),
  folio_proposals: (s, a) => s.proposals(a),
  decide_folio_proposal: (s, a) => s.decideProposal(a),
  folio_thread: (s, a) => s.thread(a),
  folio_threads: (s, a) => s.threads(a),
  query_tile: (s, a) => s.queryTile(a),
  query_dataset: (s, a) => s.queryDataset(a),
  query_dataset_for_agent: (s, a) => s.queryDatasetForAgent(a),
  folios_for_agent: (s, a) => s.foliosForAgent(a),
  read_folio_for_agent: (s, a) => s.readForAgent(a),
  create_folio_as_agent: (s, a) => s.createAsAgent(a),
  edit_folio_as_agent: (s, a) => s.editAsAgent(a),
  share_folio_as_agent: (s, a) => s.shareAsAgent(a),
  recall_folios_for_agent: (s, a) => s.recallForAgent(a),
  stale_folios_for_agent: (s, a) => s.staleForAgent(a),
  mark_folio_current: (s, a) => s.markCurrent(a),
  reindex_folios: (s, a) => s.reindex(a),
};

export function folioHandler(method: string): Handler | null {
  return Object.prototype.hasOwnProperty.call(FOLIO_RPC, method) ? FOLIO_RPC[method as FolioRpcMethod] : null;
}
