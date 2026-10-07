---
title: Container images
description: Push and pull container images on g1t.sh with docker, in workflows with G1T_TOKEN, and push layers over 100 MB with g1t push.
---

g1t.sh is a container registry. Images are named after their workspace,
pushed and pulled with `docker` or any client of the OCI Distribution
protocol, and have the access of the repository they are linked to (see
[who can see and publish a package](/guides/packages/#who-can-see-and-publish-a-package)).

```text
g1t.sh/<workspace>/<name>[:<tag>]
```

## Sign in

Use your username, and an [access token](https://g1t.sh/settings/tokens) as
the password: one with full access, or with `packages:write` (to push) or
`packages:read` (to pull private images).

```sh
echo "$G1T_TOKEN" | docker login g1t.sh -u <you> --password-stdin
```

Public images pull without signing in.

## Push

Tag the image with its address and push it:

```sh
docker build -t g1t.sh/acme/web:1.4.0 .
docker push g1t.sh/acme/web:1.4.0
```

The first push makes the package. When its name starts with a repository
of the workspace, here `acme/web`, it is linked to that repository and
follows its visibility and roles; pushing needs Write on it. Otherwise it is
the workspace's, private, and needs the workspace's Write base permission.

Pushing a tag again moves it to the new image. Layers already on g1t are
not uploaded again, and images in the same workspace share them.

Multi-platform images (`docker buildx build --platform linux/amd64,linux/arm64 --push`),
OCI image indexes, and artifacts attached to an image with a `subject`
(signatures, SBOMs, attestations) are all kept; the registry lists an image's
attached artifacts at `/v2/<name>/referrers/<digest>`.

## Pull

```sh
docker pull g1t.sh/acme/web:1.4.0
docker pull g1t.sh/acme/web@sha256:…
```

## In workflows

A workflow's `G1T_TOKEN` is the workspace's own token for the run, and can
push and pull the workspace's images:

```yaml
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sign in to g1t.sh
        run: echo "${{ secrets.G1T_TOKEN }}" | docker login g1t.sh -u g1t --password-stdin
      - name: Build and push
        run: |
          docker build -t g1t.sh/${{ github.repository }}:${{ github.sha }} .
          docker push g1t.sh/${{ github.repository }}:${{ github.sha }}
```

Runs that get no secrets (a pull request from someone without Write) get an
empty token, and cannot push. See
[secrets and variables](/guides/actions/#secrets-and-variables).

## The 100 MB limit

A single request to g1t.sh may carry at most 100 MB. `docker push` sends
each layer whole, in one request, so a layer over 100 MB, as compressed for
the push, is refused. [`g1t push`](#push-large-layers-with-g1t-push) sends
it in chunks instead, and has no limit.

What you see depends on where it is refused. Usually it is before the
request reaches g1t, and `docker push` stops with a bare status:

```text
unknown: failed commit on ref "layer-sha256:…": unexpected status from PUT request to https://g1t.sh/v2/acme/web/blobs/uploads/…?digest=sha256%3A…: 413 Request Entity Too Large
```

(the request may be a `PATCH` instead of a `PUT`, and some versions of
Docker show the HTML page that came with the 413 instead). When g1t sees
the request itself, the error is `SIZE_INVALID`, with a message naming the
limit and this page.

An installation you [run yourself](/guides/self-hosting/) has no such
limit.

### Push large layers with g1t push

`g1t push` takes an image from your local docker and pushes it to g1t.sh,
each layer in chunks of 90 MiB, each chunk its own request. A layer can be
any size.

```sh
docker build -t g1t.sh/acme/model:1 .
g1t push g1t.sh/acme/model:1
```

An image with a local name is pushed to the address after `--as`:

```sh
g1t push model:dev --as g1t.sh/acme/model:1
```

```text
Reading model:dev from docker
Pushing to g1t.sh/acme/model:1
  config sha256:040e744c070b       851 B  already on the registry, skipped
  layer  sha256:25f1d6b1951a     3.5 MiB  already on the registry, skipped
    chunk 1/2  90.0 MiB  63%
    chunk 2/2  53.1 MiB  100%
  layer  sha256:c74595c4a2cd   143.1 MiB  uploaded in 2 chunks
Pushed g1t.sh/acme/model:1
digest: sha256:39b972d91774d58b5fbd27cfdce73fe58034d9e5772a261d183c11bcf78c1dba
```

It pushes the image docker has: the same config, layers and manifest, so
`docker pull` gets back exactly what you built. When docker keeps a layer
uncompressed, `g1t push` gzips it for the push, as `docker push` does.
Layers already on g1t are not sent again. A request refused with `429` or
an error on g1t's side is tried again after a wait, and an interrupted
layer goes on from where it stopped.

It signs in with the first of:

1. a token on stdin, with `--token-stdin`
   (`echo "$G1T_TOKEN" | g1t push … --token-stdin`);
2. the `G1T_TOKEN` environment variable, as in [workflows](#in-workflows);
3. what `docker login g1t.sh` stored, in `~/.docker/config.json` or the
   credential store it names.

| Option | |
| --- | --- |
| `--as <address>` | Where to push, `g1t.sh/<workspace>/<name>:<tag>`. Without it, the image's own name must be such an address. The tag defaults to `latest`. |
| `--chunk-size <size>` | How much each request carries: `5MB` to `95MB`, `90MB` unless set. `MB` and `MiB` both mean 1,048,576 bytes. |
| `--token-stdin` | Read the token from stdin. |
| `--archive <file>` | Push a tarball written by `docker save`, instead of asking docker. Needs `--as`. |

`g1t --version` prints its version, and `g1t help` its options.

Release binaries of the g1t command line are coming. Until then, build it
from the g1t source with [Rust](https://www.rust-lang.org/tools/install):

```sh
git clone https://g1t.sh/flagon-io/g1t
cd g1t
cargo install --path crates/g1t
```

## Storage and pull limits

Without the [g1t plan](/guides/usage-and-billing/#the-g1t-plan), a
workspace's public packages may hold 10 GB and its private ones 500 MB,
each file counted once. A push that would go past either is refused with
`DENIED` and a message saying how much is used; layers the workspace
already holds add nothing. On the plan nothing is refused: storage past
the free amounts is charged.

Anonymous pulls are limited to 300 requests a minute from each address, and
signed-in ones to 5,000 a minute for each person, workspace or agent.
Past the limit, requests are answered `429` with `TOOMANYREQUESTS` and a
`Retry-After`; docker waits and tries again. Signing in raises the limit.

## Delete

Deleting needs Admin on the linked repository, or for an unlinked image, an
owner of the workspace; a token needs `packages:delete`.

The registry protocol's `DELETE` removes a tag, or a whole version by its
digest (with every tag that points to it):

```sh
TOKEN=$(curl -s -u <you>:<token> "https://g1t.sh/v2/token?scope=repository:acme/web:delete" | jq -r .token)
curl -X DELETE -H "Authorization: Bearer $TOKEN" https://g1t.sh/v2/acme/web/manifests/1.4.0
curl -X DELETE -H "Authorization: Bearer $TOKEN" https://g1t.sh/v2/acme/web/manifests/sha256:…
```

Layers no version uses any more are deleted from storage a day later.

## Errors

| Error | Means |
| --- | --- |
| `UNAUTHORIZED` | Not signed in, or the token is wrong or expired. `docker login g1t.sh` again. |
| `DENIED` | Signed in, but your role or your token's scopes do not allow it. The message says which. |
| `NAME_UNKNOWN` | No such image, or one you cannot see. |
| `MANIFEST_UNKNOWN`, `BLOB_UNKNOWN` | No such tag, digest or layer in that image. |
| `NAME_INVALID` | Names are lowercase letters and digits, separated by `.`, `_`, `__`, `-` or `/`, and start with a workspace. |
| `SIZE_INVALID`, or a bare `413` | A request over [the 100 MB limit](#the-100-mb-limit). Push the image with [`g1t push`](#push-large-layers-with-g1t-push). |
| `TOOMANYREQUESTS` | Too many requests in a minute; see [the limits](#storage-and-pull-limits). |
| `DIGEST_INVALID` | What was uploaded does not have the digest the client said. Push again. |
