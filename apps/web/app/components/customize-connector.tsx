/**
 * A connector's pieces, shared by Customize → Connectors and a connector's
 * own page: its mark, the menu of what an owner does with it (sign in or
 * out, a key, listing its tools again, removing it), the dialog that takes
 * a key, and the control that says which agents it reaches. Every form
 * posts to the page it is on; lib/customize.server.ts answers them.
 */
import { EllipsisVertical, KeyRound, LogIn, LogOut, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useFetcher } from "react-router";

import type { WorkspaceConnector } from "@g1t/contracts";
import { connectorById } from "@g1t/contracts/connectors";

import { type ActionResult, Confirm } from "./agents/dialogs";
import { ConnectorMark } from "./connectors";
import { AvailableTo, ListingMark } from "./customize";
import { SubmitButton } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { type Reach, type ReachOption, type ReachTargets } from "../lib/customize";

/** A connector's mark: the directory entry's when it came from one, its own letters otherwise. */
export function WorkspaceConnectorMark({ connector, size = 40 }: { connector: Pick<WorkspaceConnector, "id" | "title" | "from">; size?: number }) {
  const entry = connector.from.kind === "directory" ? connectorById(connector.from.id) : null;
  if (entry) return <ConnectorMark view={{ id: entry.id, name: entry.name, provider: entry.provider ?? null }} size={size} />;
  return <ListingMark id={connector.id} name={connector.title} size={size} />;
}

/** Where a connector reaches, as the control reads it. */
export function connectorReach(connector: Pick<WorkspaceConnector, "grants">): Reach[] {
  return connector.grants.map((grant) => ({ id: grant.id, scope: grant.scope, target: grant.target, label: grant.label }));
}

/** Which agents a connector is available to, with the control that changes it for owners. */
export function ConnectorReach({ connector, targets, size }: { connector: Pick<WorkspaceConnector, "id" | "grants">; targets: ReachTargets | null; size?: "xs" | "sm" }) {
  const fetcher = useFetcher<ActionResult>({ key: `connector-reach-${connector.id}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const change = (option: ReachOption, checked: boolean) => {
    if (checked) fetcher.submit({ intent: "grant", connector: connector.id, where: option.value }, { method: "post" });
    else if (option.reach) fetcher.submit({ intent: "revoke", connector: connector.id, grant: option.reach.id }, { method: "post" });
  };
  return (
    <>
      <AvailableTo reach={connectorReach(connector)} targets={targets} busy={fetcher.state !== "idle"} onChange={change} size={size} />
      {error && <p className="text-xs text-danger">{error}</p>}
    </>
  );
}

/**
 * A key for a connector that takes one: the header's name (Authorization,
 * usually) and its value, which is sealed and never shown again. `caveat`
 * is what the directory knows about the key the server wants. With
 * `connect` (a directory entry's id) it connects that entry with the key
 * in one step, instead of changing a connector's.
 */
export function SetKeyDialog({
  connector,
  caveat,
  connect,
  trigger,
  open,
  onOpenChange,
}: {
  connector: Pick<WorkspaceConnector, "id" | "title" | "header_name">;
  caveat?: string | null;
  connect?: string;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const fetcher = useFetcher<ActionResult>({ key: `connector-key-${connector.id}` });
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const id = useId();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data, setOpen]);
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const fields = connect ? { intent: "connect", directory: connect } : { intent: "key", connector: connector.id };
  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{connect ? `Connect ${connector.title}` : `A key for ${connector.title}`}</DialogTitle>
          <DialogDescription>Sent with every call as a header. It is sealed when saved and never shown again; paste a new one to replace it.</DialogDescription>
        </DialogHeader>
        {caveat && <p className="text-sm text-fg-soft">{caveat}</p>}
        <fetcher.Form method="post" className="grid gap-5">
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <Field>
            <FieldLabel htmlFor={`${id}-header`}>Header</FieldLabel>
            <Input id={`${id}-header`} name="header_name" defaultValue={connector.header_name ?? "Authorization"} required autoComplete="off" spellCheck={false} className="font-mono" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-value`}>Value</FieldLabel>
            <Input id={`${id}-value`} name="value" type="password" placeholder="Bearer …" required autoComplete="off" spellCheck={false} className="font-mono" />
            <FieldDescription>The whole value, scheme included, such as Bearer and the token.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton variant="accent" fetcher={fetcher} match={fields} pending={connect ? "Connecting…" : "Saving and listing tools…"}>
              <KeyRound size={14} />
              {connect ? "Connect" : "Save key"}
            </SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What an owner does with a connector: sign it in (the browser leaves for
 * the server) or out, set a key, list its tools again, or remove it, which
 * is asked twice.
 */
export function ConnectorMenu({ connector, caveat }: { connector: WorkspaceConnector; caveat?: string | null }) {
  const fetcher = useFetcher<ActionResult>({ key: `connector-menu-${connector.id}` });
  const [key, setKey] = useState(false);
  const post = (intent: string) => fetcher.submit({ intent, connector: connector.id }, { method: "post" });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`What to do with ${connector.title}`} disabled={fetcher.state !== "idle"}>
            <EllipsisVertical size={15} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {connector.auth === "oauth" && (
            <DropdownMenuItem onSelect={() => post(connector.state === "needs_sign_in" ? "sign_in" : "sign_out")}>
              {connector.state === "needs_sign_in" ? <LogIn /> : <LogOut />}
              {connector.state === "needs_sign_in" ? "Sign in" : "Sign out"}
            </DropdownMenuItem>
          )}
          {connector.auth === "oauth" && connector.state !== "needs_sign_in" && (
            <DropdownMenuItem onSelect={() => post("sign_in")}>
              <LogIn />
              Sign in again
            </DropdownMenuItem>
          )}
          {connector.auth === "header" && (
            <DropdownMenuItem onSelect={() => setKey(true)}>
              <KeyRound />
              {connector.state === "needs_key" ? "Set the key" : "Replace the key"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => post("refresh")}>
            <RefreshCw />
            List tools again
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <Confirm
            title={`Remove ${connector.title}?`}
            confirm="Remove connector"
            fields={{ intent: "remove", connector: connector.id }}
            fetcherKey={`connector-remove-${connector.id}`}
            trigger={
              <DropdownMenuItem onSelect={(event) => event.preventDefault()} className="text-danger data-highlighted:text-danger [&_svg]:text-danger">
                <Trash2 />
                Remove
              </DropdownMenuItem>
            }
          >
            Its tools stop being offered to every agent it reaches, at once, and its sign-in or key is forgotten.
          </Confirm>
        </DropdownMenuContent>
      </DropdownMenu>
      {connector.auth === "header" && <SetKeyDialog connector={connector} caveat={caveat} open={key} onOpenChange={setKey} />}
      {error && <p className="text-xs text-danger">{error}</p>}
    </>
  );
}
