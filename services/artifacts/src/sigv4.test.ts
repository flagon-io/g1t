import assert from "node:assert/strict";
import { test } from "node:test";

import { amzDate, sha256Hex, sign, uriEncode } from "./sigv4.ts";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// AWS's SigV4 test suite, `get-vanilla`: the plainest request there is.
test("signs AWS's get-vanilla test vector", async () => {
  const signed = await sign({
    method: "GET",
    url: "https://example.amazonaws.com/",
    payload_hash: EMPTY,
    region: "us-east-1",
    service: "service",
    credentials: { access_key_id: "AKIDEXAMPLE", secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(signed.canonical_request, `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY}`);
  assert.equal(signed.string_to_sign, "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
  assert.equal(signed.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(
    signed.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

// The S3 documentation's worked example: GET Object with a Range header.
test("signs the S3 GET Object example", async () => {
  const signed = await sign({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { range: "bytes=0-9", "x-amz-content-sha256": EMPTY },
    payload_hash: EMPTY,
    region: "us-east-1",
    service: "s3",
    credentials: { access_key_id: "AKIAIOSFODNN7EXAMPLE", secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.match(signed.headers.authorization!, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

test("hashes and encodes as SigV4 wants", async () => {
  assert.equal(await sha256Hex(""), EMPTY);
  assert.equal(uriEncode("a b/c*~"), "a%20b%2Fc%2A~");
  assert.equal(amzDate(new Date("2015-08-30T12:36:00.123Z")), "20150830T123600Z");
});

test("puts the query in order", async () => {
  const signed = await sign({
    method: "GET",
    url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
    payload_hash: EMPTY,
    region: "us-east-1",
    service: "service",
    credentials: { access_key_id: "AKIDEXAMPLE", secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(signed.canonical_request.split("\n")[2], "Param1=value1&Param2=value2");
  // AWS's `get-vanilla-query-order-key-case`.
  assert.equal(signed.signature, "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
});
