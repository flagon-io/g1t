import { Check, Copy, Ellipsis, Mail, RotateCw, UserPlus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { type Invite, type InvitesOverview, MAX_INVITE_MESSAGE } from "@g1t/contracts";

import { CopyLine, EmptyState, ErrorText, SubmitButton, TimeAgo } from "./ui";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { CheckboxOption } from "./ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { Progress } from "./ui/progress";
import { SelectField } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Textarea } from "./ui/textarea";
import { type BringInto, G1T_INVITES, inviteActions, inviteLink, inviteState, invitationTone, remainingLine } from "../lib/invites";
import type { InviteActionData } from "../lib/invites.server";

/** After an invite is made or revoked, the account menu's count is asked for again (routes/settings-menu-json.ts). */
function useRefreshMenuCount(answer: InviteActionData | undefined) {
  const menu = useFetcher({ key: "account-menu" });
  const seen = useRef<InviteActionData | undefined>(undefined);
  useEffect(() => {
    if (!answer || seen.current === answer || !("done" in answer)) return;
    seen.current = answer;
    if (answer.done !== "resent") menu.load("/settings/menu.json");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer]);
}

/**
 * Inviting a friend, in a dialog: their address, a note for the email, and,
 * only when its box is ticked, a paid workspace the person owns to invite
 * them to as well. On success the dialog closes and the page shows the link.
 */
function InviteFriendDialog({
  bringInto,
  disabled,
  defaultOpen,
  onCreated,
}: {
  bringInto: BringInto[];
  disabled: string | null;
  defaultOpen: boolean;
  onCreated: (invite: Invite) => void;
}) {
  const [open, setOpen] = useState(defaultOpen && !disabled);
  const [alsoJoin, setAlsoJoin] = useState(false);
  const fetcher = useFetcher<InviteActionData>();
  const answer = fetcher.state === "idle" ? fetcher.data : undefined;
  useRefreshMenuCount(answer);
  const told = useRef<InviteActionData | undefined>(undefined);
  useEffect(() => {
    if (!answer || told.current === answer) return;
    told.current = answer;
    if ("done" in answer && answer.done === "created") {
      setOpen(false);
      setAlsoJoin(false);
      onCreated(answer.invite);
    }
  }, [answer, onCreated]);
  const error = answer && "error" in answer ? answer.error : null;
  const id = useId();
  const trigger = (
    <Button type="button" disabled={disabled != null}>
      <UserPlus size={15} />
      {G1T_INVITES.action}
    </Button>
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {disabled ? (
        <Hint label={disabled} disabled>
          {trigger}
        </Hint>
      ) : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent>
        {open && (
          <fetcher.Form method="post" className="grid gap-5">
            <input type="hidden" name="intent" value="create-invite" />
            <DialogHeader>
              <DialogTitle>{G1T_INVITES.action}</DialogTitle>
              <DialogDescription>{G1T_INVITES.dialog}</DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor={`${id}-email`}>Their email address</FieldLabel>
              <Input id={`${id}-email`} name="email" type="email" required maxLength={254} autoComplete="off" placeholder="friend@example.com" autoFocus />
              <FieldDescription>Only this address can use the invite.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-message`}>
                Message <span className="font-normal text-faint">(optional)</span>
              </FieldLabel>
              <Textarea id={`${id}-message`} name="message" maxLength={MAX_INVITE_MESSAGE} rows={3} placeholder="A line for the email: what you'd like to build together." />
              <FieldDescription>Quoted in the email, under your name.</FieldDescription>
            </Field>
            {bringInto.length > 0 && (
              <div className="grid gap-3 rounded-lg border border-line p-3">
                <CheckboxOption
                  name="also_join"
                  checked={alsoJoin}
                  onCheckedChange={(checked) => setAlsoJoin(checked === true)}
                  label={G1T_INVITES.alsoJoin}
                  description={G1T_INVITES.alsoJoinHint}
                />
                {alsoJoin && (
                  <div className="grid gap-3 pl-6 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor={`${id}-join`}>Workspace</FieldLabel>
                      <SelectField
                        id={`${id}-join`}
                        name="join"
                        required
                        defaultValue={bringInto.length === 1 ? bringInto[0]!.slug : undefined}
                        placeholder="Choose a workspace"
                        options={bringInto.map((workspace) => ({
                          value: workspace.slug,
                          label: workspace.name === workspace.slug ? workspace.slug : `${workspace.name} (${workspace.slug})`,
                        }))}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${id}-role`}>Role</FieldLabel>
                      <SelectField
                        id={`${id}-role`}
                        name="join_role"
                        defaultValue="member"
                        options={[
                          { value: "member", label: "Member" },
                          { value: "owner", label: "Owner" },
                        ]}
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}
            {error && <ErrorText>{error}</ErrorText>}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <SubmitButton fetcher={fetcher} match={{ intent: "create-invite" }} pending="Sending…">
                <Mail size={15} />
                Send invite
              </SubmitButton>
            </DialogFooter>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The ⋯ menu on one invite: copy its link, send it again, revoke it. */
function InviteMenu({ invite, origin, onDone }: { invite: Invite; origin: string; onDone: (answer: InviteActionData) => void }) {
  const fetcher = useFetcher<InviteActionData>();
  const [copied, setCopied] = useState(false);
  const can = inviteActions(invite);
  const link = invite.code ? inviteLink(invite.code, origin) : null;
  const answer = fetcher.state === "idle" ? fetcher.data : undefined;
  useRefreshMenuCount(answer);
  const told = useRef<InviteActionData | undefined>(undefined);
  useEffect(() => {
    if (!answer || told.current === answer) return;
    told.current = answer;
    onDone(answer);
  }, [answer, onDone]);
  if (!can.revoke && !can.copy) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" aria-label={`Manage the invite for ${invite.email ?? invite.hint}`} variant="ghost" size="inline" className="p-1.5 text-faint max-sm:p-2.5" disabled={fetcher.state !== "idle"}>
          <Ellipsis size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          disabled={!can.copy || !link}
          onSelect={(event) => {
            event.preventDefault();
            if (!link) return;
            void navigator.clipboard?.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy link"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!can.resend} onSelect={() => fetcher.submit({ intent: "resend-invite", id: invite.id }, { method: "post" })}>
          <RotateCw />
          Send again
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!can.revoke} className="text-danger" onSelect={() => fetcher.submit({ intent: "revoke-invite", id: invite.id }, { method: "post" })}>
          <X />
          Revoke
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Settings → Invites to g1t (`/settings/invites`): Invite a friend. How many
 * invites are left, the button that opens the dialog, and every invite sent,
 * with who joined. Anyone can sign up without one; nothing here says
 * otherwise.
 */
export function InvitesSection({
  overview,
  bringInto,
  origin = "https://g1t.sh",
  openOnLoad = false,
}: {
  /** Null until the person's own address is confirmed, or when identity did not answer. */
  overview: InvitesOverview | null;
  /** Paid workspaces the person owns, to also invite a friend to (lib/invites.server.ts). */
  bringInto: BringInto[];
  origin?: string;
  /** Opened from the account menu's Invite a friend: the dialog starts open. */
  openOnLoad?: boolean;
}) {
  const [created, setCreated] = useState<Invite | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  if (!overview) {
    return (
      <Alert tone="info">
        <AlertTitle>Confirm your email address first</AlertTitle>
        <AlertDescription>Once your address is confirmed you can invite friends to g1t from here.</AlertDescription>
      </Alert>
    );
  }
  const { allowance, invites } = overview;
  const joined = invites.filter((invite) => invite.status === "redeemed" || invite.status === "awaiting_answer").length;
  const out = allowance.remaining === 0;
  const done = (answer: InviteActionData) => {
    if (!answer) return;
    const who = "id" in answer ? invites.find((invite) => invite.id === answer.id)?.email : null;
    if ("error" in answer) setNotice({ tone: "error", text: answer.error });
    else if (answer.done === "revoked") setNotice({ tone: "ok", text: `Revoked the invite for ${who ?? "them"}. It is yours to use again.` });
    else if (answer.done === "resent") setNotice({ tone: "ok", text: `Sent the invite to ${who ?? "them"} again.` });
  };
  return (
    <section id="invites" className="grid gap-6">
      <Card className="flex flex-col gap-4 rounded-lg p-4 sm:flex-row sm:items-center">
        <div className="min-w-0 grow">
          <p className="text-sm font-medium tabular-nums">{remainingLine(allowance)}</p>
          {allowance.limit > 0 && (
            <Progress value={(allowance.used / allowance.limit) * 100} aria-label={`${allowance.used} of ${allowance.limit} invites used`} className="mt-2 max-w-sm" />
          )}
          <p className="mt-2 text-xs text-faint">
            {out ? G1T_INVITES.outNote : G1T_INVITES.comesBack}
            {joined > 0 && ` ${joined} ${joined === 1 ? "friend has" : "friends have"} joined.`}
          </p>
        </div>
        <InviteFriendDialog
          bringInto={bringInto}
          disabled={out ? G1T_INVITES.out : null}
          defaultOpen={openOnLoad}
          onCreated={(invite) => {
            setNotice(null);
            setCreated(invite);
          }}
        />
      </Card>

      {created && (
        <Alert tone="success" role="status">
          <AlertTitle>Invite sent to {created.email}</AlertTitle>
          <AlertDescription className="mt-2 grid gap-2">
            <span className="text-muted">They can also use this link. It works once, for that address only.</span>
            {created.code && <CopyLine text={inviteLink(created.code, origin)} breakAtSlashes />}
          </AlertDescription>
        </Alert>
      )}

      {invites.length === 0 ? (
        <EmptyState title="No invites yet">Invite a friend and they show here, with when they join.</EmptyState>
      ) : (
        <Card tone="plain" className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Friend</TableHead>
                <TableHead className="max-sm:hidden">Sent</TableHead>
                <TableHead className="max-sm:hidden">Status</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((invite) => {
                const state = inviteState(invite);
                return (
                  <TableRow key={invite.id}>
                    <TableCell className="max-w-64 align-middle text-sm">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <Mail size={13} aria-hidden="true" className="shrink-0 text-faint" />
                        <span className="truncate">{invite.email ?? "Anyone with the link"}</span>
                      </span>
                      {invite.workspace && <span className="block text-xs text-faint">Also invited to {invite.workspace}</span>}
                      {/* On a phone, the status and when it was sent fold under the address. */}
                      <span className="mt-1.5 flex flex-wrap items-center gap-2 sm:hidden">
                        <Badge tone={invitationTone(invite.status)} size="md" className="max-w-full truncate">
                          {state.label}
                        </Badge>
                        <span className="text-xs text-faint">
                          <TimeAgo at={invite.createdAt} />
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="align-middle text-sm whitespace-nowrap text-muted max-sm:hidden">
                      <TimeAgo at={invite.createdAt} />
                    </TableCell>
                    <TableCell className="align-middle max-sm:hidden">
                      <Badge tone={invitationTone(invite.status)} size="md" className="max-w-56 truncate">
                        {state.label}
                      </Badge>
                      {invite.status === "pending" && <span className="ml-2 text-xs whitespace-nowrap text-faint">until {invite.expiresAt.slice(0, 10)}</span>}
                    </TableCell>
                    <TableCell className="align-middle text-right">
                      <InviteMenu invite={invite} origin={origin} onDone={done} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      {notice && (notice.tone === "ok" ? <p className="-mt-3 text-sm text-muted" role="status">{notice.text}</p> : <ErrorText>{notice.text}</ErrorText>)}
    </section>
  );
}
