---
title: Search and Explore
description: Search all of g1t at once (repositories, code, issues, pull requests, people and workspaces) with qualifiers, and browse public projects on Explore.
---

**Search** looks through all of g1t at once: repositories, the code on
their default branches, issues, pull requests, people and workspaces. It
covers everything public, and everything private in the workspaces you
belong to. Signed out, you see public results only.

**Explore**, at [g1t.sh/explore](https://g1t.sh/explore), lists public
projects: the recently active ones, the new ones, and the ones in a
language or about a topic.

## Search from anywhere

There are three ways in:

| Where | What it does |
| --- | --- |
| The search box in the top bar | Opens [g1t.sh/search](https://g1t.sh/search) with what you typed |
| **⌘K** (Ctrl-K on Windows and Linux) | Opens the command palette. As you type it shows matching repositories, issues, pull requests and people, the pages you can go to, and rows that search all of g1t or only code for what you typed |
| A project's **Code** page | **Search this repository's code** searches the project's repository, with `repo:` filled in |

The search page has a tab for each kind of result, each with its count:

| Tab | Searches |
| --- | --- |
| **Repositories** | Each repository's name, workspace, description, topics and the opening of its README |
| **Code** | The file names and contents of every repository's default branch |
| **Issues** | Issue titles and descriptions |
| **Pull requests** | Pull request titles and descriptions |
| **People** | Usernames and names of people, and the slugs, names and descriptions of workspaces |

Results show the part that matched, highlighted. A code result shows the
lines that matched with their line numbers, and each line links to that
line of the file, at `/<owner>/<repo>/blob/<branch>/<path>#L<line>`. Counts
stop at 1,000. Results come 20 to a page.

## Writing a query

Words match wherever they appear, in any order. A result has every word
you type.

| You type | It finds |
| --- | --- |
| `merge queue` | Results with both words, anywhere |
| `"merge queue"` | The two words together, in this order |
| `parse -legacy` | Results with `parse` and without `legacy` |
| `pars` | In repositories, issues, pull requests and people, any word that starts with `pars`, such as `parser` |
| `parse_query(` | In code, that exact run of characters, punctuation and all |

Code is matched as text, the way you would find something in an editor:
any run of three characters or more, inside words or across them. A code
search needs at least one word of three characters or more, unless it is
limited to repositories with `repo:`.

### Qualifiers

Put qualifiers anywhere in the query. Most can be left out with a leading
`-`, such as `-label:wontfix`.

| Qualifier | Narrows to | Applies to |
| --- | --- | --- |
| `repo:owner/name` | One repository. Give it more than once for several | Repositories, code, issues, pull requests |
| `org:acme` or `workspace:acme` | One workspace | Repositories, code, issues, pull requests |
| `language:rust` | Code in a language, or repositories mostly written in it. `ts`, `js`, `py` and `cpp` are understood | Repositories, code |
| `path:src/` | Code whose path contains `src/`. With `*`, a pattern: `path:*.rs`, `path:src/*/mod.rs` | Code |
| `is:issue`, `is:pr` | Only issues, or only pull requests | Issues, pull requests |
| `is:open`, `is:closed` | Issues and pull requests by state | Issues, pull requests |
| `is:merged`, `is:draft` | Pull requests that were merged, or are still drafts | Pull requests |
| `is:public`, `is:private` | Results from public or private repositories | Repositories, code, issues, pull requests |
| `author:ana` | Opened by someone | Issues, pull requests |
| `label:bug` | With a label. Quote a label with spaces: `label:"good first issue"` | Issues, pull requests |
| `type:code` | Which tab to open: `repositories`, `code`, `issues`, `pulls` or `people` | All |

Without a tab or `type:`, the qualifiers choose one: `path:` opens Code,
`is:pr` opens Pull requests, `is:open`, `author:` or `label:` open Issues,
and anything else opens Repositories. A qualifier that only one kind of
result has rules the others out: a query with `path:` finds no people.

Some examples:

```text
fetchEvents language:typescript path:app/
"rate limit" org:acme is:issue is:open
crash author:ana -label:wontfix
router repo:acme/web repo:acme/api
```

## What is indexed

Search is kept current as things change:

| What | When it is indexed |
| --- | --- |
| A repository's name, description, topics and README | When it is created or its settings change, and on every push to its default branch |
| Code | On every push to the default branch: only the files the push changed |
| Issues and pull requests | When they are opened, edited, assigned, closed, reopened, marked ready or merged |
| People and workspaces | When an account or a workspace is made, or its name, description or avatar changes |

Code is indexed from default branches only. Some files are left out:

- vendored and generated directories, such as `node_modules`, `vendor`,
  `third_party`, `dist`, `target` and `.next`;
- lockfiles, such as `package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`
  and `go.sum`;
- binary files (images, fonts, archives, compiled code) and minified files;
- files larger than 512 KB.

A push that changes more than 300 files has the whole default branch
compared instead, and files are read a few dozen at a time in the
background, so very large pushes appear in search over a few minutes. A
repository's first 5,000 files are indexed.

Set a repository's **topics** in **Settings → Repository**. Topics show on
the project's page and in search results, and each opens Explore for that
topic.

## Who sees what

Search shows you exactly what you could open yourself:

- Public repositories, and their code, issues and pull requests, are
  shown to everyone, signed in or not.
- Private repositories, and their code, issues and pull requests, are shown
  only to members of the workspace that owns them, and to that workspace's
  agents.
- People and workspaces are public, as their pages are. Search never shows
  which workspaces someone belongs to.

Visibility is checked when you search, against your memberships and each
repository's visibility as they are at that moment, not as they were when
something was indexed. A repository made private disappears from everyone
else's results at once; one made public appears in them within moments.
Someone removed from a workspace stops seeing its private results on their
next search.

## Explore

[Explore](https://g1t.sh/explore) lists public projects only:

| View | Shows |
| --- | --- |
| **Recently active** | Projects by their last push to the default branch |
| **New** | Projects by when they were created |
| **Languages** | The languages public projects are mostly written in, with how many; choose one to see its projects |
| **Topics** | The topics public projects have, with how many; choose one to see its projects |

A project's language is the one most of its indexed code is written in,
leaving out prose and data such as Markdown, JSON and YAML.

## From the API and agents

The same search is `GET /search` in the API and the `search` tool over
MCP. It takes `q` (the query), `type` and `page`, and needs no token for
public results:

```sh
curl "https://api.g1t.sh/search?q=parse_query+language:rust&type=code"
```

With a token, private results in your workspaces are included. g1t's own
agents can search too, with the token their run is given. See
[Search g1t](/reference/api/search/search/) in the API reference and
[MCP tools](/reference/mcp/#search).

`search` looks across all of g1t. To ask about one workspace's catalog,
docs and memory, use the [context hub](/guides/context-hub/) and its
`search_context` tool.
