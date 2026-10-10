/**
 * The AI Gateway page's log: a workspace's recent model requests, one row
 * each, newest first, and the shape it has while it loads.
 */

import type { ReactNode } from "react";

import type { GatewayRequest } from "@g1t/contracts";

import { cacheKinds, duration, formatLabel, servedBy, shortCount, statusTone, tokenKinds } from "../lib/gateway";
import { money } from "../lib/usage";
import { TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { Loading, SkeletonLine } from "./ui/skeleton";

const HEAD = "px-3 py-2 text-xs font-medium text-muted whitespace-nowrap";
const NUM = "px-3 py-2 text-right tabular-nums whitespace-nowrap";

/** The columns, so the skeleton has as many as the table. */
const COLUMNS = ["Time", "Model", "Served by", "Input", "Output", "Cache", "Cost", "Status", "Token"] as const;

/** One request's row. */
function Row({ request }: { request: GatewayRequest }) {
  const status = statusTone(request.status);
  const served = servedBy(request);
  return (
    <tr className="text-sm">
      <td className="px-3 py-2 whitespace-nowrap text-muted">
        <Hint label={`${new Date(request.createdAt).toISOString().replace("T", " ").slice(0, 19)} UTC, ${duration(request.durationMs)}${request.streamed ? ", streamed" : ""}`}>
          <span tabIndex={0}>
            <TimeAgo at={request.createdAt} />
          </span>
        </Hint>
      </td>
      <td className="max-w-[15rem] px-3 py-2 whitespace-nowrap">
        <Hint label={request.model}>
          <span tabIndex={0} className="block truncate font-mono text-xs">
            {request.model}
          </span>
        </Hint>
        <span className="block text-[0.6875rem] text-faint">{formatLabel(request.format)} format</span>
      </td>
      <td className="max-w-[12rem] truncate px-3 py-2 whitespace-nowrap">
        <Hint label={served.hint}>
          <span tabIndex={0} className={request.ownKey ? "" : "text-muted"}>
            {served.label}
          </span>
        </Hint>
      </td>
      <td className={NUM}>
        <Hint label={tokenKinds(request)}>
          <span tabIndex={0}>{shortCount(request.input)}</span>
        </Hint>
      </td>
      <td className={NUM}>{shortCount(request.output)}</td>
      <td className={NUM}>
        <Hint label={cacheKinds(request)}>
          <span tabIndex={0}>
            {shortCount(request.cacheRead)}
            <span className="text-faint"> / </span>
            {shortCount(request.cacheWrite)}
          </span>
        </Hint>
      </td>
      <td className={NUM}>
        {request.ownKey ? (
          <Hint label="Sent to the workspace's own provider: counted, not charged.">
            <span tabIndex={0}>
              <Badge>Not charged</Badge>
            </span>
          </Hint>
        ) : (
          money(request.chargedMicros)
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <Hint label={request.error}>
          <span tabIndex={request.error ? 0 : undefined}>
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
        </Hint>
      </td>
      <td className="max-w-[12rem] truncate px-3 py-2 text-muted">
        <Hint label={request.tokenId}>
          <span tabIndex={0}>{request.tokenName ?? request.tokenId}</span>
        </Hint>
      </td>
    </tr>
  );
}

/** Whether a column holds a number, read right-aligned. */
const numeric = (index: number) => index >= 3 && index <= 6;

/** The table's frame: its heading row, around its body. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-line">
          <tr>
            {COLUMNS.map((column, index) => (
              <th key={column} className={`${HEAD} ${numeric(index) ? "text-right" : "text-left"}`} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        {children}
      </table>
    </Card>
  );
}

/** The log, one row a request. */
export function GatewayTable({ requests }: { requests: GatewayRequest[] }) {
  return (
    <Frame>
      <tbody className="divide-y divide-line">
        {requests.map((request) => (
          <Row key={request.id} request={request} />
        ))}
      </tbody>
    </Frame>
  );
}

/** The log while it loads: the table's own frame, with rows to come. */
export function GatewaySkeleton() {
  return (
    <Loading label="Loading AI Gateway requests…">
      <Frame>
        <tbody className="divide-y divide-line" aria-hidden="true">
          {Array.from({ length: 8 }, (_, row) => (
            <tr key={row} className="text-sm">
              {COLUMNS.map((column, index) => (
                <td key={column} className={numeric(index) ? NUM : "px-3 py-2"}>
                  <SkeletonLine className={numeric(index) ? "ml-auto w-10" : index === 1 ? "w-36" : index === 2 ? "w-24" : "w-16"} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Frame>
    </Loading>
  );
}
