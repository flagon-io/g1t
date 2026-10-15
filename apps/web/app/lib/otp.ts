/**
 * The attributes every one-time-code field shares: the sign-in's second
 * step, two-factor settings and email confirmation. Password managers
 * (1Password, iCloud Keychain, Bitwarden) and phones' SMS/email code
 * suggestions find the field by `autocomplete="one-time-code"` and a
 * stable id, so it carries no ignore attributes. A field that also takes
 * a recovery code (`k7m2q-9xw4d`) has a text keyboard and room for one:
 * a numeric `pattern` or a six-character `maxLength` would refuse or cut
 * a pasted recovery code before identity could check it.
 */
export function otpInputProps({ id, recovery = false }: { id: string; recovery?: boolean }) {
  return {
    id,
    name: "code",
    type: "text",
    autoComplete: "one-time-code",
    autoCapitalize: "none",
    autoCorrect: "off",
    spellCheck: false,
    inputMode: recovery ? "text" : "numeric",
    maxLength: recovery ? 20 : 7,
    pattern: recovery ? undefined : "[0-9 ]{6,7}",
    placeholder: recovery ? "k7m2q-9xw4d" : "123 456",
  } as const;
}

/** A code as pasted, without the spaces and dashes people copy with it ("123 456", "123-456"). */
export function codeDigits(pasted: string): string {
  return pasted.replace(/[\s-]/g, "");
}

/** Whether pasted text is a recovery code (`k7m2q-9xw4d`) rather than an app's six digits: it has letters in it. */
export function looksLikeRecoveryCode(pasted: string): boolean {
  const text = codeDigits(pasted.trim());
  return /[a-z]/i.test(text) && /^[a-z0-9]{6,20}$/i.test(text);
}
