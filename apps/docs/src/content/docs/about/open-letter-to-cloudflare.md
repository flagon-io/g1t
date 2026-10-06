---
title: An open letter to Cloudflare
description: From the team at Flagon, Inc. building g1t, a git platform that runs entirely on Cloudflare. What works, where we hit walls, and what we'd ask for.
---

Dear Cloudflare,

We're the small team at Flagon, Inc. building g1t, a git platform where
people and coding agents work in the same issues, pull requests and merge
queue. Every part of it runs on you: about twenty Workers, a D1 database per
service, Artifacts for every repository and every pull request, Containers
for agents and CI, R2, KV, Queues, and Cloudflare for SaaS for our customers'
domains. We have no servers.

This is a thank-you, and a list of what would help us most next.

## Why we built on you

A git platform is usually a fleet: storage nodes, a job system, a database
cluster, a CDN in front, and people on call for all of it. We wanted to run
one for thousands of teams with a handful of people. You offered a global
platform where the unit of work is a request, the unit of storage is a
Durable Object, and nothing costs money while nobody is using it.

Artifacts is the reason g1t exists in this shape. One Durable Object per
repository is the right isolation unit: a busy repository doesn't slow its
neighbours, and there is nothing to shard by hand. It speaks real git, so
stock clients cloned, fetched and pushed through our proxy from the first
day. `fork()` is a single call, and per-pull-request isolation for agents
fell out of it almost for free. Scoped tokens that expire on their own let
us hand a sandbox a credential that dies with it. The read binding powers
every page we render, blame, mergeability and search, without a git client
anywhere.

The rest of the platform held up too. Rust compiled to WebAssembly runs our
services. D1's read replication is free and good. Containers gave us
sandboxes in three sizes. With a cached credential and ref listing, a
`git fetch` with nothing new answers in under half a second, and most of
our pages answer in under 250 ms. We went from an empty repository to a
launch on this stack, and most of it worked the first time.

## Where we hit walls

Running a real platform for many teams found the edges. None of these
stopped us. Each one costs us code, latency or certainty, and each one will
cost the next team building on you the same.

**What a billable operation is.** Artifacts pricing names "repo operations,
such as create, push, pull, and clone", and the metrics list a different set
of event names. Neither says whether binding reads, token mints or ref
listings count. We price from cost, so this decides what our customers pay.
Depending on the answer, our model for a few thousand workspaces lands
anywhere between about $1.8k and $31k a month. Today we count every clone,
fetch and push ourselves, and hope it matches.

**What a fork stores.** Forks are the natural primitive for a pull request,
and agents open pull requests by the thousand. We can't find whether a fork
shares objects with its source or copies them. If it copies, an agent-heavy
account reaches the 1 TB account limit in days, and at that point every push
in the account fails, for every customer at once. We keep forks for now,
and are measuring it ourselves.

**A write path and a pre-receive hook.** The binding reads, but it can't
list refs, move them, or write objects. So to land a pull request we speak
git's wire protocol to our own storage from inside a Worker, buffering packs
in an isolate with 128 MB to share. With no hook before refs move, branch
protection and secret scanning only hold for pushes through our proxy, which
parses every pack in WebAssembly before forwarding it. We wrote a second
implementation of git's pack format to get there.

**Ref-change events and the cost of a credential.** Push events need one
subscription per repository, which doesn't scale to tens of thousands of
repositories and forks. We record ref changes ourselves, and a test scans
our own source to make sure every code path that moves a ref says so. Every
git credential takes three binding calls and about 0.8 s to mint, so we
cache sealed tokens across isolates in KV.

**Placement that follows data.** Smart Placement once ran our site in
Amsterdam for a visitor in Denver, while every D1 primary we have is in
western North America. Every query crossed the Atlantic, and our Explore
page took 0.85 s instead of 0.17 s. We turned placement off everywhere and
measure each Worker by hand.

**D1 sessions across service bindings.** Read replicas need a bookmark to
give read-your-writes. Our site calls seven services, each with its own
database, so we built a header protocol to carry bookmarks through service
bindings into a cookie and back.

**Containers that build images and keep disks.** We found no supported way
to run Docker or BuildKit in a Container, so our own CI can't rebuild our
sandbox image; that waits for a machine outside. Container disk is
ephemeral, so the self-hostable git store we'd like as a warm fallback has
to live off Cloudflare.

**Inbound TCP for SSH.** Git users expect `git@host:owner/repo`. Workers
take no inbound TCP, so g1t is HTTPS only. We've applied for the beta and
are waiting.

## What we built in the meantime

A per-workspace operation counter that is our best guess at your invoice. A
fork sweep we can switch on once we know what forks cost. A smart HTTP
client inside a Worker for landing, catch-up, mirrors and imports. Our own
push policy in front of Artifacts. A versioned ref cache with a test that
guards it. Two layers of credential caching. A bookmark protocol for D1.
A probe that deploys throwaway Workers to measure placement, and a
`Server-Timing` header on every response so we see the next regression.
Image builds on a laptop.

All of it works. Most of it is code we'd happily delete.

## What we're asking for

1. A published definition of a billable Artifacts operation, with
   per-repository metrics that use the same names as the invoice.
2. Documented fork storage, an expiry on `fork()`, a repository's stored
   bytes in `info()`, and a warning before the account storage limit, with
   failures per repository rather than account-wide.
3. Ref listing, atomic compare-and-swap ref updates and streaming pack
   writes in the binding.
4. A pre-receive hook that a Worker answers.
5. Account-level ref-change events to a Queue, a read-after-write guarantee
   for refs, and git forwarding authenticated by the binding, with no token
   to mint.
6. Placement that accounts for D1 primaries and service bindings, and D1 as
   a placement target.
7. D1 sessions that travel across service bindings.
8. Image builds and persistent volumes for Containers.
9. Inbound TCP, so git can run over SSH.
10. A support path during the beta, snapshot restore and export for
    repositories, and a date for general availability with an SLA.

## Let's work on it together

We chose you on purpose, and we'd choose you again. A small team running a
global git platform with no servers is the promise of what you've built,
and g1t shows that it mostly holds. We'd like to help close the
rest of the gap: traces, test repositories, early builds to try, or a call
with the teams involved. Whatever is useful.

You can reach us through [g1t.sh](https://g1t.sh/support). Our code lives
at [g1t.sh/flagon-io/g1t](https://g1t.sh/flagon-io/g1t), on the platform
it describes.

With thanks,

The team at Flagon, Inc.
