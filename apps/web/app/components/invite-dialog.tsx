import { AtSign, Mail, UserPlus } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { MAX_INVITE_MESSAGE, type PersonMatch } from "@g1t/contracts";

import { ErrorText, SubmitButton } from "./ui";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { SelectField } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { UserCard } from "./user-card";
import { type InviteResult, workspaceInviteCopy } from "../lib/invites";
import { PEOPLE_SEARCH_PATH, looksLikeEmail, peopleQuery } from "../lib/people-search";

/**
 * Inviting someone to the workspace, in a dialog opened from Members and
 * from Invitations: who (a username, a name to search by, or an email
 * address), the role they join with, and a note for the email. Posted to
 * `action` as `action=add` (lib/member-invitations.server.ts); on success the
 * dialog closes and `onInvited` is told who, so the page can say so.
 */
export function InviteDialog({
  name,
  action,
  onInvited,
  trigger,
}: {
  /** The workspace's display name. */
  name: string;
  /** The page's address, whose action handles `add`. */
  action: string;
  onInvited?: (who: string) => void;
  /** The button that opens it; the Invite button when absent. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<InviteResult>();
  const copy = workspaceInviteCopy(name);
  const result = fetcher.state === "idle" ? fetcher.data : undefined;
  // Sent: the dialog closes and the page says so. Each opening starts clean.
  const told = useRef<InviteResult | null>(null);
  useEffect(() => {
    if (!result || told.current === result) return;
    told.current = result;
    if ("invited" in result) {
      setOpen(false);
      onInvited?.(result.invited);
    }
  }, [result, onInvited]);
  const error = result && "error" in result ? result : null;
  const messageId = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button">
            <UserPlus size={15} />
            Invite
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        {open && (
          <fetcher.Form method="post" action={action} className="grid gap-5">
            <input type="hidden" name="action" value="add" />
            <DialogHeader>
              <DialogTitle>{copy.heading}</DialogTitle>
              <DialogDescription>{copy.hint}</DialogDescription>
            </DialogHeader>
            <WhoField />
            <Field>
              <FieldLabel htmlFor={`${messageId}-role`}>Role</FieldLabel>
              <SelectField
                id={`${messageId}-role`}
                name="role"
                defaultValue="member"
                options={[
                  { value: "member", label: "Member", description: `Works in ${name} with the base permission on its repositories.` },
                  { value: "owner", label: "Owner", description: "Everything a member can, and manages the workspace itself." },
                ]}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={messageId}>
                Message <span className="font-normal text-faint">(optional)</span>
              </FieldLabel>
              <Textarea
                id={messageId}
                name="message"
                maxLength={MAX_INVITE_MESSAGE}
                rows={3}
                placeholder={`A line for the email: why you'd like them in ${name}.`}
              />
              <FieldDescription>Quoted in the invitation email, under your name.</FieldDescription>
            </Field>
            {error && <ErrorText>{error.error}</ErrorText>}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <SubmitButton fetcher={fetcher} match={{ action: "add" }} pending="Inviting…">
                <UserPlus size={15} />
                Invite
              </SubmitButton>
            </DialogFooter>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who to invite: a search box that offers people on g1t by username and
 * name as you type, each with their picture and card, and takes an email
 * address as written. Only what a profile shows is offered, never anyone's
 * address. Posts what is in the box as `member`.
 */
function WhoField() {
  const [text, setText] = useState("");
  const [people, setPeople] = useState<PersonMatch[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const asked = useRef(0);
  const id = useId();

  useEffect(() => {
    const query = chosen === text.trim().replace(/^@+/, "") ? null : peopleQuery(text);
    if (!query) {
      setPeople([]);
      return;
    }
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      fetch(`${PEOPLE_SEARCH_PATH}?q=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } })
        .then((response) => (response.ok ? (response.json() as Promise<{ people?: PersonMatch[] }>) : { people: [] }))
        .then((found) => {
          if (ask === asked.current) setPeople(found.people ?? []);
        })
        .catch(() => {
          if (ask === asked.current) setPeople([]);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [text, chosen]);

  const email = looksLikeEmail(text);
  const listed = people.length > 0 && !email;
  return (
    <Field>
      <FieldLabel htmlFor={id}>Who</FieldLabel>
      <Command
        shouldFilter={false}
        className="rounded-md border border-line bg-bg has-[input:focus-visible]:border-accent-dim has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-accent/25"
      >
        <CommandInput
          id={id}
          name="member"
          required
          maxLength={254}
          autoComplete="off"
          placeholder="username, name or name@example.com"
          value={text}
          onValueChange={(value) => {
            setText(value);
            setChosen(null);
          }}
          className="h-9"
        />
        {listed && (
          <CommandList aria-label="People on g1t" className="max-h-56 border-t border-line">
            {people.map((person) => (
              <CommandItem
                key={person.username}
                value={person.username}
                onSelect={() => {
                  setText(person.username);
                  setChosen(person.username);
                  setPeople([]);
                }}
              >
                <Avatar name={person.username} image={person.avatar} size={20} />
                <UserCard username={person.username}>
                  <span className="font-mono">{person.username}</span>
                </UserCard>
                {person.name && <span className="min-w-0 truncate text-muted">{person.name}</span>}
              </CommandItem>
            ))}
          </CommandList>
        )}
      </Command>
      <FieldDescription className="flex items-center gap-1.5">
        {email ? (
          <>
            <Mail size={12} className="shrink-0" />
            Invited by email: {text.trim()} gets the invitation, and signs up first if it has no account.
          </>
        ) : chosen ? (
          <>
            <AtSign size={12} className="shrink-0" />@{chosen} gets the invitation in their notifications and by email.
          </>
        ) : (
          "People on g1t are offered as you type; an email address is sent as written."
        )}
      </FieldDescription>
    </Field>
  );
}
