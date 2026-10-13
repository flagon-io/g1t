# Security

If you've found a security problem in g1t, please tell us privately at
**[hey@flagon.io](mailto:hey@flagon.io)** rather than in an issue, a pull
request or a chat channel. Our
[security.txt](https://g1t.sh/.well-known/security.txt) says the same.

The full policy, with what's in and out of scope, is at
[g1t.sh/security](https://g1t.sh/security#responsible-disclosure). This file
is the short version.

## What to send

What you found, where, how to reproduce it, and what an attacker could do
with it. Screenshots, requests or a short proof of concept help. Please
don't include other people's data.

## What we promise

- We'll acknowledge your report within **2 business days**, give you our
  assessment within **5 business days**, and keep you updated at least every
  14 days until it's fixed.
- We aim to fix critical problems within 30 days.
- We'll credit you when we publish the fix, if you'd like.

We ask for 90 days, or until a fix ships, whichever comes first, before you
share the problem publicly. We'll agree a date with you.

## Supported versions

g1t.sh is deployed continuously from `main`, so a fix reaches it as soon as
it lands. For the CLI, the runner, the desktop and mobile apps, and
self-hosted installs, fixes ship in the next release: keep to the latest one.

## The rules

- Test only against accounts and workspaces you own, or have the owner's
  permission to test.
- Don't access, change or delete other people's data beyond the minimum
  needed to show the problem, and stop and tell us as soon as you've reached
  any.
- Don't degrade g1t for others: no denial of service, load testing or spam,
  and no cryptocurrency miners, even to test detection.

If you act in good faith and follow the policy, we consider your research
authorized and won't pursue legal action against you for it. The
[safe harbour](https://g1t.sh/security#safe-harbour) section says exactly
what that covers.

## Sending a fix

For a vulnerability that isn't fixed yet, **write to us first**: a public
pull request shows the problem to everyone before the fix is live, so we'll
agree with you when to open it. Hardening that doesn't point at an open hole,
such as stricter headers, tighter checks or better tests, is welcome as a
pull request straight away; see [CONTRIBUTING.md](CONTRIBUTING.md).

g1t doesn't pay bug bounties yet. We will once it's making money to pay them
from; until then, we offer credit and our thanks.
