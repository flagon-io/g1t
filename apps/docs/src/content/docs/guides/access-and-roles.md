---
title: Access and roles
description: The five repository roles and what each can do, the base permission members get, outside collaborators and invitations, and what agents may do on a person's behalf.
---

Everyone who can work in a repository has a role on it. The role says what
they can do there, from reading it to managing who else has access. A
workspace gives its members a role on every one of its repositories, and a
repository can give anyone a role of their own: a member who needs more
there, or someone outside the workspace.

## The roles

| Role | For |
| --- | --- |
| **Read** | Read and clone; open issues and pull requests, and comment. |
| **Triage** | Read, and manage issues and pull requests: label, assign, close. |
| **Write** | Triage, and push, merge, and put agents to work. |
| **Maintain** | Write, and manage the repository's settings and branch protection. |
| **Admin** | Everything: webhooks, secrets, deployments, who has access, and the repository's name, visibility and archiving. |

Each role has everything the one above it has.

## What each role can do

| | Read | Triage | Write | Maintain | Admin |
| --- | --- | --- | --- | --- | --- |
| See code, issues and pull requests; clone and fetch | Yes | Yes | Yes | Yes | Yes |
| Open issues and pull requests, and comment | Yes | Yes | Yes | Yes | Yes |
| Label, assign, close and reopen issues and pull requests | | Yes | Yes | Yes | Yes |
| Push to branches that are not protected | | | Yes | Yes | Yes |
| Merge pull requests and use the merge queue | | | Yes | Yes | Yes |
| Assign agents and start runs, plans and workflows | | | Yes | Yes | Yes |
| Change the description, topics, and pull request and agent settings | | | | Yes | Yes |
| Change branch protection and guardrails | | | | Yes | Yes |
| Manage webhooks, secrets, variables, deployments and domains | | | | | Yes |
| Manage who has access, and invitations | | | | | Yes |
| Rename, archive, change visibility and the default branch | | | | | Yes |
| Transfer or delete the repository | | | | | Owners only |

Transferring and deleting a repository also need an owner of its
workspace: someone given Admin on one repository cannot do either. Whoever
opened an issue or pull request can still edit and close their own,
whatever their role.

Read and Triage cannot put agents to work, or start anything else that
spends compute: runs, plans, workflows and deployments need Write.

## How your role is worked out

Your role on a repository is the highest of:

1. **Ownership.** An owner of the workspace has Admin on every repository
   in it.
2. **The base permission.** Every member of the workspace gets the
   workspace's [base permission](#the-base-permission) on every repository
   in it.
3. **A role given to you on that repository.** See
   [add someone to a repository](#add-someone-to-a-repository).
4. **Public.** Anyone, signed in or not, can read a public repository.

The highest wins. A member whose base permission is Read and who is given
Maintain on one repository has Maintain there and Read everywhere else. A
role lower than what you already have changes nothing.

A workspace's own [access token](/guides/workspaces/#workspace-access-tokens)
has Admin on its workspace's repositories, and none on any other.
What is for people only, such as transferring or deleting a repository,
still needs a person.

### Private repositories

Someone without at least Read on a private repository cannot tell it
exists: its pages answer 404, and the API answers `404` with
`Repository not found.`, the same as for a repository that does not exist.
Someone who can read it but lacks the role for what they tried gets `403`
and a message naming the role they need:

```text
You need the Maintain role or higher on acme/rocket to do that.
```

### Git

| | Needs |
| --- | --- |
| `git clone`, `fetch`, `pull` | Read |
| `git push` | Write |

A [protected branch](/guides/git/#protected-branches) refuses pushes from
everyone, whatever their role, Admin included; changes reach it through
pull requests.

## The base permission

The base permission is what every member of a workspace gets on every one
of its repositories:

| Base permission | Members get |
| --- | --- |
| **None** | Nothing beyond what is public. Members see only the private repositories they are given a role on. |
| **Read** | Read on every repository. |
| **Write** | Write on every repository. The default. |
| **Admin** | Admin on every repository. Transferring and deleting stay with owners. |

Owners always have Admin, whatever it says. Only owners can change it:

1. Open the workspace's **Settings → Members**, `g1t.sh/<workspace>/-/people`.
2. Under **Base permission**, choose one.

It takes effect on everyone's next request. To give one member more on
one repository, give them a role there; to give them less, lower the base
permission and give roles to the people who need them.

### What changed for existing members

Before roles, every member of a workspace could also change a repository's
settings, its branch protection and guardrails, webhooks, secrets and
variables, deployments and domains. With the default base permission,
Write, members keep pushing, merging and putting agents to work; changing
settings and protection now needs Maintain, and the rest Admin. Owners
have Admin, so they keep all of it.

To give members everything they had before, an owner sets the base
permission to **Admin**. They then also get what only owners could do
before: managing who has access, renaming and archiving repositories, and
changing their visibility and default branch.

## Add someone to a repository

You need Admin on the repository and a confirmed email address.

1. Open the repository's **Settings → Access**,
   `g1t.sh/<workspace>/<repo>/settings/access`.
2. Under **Add people**, type a username or an email address.
3. Pick their role and choose **Add**.

Everyone with access is listed under **People with access**, with their
role and where it comes from. People with Write or Maintain can see the
list; changing it needs Admin.

What happens depends on who they are:

| Who | What happens |
| --- | --- |
| A member of the workspace | They have the role at once. It matters only where it is higher than the base permission. |
| Someone else on g1t | They are sent an [invitation](#invitations) to accept. Typing the confirmed email address of someone on g1t does the same. |
| An email address with no g1t account | g1t emails an invite code that only that address can use. Signing up with it makes their account and accepts the invitation in one step. |

An invite code to someone without an account uses one of the workspace's
granted invites, or else one of yours (see
[invites](/guides/authentication/#invites)), and works for 30 days.

To change someone's role, pick another beside their name. To take it away,
choose **Remove**. Removing takes away only the role given on this
repository: an owner's Admin and a member's base permission stay. Anyone
can remove their own role from a repository.

## Outside collaborators

An outside collaborator has a role on some of a workspace's repositories
without being a member of it. They:

- see the repositories shared with them under **Shared with you** in the
  sidebar, and only those: not the workspace's other private
  repositories, its members, settings, usage or billing. The workspace's
  page, `g1t.sh/<workspace>`, shows them its public repositories and the
  ones shared with them;
- can do on each repository what their role allows, and nothing in the
  workspace itself, such as its webhooks, secrets, tokens or integrations;
- are held to whatever the workspace asks of its members, checked when
  they are added, when they accept, and on every request after.

- can put agents to work where they have Write; the runs are charged to
  the repository's workspace, and they do not see which model ran or what
  it cost. An agent working for them is told the project's memory, never
  the workspace's.

Owners see every outside collaborator, and the repositories and roles each
has, on the **Outside collaborators** tab of the workspace's
**Settings → Members**. **Convert to member** adds one to the workspace
(see [members and roles](/guides/workspaces/#members-and-roles)); the
roles they have stay, and the base permission adds to them.

Removing a member from a workspace also removes the roles they were given
on its repositories.

## Invitations

An invitation to someone on g1t waits for them to answer, and they are
emailed a link to it.

1. Open `g1t.sh/<workspace>/<repo>/invitations`, the link in the email.
2. Choose **Accept invitation** or **Decline**.

Accepting gives you the role; you then find the repository under **Shared
with you**. An invitation lasts **7 days**, then expires. Until it is
answered, it is listed as pending on the repository's **Settings → Access**,
where someone with Admin can change its role or **Revoke** it. To invite
someone again after an expired or declined invitation, add them again.

## Agents

An agent works with the role of the person it acts for, on the
repository it works in, and never more than Write. An owner's agent has
Write, not Admin. So an agent working for you can push, open and merge
pull requests where you can, and cannot change settings, protection,
webhooks or secrets, even when you can.

An agent's credential can never change who has access: it cannot add,
remove or invite anyone, answer an invitation, or change the base
permission. When the person it works for loses their role on the
repository, or leaves the workspace, the agent loses it too. See
[credentials](/guides/g1t-agents/#credentials).

Because putting agents to work spends compute, it needs Write. Someone with
Read or Triage who mentions or assigns an agent is told so, and nothing
starts.

## Through the API

Every route is in the [API reference](/reference/api/). Each has an MCP
tool of the same name.

| Route | MCP tool | What it does | Who |
| --- | --- | --- | --- |
| `GET /repos/{owner}/{name}/collaborators` | `list_collaborators` | Everyone with access to a repository, their role and where it comes from. | Write |
| `GET /repos/{owner}/{name}/collaborators/{username}/permission` | `get_collaborator_permission` | One person's role on a repository and what it lets them do. | Write, or about yourself |
| `POST /repos/{owner}/{name}/collaborators` | `add_collaborator` | Give someone a role. Body: `invitee` (a username or an email address) and `role`. Answers with `result`: `granted` or `invited`. | Admin |
| `PATCH /repos/{owner}/{name}/collaborators/{username}` | `update_collaborator` | Change someone's role, or a pending invitation's. Body: `role`. | Admin |
| `DELETE /repos/{owner}/{name}/collaborators/{username}` | `remove_collaborator` | Take away the role given to someone on the repository. | Admin, or yourself |
| `GET /repos/{owner}/{name}/invitations` | `list_repo_invitations` | A repository's pending invitations. | Admin |
| `DELETE /repos/{owner}/{name}/invitations/{id}` | `revoke_repo_invitation` | Withdraw a pending invitation. | Admin |
| `GET /user/repository_invitations` | `list_my_repo_invitations` | The invitations waiting for you. | You |
| `PATCH /user/repository_invitations/{id}` | `accept_repo_invitation` | Accept one. | You |
| `DELETE /user/repository_invitations/{id}` | `decline_repo_invitation` | Decline one. | You |
| `PATCH /workspaces/{workspace}` | `set_base_permission` | Set the base permission. Body: `base_permission`: `none`, `read`, `write` or `admin`. | Owners |
| `GET /workspaces/{workspace}/outside_collaborators` | `list_outside_collaborators` | A workspace's outside collaborators and the repositories each can reach. | Owners |

Changing who has access, answering an invitation and setting the base
permission are for people, signed in or with a personal access token.

Roles are written `read`, `triage`, `write`, `maintain` and `admin`.

```sh
curl https://api.g1t.sh/repos/acme/rocket/collaborators/ada/permission \
  -H "Authorization: Bearer $G1T_TOKEN"
```

```json
{
  "username": "ada",
  "role": "write",
  "source": "base",
  "capabilities": ["read", "participate", "triage", "push", "merge", "run"]
}
```

`source` is `owner`, `base` or `direct`.

## Webhooks and the audit log

A change to someone's role on a repository is sent to
[webhooks](/guides/webhooks/) as one of:

| Event | When |
| --- | --- |
| `repo.collaborator_added` | Someone was given a role on the repository, or accepted an invitation. |
| `repo.collaborator_role_changed` | Their role changed. `data.role` and `data.previous_role`. |
| `repo.collaborator_removed` | Their role was taken away. |

Each has `data.username`, `data.role` and `data.previous_role`.

The workspace's [audit log](/guides/audit-log/) records the same changes
under those names, and also `repo.invitation_created`,
`repo.invitation_revoked` and `workspace.base_permission_changed`.
