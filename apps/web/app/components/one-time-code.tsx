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
 */
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

import { Field, Input } from "./ui";
import { Button } from "./ui/button";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "./ui/input-otp";
import { codeDigits, looksLikeRecoveryCode, otpInputProps } from "../lib/otp";

/**
 * The six boxes. `submit` sends the form once the sixth digit is in.
 * `onRecoveryCode`, when given, takes a recovery code pasted into them.
 */
export function CodeSlots({
  id,
  name = "code",
  autoFocus,
  submit = false,
  invalid = false,
  describedBy,
  onRecoveryCode,
}: {
  id: string;
  name?: string;
  autoFocus?: boolean;
  submit?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onRecoveryCode?: (code: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  // A code that was sent and refused is cleared, ready for the next one.
  const navigation = useNavigation();
  const sent = useRef(false);
  useEffect(() => {
    if (navigation.state !== "idle") {
      sent.current = true;
      return;
    }
    if (sent.current && invalid) {
      setValue("");
      input.current?.focus();
    }
    sent.current = false;
  }, [navigation.state, invalid]);
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
        onChange={setValue}
        onComplete={() => {
          if (submit) input.current?.form?.requestSubmit();
        }}
        autoComplete="one-time-code"
        inputMode="numeric"
        autoFocus={autoFocus}
        required
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
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
 * Identity takes either kind whichever field it came from.
 */
export function TwoFactorCodeField({
  id = "totp-code",
  label = "Authentication code",
  hint,
  recovery = false,
  autoFocus,
  submit,
  invalid,
}: {
  id?: string;
  label?: string;
  hint?: string;
  /** Whether a recovery code is taken here too. */
  recovery?: boolean;
  autoFocus?: boolean;
  submit?: boolean;
  invalid?: boolean;
}) {
  const [usingRecovery, setUsingRecovery] = useState<false | { initial: string }>(false);
  return (
    <div className="space-y-2">
      <Field label={usingRecovery ? "Recovery code" : label} htmlFor={id} hint={hint}>
        {usingRecovery ? (
          <Input
            {...otpInputProps({ id, recovery: true })}
            defaultValue={usingRecovery.initial}
            aria-invalid={invalid || undefined}
            required
            autoFocus={autoFocus || usingRecovery.initial !== ""}
          />
        ) : (
          <CodeSlots
            id={id}
            autoFocus={autoFocus}
            submit={submit}
            invalid={invalid}
            onRecoveryCode={recovery ? (code) => setUsingRecovery({ initial: code }) : undefined}
          />
        )}
      </Field>
      {recovery && (
        <Button type="button" variant="link" size="inline" className="text-sm" onClick={() => setUsingRecovery(usingRecovery ? false : { initial: "" })}>
          {usingRecovery ? "Use a code from your app" : "Use a recovery code"}
        </Button>
      )}
    </div>
  );
}
