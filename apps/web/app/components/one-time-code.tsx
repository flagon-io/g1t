/**
 * Six-digit codes, as six boxes in two threes: the sign-in's second step,
 * two-factor settings and email confirmation. One real input underneath
 * (components/ui/input-otp.tsx) carries `autocomplete="one-time-code"`
 * and the field's stable id, so password managers and phones' code
 * suggestions fill it, and the form posts `code` as before.
 *
 * Where a recovery code is also taken (`k7m2q-9xw4d`), it gets the plain
 * text field instead: a link switches between them, and a recovery code
 * pasted into the boxes switches by itself, the code carried across, so
 * one is never cut to six digits.
 *
 * A form with `submit` is sent once, as soon as the sixth digit is in. A
 * password manager that fills the code often sends the form itself as
 * well; identity takes each authenticator code once, so a second sending
 * of the same code would be refused and say the code is wrong. While one
 * sending is on its way, any other is dropped.
 */
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

import { Field, Input } from "./ui";
import { Button } from "./ui/button";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "./ui/input-otp";
import { cn } from "../lib/cn";
import { codeDigits, looksLikeRecoveryCode, otpInputProps } from "../lib/otp";

/**
 * The six boxes. `submit` sends the form once the sixth digit is in.
 * `invalid` (the code was refused) marks them until something new is
 * typed. `onRecoveryCode`, when given, takes a recovery code pasted in.
 */
export function CodeSlots({
  id,
  name = "code",
  autoFocus,
  submit = false,
  invalid = false,
  centered = false,
  describedBy,
  onRecoveryCode,
}: {
  id: string;
  name?: string;
  autoFocus?: boolean;
  submit?: boolean;
  invalid?: boolean;
  centered?: boolean;
  describedBy?: string;
  onRecoveryCode?: (code: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  // Typed since the code was refused: the boxes stop saying it is wrong.
  const [edited, setEdited] = useState(false);
  const navigation = useNavigation();
  const sending = useRef(false);

  // When a sending comes back: a refused code is cleared, ready for the next one.
  useEffect(() => {
    if (navigation.state !== "idle") return;
    if (sending.current && invalid) {
      setValue("");
      setEdited(false);
      input.current?.focus();
    }
    sending.current = false;
  }, [navigation.state, invalid]);

  // One sending at a time: the first (ours or a password manager's) goes, any other is dropped.
  // A listener on the form itself runs before React Router's, which listens at the root.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const once = (event: SubmitEvent) => {
      if (sending.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      sending.current = true;
    };
    form.addEventListener("submit", once);
    return () => form.removeEventListener("submit", once);
  }, []);

  // Seen before the boxes' own paste handling, so a recovery code is not cut to digits first.
  const onPasteCapture = (event: ClipboardEvent) => {
    const pasted = event.clipboardData.getData("text");
    if (!onRecoveryCode || !looksLikeRecoveryCode(pasted)) return;
    event.preventDefault();
    event.stopPropagation();
    onRecoveryCode(pasted.trim());
  };
  return (
    <div onPasteCapture={onPasteCapture}>
      <InputOTP
        ref={input}
        id={id}
        name={name}
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        pasteTransformer={codeDigits}
        value={value}
        onChange={(next) => {
          setValue(next);
          setEdited(true);
        }}
        onComplete={() => {
          if (submit && !sending.current) input.current?.form?.requestSubmit();
        }}
        autoComplete="one-time-code"
        inputMode="numeric"
        autoFocus={autoFocus}
        aria-invalid={(invalid && !edited) || undefined}
        aria-describedby={describedBy}
        containerClassName={cn(centered && "justify-center")}
      >
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>
    </div>
  );
}

/**
 * A two-factor code: the boxes for the code from an authenticator app,
 * or, with `recovery`, a way across to a recovery code's text field.
 * Identity takes either kind whichever field it came from. `centered`
 * is for a page whose heading already says what to enter (signing in):
 * the label is for screen readers, and the boxes and the link sit in the
 * middle.
 */
export function TwoFactorCodeField({
  id = "totp-code",
  label = "Authentication code",
  hint,
  recovery = false,
  autoFocus,
  submit,
  invalid,
  centered = false,
}: {
  id?: string;
  label?: string;
  hint?: string;
  /** Whether a recovery code is taken here too. */
  recovery?: boolean;
  autoFocus?: boolean;
  submit?: boolean;
  invalid?: boolean;
  centered?: boolean;
}) {
  const [usingRecovery, setUsingRecovery] = useState<false | { initial: string }>(false);
  const shownLabel = usingRecovery ? "Recovery code" : label;
  const field = usingRecovery ? (
    <Input
      {...otpInputProps({ id, recovery: true })}
      defaultValue={usingRecovery.initial}
      aria-invalid={invalid || undefined}
      autoFocus={autoFocus || usingRecovery.initial !== ""}
      className={cn(centered && "text-center")}
    />
  ) : (
    <CodeSlots
      id={id}
      autoFocus={autoFocus}
      submit={submit}
      invalid={invalid}
      centered={centered}
      onRecoveryCode={recovery ? (code) => setUsingRecovery({ initial: code }) : undefined}
    />
  );
  return (
    <div className={cn("flex flex-col gap-3", centered ? "items-center" : "items-start")}>
      {centered ? (
        <div className="w-full">
          <label htmlFor={id} className="sr-only">
            {shownLabel}
          </label>
          {field}
          {hint && <p className="mt-2 text-center text-xs text-faint">{hint}</p>}
        </div>
      ) : (
        <div className="w-full">
          <Field label={shownLabel} htmlFor={id} hint={hint}>
            {field}
          </Field>
        </div>
      )}
      {recovery && (
        <Button type="button" variant="link" size="inline" className="text-sm" onClick={() => setUsingRecovery(usingRecovery ? false : { initial: "" })}>
          {usingRecovery ? "Use a code from your app" : "Use a recovery code"}
        </Button>
      )}
    </div>
  );
}
