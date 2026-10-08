---
title: Releases
description: Publish a tag with a title and notes, keep drafts and pre-releases, and read the latest release from the API.
---

A release is a tag published with a title and notes, for people to see what
changed and download it. A repository's releases are at
`g1t.sh/<workspace>/<repo>/releases`, and the latest one is in the **About**
beside its files.

## Publish a release

You need the Write role on the repository.

1. Open the repository's **Code → Releases**, or choose **Create a new
   release** under **Releases** in the About beside its files.
2. Choose **Draft a new release**.
3. Under **Tag**, pick an existing tag or type a new one, such as `v1.2.0`.
4. For a new tag, under **Target**, choose the branch or commit to make it
   at. The default branch is used when you leave it empty.
5. Give it a **Title** and **Notes** in Markdown.
6. Choose **Publish release**, or **Save draft** to finish it later.

A tag that does not exist yet is made as a lightweight tag at the target,
under the repository's [tag rulesets](/guides/rules/). A tag that exists is
released as it is. Each tag has at most one release.

| Field | Rules |
| --- | --- |
| Tag | A valid git ref name. Required. |
| Target | A branch or commit. Used only for a new tag. |
| Title | Up to 200 characters. The tag's name is shown when it has none. |
| Notes | Markdown, up to 125,000 characters. |
| Pre-release | Not ready for everyone: it is never the latest release. |

## Drafts, pre-releases and the latest release

| State | Who sees it | Latest? |
| --- | --- | --- |
| Draft | People with the Write role | Never |
| Pre-release | Everyone who can read the repository | Never |
| Published | Everyone who can read the repository | When it is the newest |

The **latest release** is the newest published release that is neither a
draft nor a pre-release. To publish a draft, open it and choose **Publish
release**.

## Delete a release

Open the release and choose **Delete release**. The tag stays: delete it
with git.

```sh
git push origin :refs/tags/v1.2.0
```

## From the API and MCP

| Route | MCP | What it does |
| --- | --- | --- |
| [`GET /repos/{owner}/{name}/releases`](/reference/api/releases/list-releases/) | `repository` `list_releases` | Releases, newest first, at most 100. Drafts only for the Write role. |
| [`POST /repos/{owner}/{name}/releases`](/reference/api/releases/create-release/) | `repository` `create_release` | Publish a release: `tag_name`, `target`, `release_name`, `body`, `draft`, `prerelease`. |
| [`GET /repos/{owner}/{name}/releases/latest`](/reference/api/releases/get-latest-release/) | `repository` `latest_release` | The latest release. |
| [`GET /repos/{owner}/{name}/releases/tags/{tag}`](/reference/api/releases/get-release-by-tag/) | `repository` `get_release_by_tag` | The release of one tag. |
| [`GET /repos/{owner}/{name}/releases/{id}`](/reference/api/releases/get-release/) | `repository` `get_release` | One release by its id (`rel_…`). |
| [`PATCH /repos/{owner}/{name}/releases/{id}`](/reference/api/releases/update-release/) | `repository` `update_release` | Change its `release_name`, `body`, `draft` or `prerelease`. `draft: false` publishes it. |
| [`DELETE /repos/{owner}/{name}/releases/{id}`](/reference/api/releases/delete-release/) | `repository` `delete_release` | Delete it; the tag stays. |

Under a repository's address `name` is the repository's, so a release's
title is sent as `release_name` and comes back as `name`.

```sh
curl -X POST https://api.g1t.sh/repos/flagon-io/hello/releases \
  -H "Authorization: Bearer $G1T_TOKEN" \
  -d '{"tag_name": "v1.2.0", "release_name": "Greetings by name", "body": "## What changed\n\n- Greets the caller by name"}'
```

Reading releases takes the `repo:read` scope; publishing, changing and
deleting them take `repo:write`.
