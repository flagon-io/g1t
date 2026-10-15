import assert from "node:assert/strict";
import { test } from "node:test";

import { codeDigits, looksLikeRecoveryCode, otpInputProps } from "./otp.ts";

test("one-time-code fields are findable by password managers and carry no ignore attributes", () => {
  for (const recovery of [false, true]) {
    const props: Record<string, unknown> = otpInputProps({ id: "totp-code", recovery });
    assert.equal(props.autoComplete, "one-time-code");
    assert.equal(props.id, "totp-code");
    assert.equal(props.name, "code");
    assert.equal(props.type, "text");
    for (const key of Object.keys(props)) assert.doesNotMatch(key, /1p|lpignore|bwignore|form-type/i);
  }
});

test("an authenticator code field takes six digits, with or without the space", () => {
  const props = otpInputProps({ id: "totp-code" });
  assert.equal(props.inputMode, "numeric");
  const pattern = new RegExp(`^(?:${props.pattern})$`);
  for (const code of ["123456", "123 456"]) {
    assert.match(code, pattern);
    assert.ok(code.length <= props.maxLength);
  }
});

test("a field that takes recovery codes neither cuts nor refuses one", () => {
  const props = otpInputProps({ id: "totp-code", recovery: true });
  assert.equal(props.inputMode, "text");
  assert.equal(props.pattern, undefined);
  for (const code of ["k7m2q-9xw4d", "K7M2Q 9XW4D", "123456"]) assert.ok(code.length <= props.maxLength);
});

test("a code pasted into the boxes loses its spaces and dashes; a recovery code is told apart", () => {
  assert.equal(codeDigits("123 456"), "123456");
  assert.equal(codeDigits(" 123-456 "), "123456");
  for (const code of ["k7m2q-9xw4d", "K7M2Q 9XW4D", " k7m2q9xw4d\n"]) assert.ok(looksLikeRecoveryCode(code), code);
  for (const text of ["123456", "123 456", "", "hello there, this is far too long to be a code"]) assert.ok(!looksLikeRecoveryCode(text), text);
});
