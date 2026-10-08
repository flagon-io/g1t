---
title: CODEOWNERS
description: Say who owns which paths in a repository with a CODEOWNERS file. g1t asks owners to review the pull requests that change their files, and branch protection can require their approval before a merge.
---

A **CODEOWNERS** file says who owns which files in a repository. When a
pull request changes files, g1t asks their owners to review it, shows on
the pull request whose approval is still needed, and, if the repository
requires it, holds the merge until they have approved.

```text
# Everything, unless a later line says otherwise
*                 @acme/engineering

# The API belongs to the backend team
/api/             @acme/backend

# Docs need a writer
*.md              @acme/writers ana@example.com

# Generated code has no owner
/api/generated/
```

## Where the file goes

Put the file in one of these places on the repository's default branch.
g1t reads the first one that exists, in this order, and ignores the rest:

| Order | Path |
| --- | --- |
| 1 | `.g1t/CODEOWNERS` |
| 2 | `.github/CODEOWNERS` |
| 3 | `CODEOWNERS` |
| 4 | `docs/CODEOWNERS` |
| 5 | `.gitlab/CODEOWNERS` |

So a repository you bring to g1t with its file already at
`.github/CODEOWNERS` or `.gitlab/CODEOWNERS` works as it is. The name is
case-sensitive: `codeowners` is not read, and neither is a file anywhere
else, such as `src/CODEOWNERS`.

g1t always reads the file from the branch a pull request merges into, not
from the pull request. A change to the file takes effect once it is merged.

## Rules

Each line is a **pattern**, then the **owners** of the paths it matches,
separated by spaces:

```text
/api/  @ana @acme/backend
```

For each file, **the last rule that matches it wins**. Put broad rules
first and narrower ones after them:

```text
*          @acme/engineering
*.rs       @acme/rust
/src/      @cy
/src/*.rs  @dee
```

| File | Owners | Because |
| --- | --- | --- |
| `README.md` | `@acme/engineering` | Only `*` matches. |
| `lib/x.rs` | `@acme/rust` | `*.rs` is the last match. |
| `src/x.txt` | `@cy` | `/src/` is the last match. |
| `src/x.rs` | `@dee` | `/src/*.rs` is the last match. |
| `src/a/x.rs` | `@cy` | `/src/*.rs` matches files directly in `src/` only, so `/src/` is the last match. |

The order matters: written the other way round, with `*` last, `@acme/engineering`
would own everything.

### No owners

A rule with no owners says the paths it matches have none. Their changes
need no code owner's review:

```text
*                 @acme/engineering
/vendor/
package-lock.json
```

### Comments and escapes

| Write | For |
| --- | --- |
| `# ...` at the start of a line | A comment line. |
| ` # ...` after a space | A comment for the rest of the line. |
| `\#` at the start of a pattern | A literal `#`: `\#notes` matches a file named `#notes`. |
| `\ ` | A space inside a pattern: `My\ Notes.md`. |
| `\*`, `\?` | A literal `*` or `?`. |

Blank lines, a byte order mark and Windows line ends (`\r\n`) are all
fine.

## Patterns

Paths are from the root of the repository, and case-sensitive.

| Pattern | Matches | Does not match |
| --- | --- | --- |
| `*` | Every file | |
| `*.js` | `a.js`, `web/src/a.js` | `a.jsx` |
| `/*.md` | `README.md` | `docs/README.md` |
| `?.txt` | `a.txt` | `ab.txt` |
| `docs` | `docs/a.md`, `x/docs/y/z.md`, a file named `docs` | `mydocs/a.md` |
| `/docs` | `docs/a.md` | `x/docs/a.md` |
| `docs/` | `docs/a.md`, `x/docs/a.md` | a file named `docs` |
| `docs/*` | `docs/a.md` | `docs/sub/a.md`, `x/docs/a.md` |
| `/build/logs/` | `build/logs/a.txt` | `x/build/logs/a.txt` |
| `**/foo` | `foo`, `x/foo`, `x/y/foo/bar` | `x/foobar` |
| `foo/**` | `foo/a`, `foo/a/b` | `x/foo/a` |
| `a/**/b` | `a/b`, `a/x/b`, `a/x/y/b` | `x/a/b` |
| `src/**/*.rs` | `src/main.rs`, `src/a/b/main.rs` | `lib/main.rs` |
| `crates/*/migrations/` | `crates/a/migrations/1.sql` | `crates/a/b/migrations/1.sql` |

In full:

- `*` matches anything but `/`, and `?` one character but `/`.
- `**/` at the start matches in every directory, `/**` at the end matches
  everything inside, and `/**/` matches zero or more directories. `**`
  anywhere else is the same as `*`.
- A `/` at the start, or anywhere but at the end, anchors the pattern to
  the root. Without one, it matches at any depth.
- A `/` at the end means a directory: everything inside one of that name,
  never a file of that name.
- A pattern that matches a directory matches every file under it, unless
  its last part has a wildcard, such as `docs/*` or `*.md`: then it matches
  files only, so `docs/*` owns `docs/a.md` but not `docs/sub/a.md`.

Negation (`!`) and character ranges (`[a-z]`) are not part of the format.
A line that uses them is skipped and shown as an [error](#errors). To give
part of a directory no owner, add a later rule with no owners instead.

## Owners

| Write | Means | Must |
| --- | --- | --- |
| `@ana` | The person with that username. | Have the Write [role](/guides/access-and-roles/) or higher on the repository. |
| `@acme/backend` | Everyone in the [team](/guides/teams/), and in its child teams. | Be a team of the repository's workspace, with the Write role or higher on the repository. |
| `ana@example.com` | The g1t account that has confirmed that address. | Have the Write role or higher on the repository. |
| `@g1t` | g1t's agent. | |

A file written for another host may name teams under an organization that
is not a g1t workspace, such as `@acme-corp/backend`. g1t reads those as
teams of the repository's own workspace, so creating a team with the slug
`backend` in it makes the rule work without editing the file. A team of a
different g1t workspace never owns anything here.

An owner that does not resolve, or cannot write to the repository, owns
nothing, and is shown as an [error](#errors). A rule left with no owner
that resolves asks for no review.

## Sections

A line such as `[Docs]` starts a **section**. The rules after it belong to
it, until the next section header. Rules before the first header are in the
default section.

Each section applies its own last match. One file can need reviews from
more than one section:

```text
*.rb                    @ruby

[Security]
config/secrets/         @acme/security

[Database][2] @acme/data
db/
db/seeds.rb             @seed-keeper @cy

^[Style] @acme/design
*.css
```

| File | Needs |
| --- | --- |
| `app/user.rb` | 1 approval from `@ruby` |
| `db/migrate/001.rb` | 1 from `@ruby`, and 2 from `@acme/data` (the section's default owners) |
| `db/seeds.rb` | 1 from `@ruby`, and 2 from `@seed-keeper` and `@cy` |
| `config/secrets/prod.yml` | 1 from `@acme/security` |
| `web/site.css` | Nothing: `@acme/design` is asked, but Style is optional |

| Header | What it does |
| --- | --- |
| `[Name]` | Starts a section that needs 1 approval from the owners of each of its rules that match. |
| `[Name][2]` | Needs that many approvals, from 1 to 10. |
| `^[Name]` | Optional: its owners are asked to review, but their approval is not required. |
| `[Name] @owner ...` | Default owners, for the section's rules that name none. |

Section names are compared without regard to case. Two headers with the
same name are one section: the first spelling is kept, and a later
header's approval count and default owners replace the earlier ones when
it gives them. A later `^` makes the section optional.

In a section with default owners, a rule with no owners gets the
defaults. To say some paths have no owners there, put them in a section
without defaults.

A header that cannot be read is an error, and the rules after it stay in
the section before it.

## Review requests

When a pull request is opened, marked ready, or pushed to, g1t works out
who owns the files it changes and asks them to review it:

- people as reviewers, teams as [team reviewers](/guides/teams/#review-requests),
  where the team's review assignment decides who is picked;
- each owner once: someone who was asked and removed is not asked again on
  the next push;
- never the pull request's author, or whoever asked g1t for it, and never
  g1t's agent;
- owners of optional sections too;
- a draft once it is marked ready.

The inbox tells them **acme/api#42 changes files you own**, or **acme/api#42
changes files @acme/backend owns**, with the reason `review_requested`.
Webhooks get `pull.review_requested` with `data.code_owners` set to `true`.

## On the pull request

A pull request whose target has a CODEOWNERS file shows **Code owners**:
which rule owns which changed files, each with its section, its owners,
how many approvals it needs, who has approved, and who has asked for
changes. A rule that is satisfied, or optional, is marked so.

When the repository requires code owners' approval, the merge box lists
what is missing:

```text
@bo asked for changes on /web/ (code owner). Code owners have not approved:
@acme/backend for /api/, @acme/data for db/ (1 of 2 approvals).
```

## Require review from code owners

Someone with the Maintain role or higher turns it on under the
repository's **Settings → Branches and merging**, in **Branch protection**:
**Require review from code owners**. It is off by default.

With it on, a pull request merges only when every rule that owns a changed
file has the approvals its section asks for, from its owners, and no code
owner has asked for changes. It is worked out again at the moment of the
merge, from the file on the target branch as it is then.

What counts:

| | Counts |
| --- | --- |
| An approval from someone the rule names, or from anyone in a team it names or that team's child teams | Yes |
| An approval from the pull request's author, or from whoever asked g1t for it | Never |
| An approval from g1t's agent | Only for a rule that names `@g1t`. **g1t's approval counts** does not change this. |
| A code owner who asked for changes | Holds the merge until that person approves. Only each reviewer's latest verdict counts. |
| An owner that did not resolve | Owns nothing, so nothing is waited for. |

It holds wherever a pull request merges: the merge button,
[`merge_pull_request`](/reference/api/pull-requests/merge-pull-request/),
a g1t agent's [automatic merge](/guides/working-with-g1t/#merging-automatically),
and the [merge queue](/guides/merge-queue/). It holds pull requests g1t
opens by itself too, such as [security updates](/guides/security/), which
then need a person who owns the files. **Allow bypassing required checks**
does not bypass it.

It adds to **Required approvals**, which is checked first: an approval from
a code owner also counts towards that number.

```sh
curl -X PATCH https://api.g1t.sh/repos/acme/api/settings \
  -H "Authorization: Bearer $G1T_TOKEN" -H "Content-Type: application/json" \
  -d '{"require_code_owner_review": true}'
```

## Errors

g1t checks the file like a linter, and shows what is wrong with each line:

- on the repository's **Settings → Branches and merging**, in the
  **CODEOWNERS** panel, for the default branch;
- on the file's own page, beside each line, when you open it in the code
  view;
- through the API, for any branch.

| Kind | Example message |
| --- | --- |
| `too_large` | The CODEOWNERS file is larger than 3 MB, so none of it applies; make it smaller. |
| `negation` | !docs/ starts with !, and negation is not supported; this line is skipped. Give the path a later rule with no owners instead. |
| `character_range` | docs/[a-z]*.md uses [ or ], and character ranges are not supported; this line is skipped. Write one rule per name, or use * or ?. |
| `bad_pattern` | / names no path; this line is skipped. Write a file or directory pattern, such as * or /docs/. |
| `bad_owner` | nobody is not an owner; write @username, @workspace/team or an email address. |
| `bad_section` | The approval count [0] must be a whole number from 1 to 10. |
| `unknown_user` | @ana is not a g1t account. |
| `unknown_team` | @acme/backend is not a team of acme. |
| `unknown_email` | No g1t account has confirmed ana@example.com. |
| `no_write_access` | @bo cannot write to this repository; code owners need the Write role or higher. |
| `team_no_access` | @acme/docs has no access to this repository; give the team the Write role or higher. |

A section header can also be refused with: "The section header has no
closing ]; write it as [Name].", "The section header has no name; write it
as [Name].", "The section name cannot contain [; write it as [Name].", "The
approval count has no closing ]; write it as [Name][2]." or "Put a space
between the section header and its owners."

A line with an error in its pattern is skipped. An owner with an error is
left out, and the rest of its line still applies.

### The codeowners check

A pull request that changes a CODEOWNERS file, in any of the
[places g1t reads](#where-the-file-goes), gets a status on its head,
`g1t / codeowners`: a failure such as `.github/CODEOWNERS has 2 errors`,
or a success, `.github/CODEOWNERS has no errors`. **Details** opens the
file as the pull request has it, with its errors by line. Make it a
[required status check](/guides/pull-requests/#required-status-checks) to
stop a broken file from merging.

## Limits

| | |
| --- | --- |
| File size | 3 MB. A larger file is ignored as a whole, with one error. |
| Approvals per section | 1 to 10. |

## Through the API

| Route | MCP | What it does |
| --- | --- | --- |
| `GET /repos/{owner}/{name}/codeowners/errors` | `repository` `codeowners` | The file at `ref` (the default branch when left out): where it is, its size, its rules and sections, and every error. Needs `repo:read`. |
| `GET /repos/{owner}/{name}/pulls/{number}` | `pull_request` `get` | `code_owners`: the file's path, `required`, a review per rule with `section`, `pattern`, `owners`, `files`, `required`, `approved_by`, `changes_requested_by` and `satisfied`, what is `missing`, and how many `errors` the file has. Absent when the target has no file. |
| `PATCH /repos/{owner}/{name}/settings` | `repository` `update_settings` | `require_code_owner_review`: `true` or `false`. Needs Maintain. |

```sh
curl "https://api.g1t.sh/repos/acme/api/codeowners/errors?ref=main" \
  -H "Authorization: Bearer $G1T_TOKEN"
```

```json
{
  "path": ".github/CODEOWNERS",
  "ref": "main",
  "size": 412,
  "rules": 9,
  "sections": ["Security", "Database"],
  "errors": [
    {
      "line": 7,
      "kind": "unknown_team",
      "token": "@acme/backend",
      "message": "@acme/backend is not a team of acme."
    }
  ]
}
```

`path` is null when the repository has no CODEOWNERS file at that ref.
Every route is in the [API reference](/reference/api/), and every action in
[MCP tools](/reference/mcp/).
