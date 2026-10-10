---
title: Access and roles
description: The five repository roles and what each can do, the base permission members get, the Admin role a repository's creator gets, security managers, roles through teams, outside collaborators and invitations, who may manage deploy keys, and what agents may do on a person's behalf.
---

Everyone who can work in a repository has a role on it. The role says what
they can do there, from reading it to managing who else has access. A
workspace gives its members a role on every one of its repositories, a
repository can give anyone a role of their own: a member who needs more
there, or someone outside the workspace, and it can give a
[team](/guides/teams/) a role that everyone in the team has.

## The roles

| Role | For |
| --- | --- |
| **Read** | Read and clone; open issues and pull requests, and comment. |
| **Triage** | Read, and manage issues and pull requests: apply labels and milestones, assign, close. |
| **Write** | Triage, and push, merge, manage labels and milestones, see security alerts, and put agents to work. |
| **Maintain** | Write, and manage the repository's settings and topics. |
| **Admin** | Everything: branch protection and rulesets, webhooks, secrets, deployments, security settings, who has access, and the repository's name, visibility and archiving. |

Each role has everything the one above it has.

## What each role can do

| | Read | Triage | Write | Maintain | Admin |
| --- | --- | --- | --- | --- | --- |
| See code, issues and pull requests; clone and fetch | Yes | Yes | Yes | Yes | Yes |
| Open issues and pull requests, and comment | Yes | Yes | Yes | Yes | Yes |
| Apply labels and milestones; assign, close and reopen issues and pull requests | | Yes | Yes | Yes | Yes |
| Push to branches that are not protected | | | Yes | Yes | Yes |
| Merge pull requests and use the merge queue | | | Yes | Yes | Yes |
| Create, edit and delete labels and milestones | | | Yes | Yes | Yes |
| See and dismiss security alerts | | | Yes | Yes | Yes |
| Assign agents and start runs, plans and workflows | | | Yes | Yes | Yes |
| Change the description, topics, and pull request and agent settings | | | | Yes | Yes |
| Change branch protection, rulesets and guardrails | | | | | Yes |
| Change security settings, custom patterns and bypass reviews | | | | | Yes |
| Manage webhooks, secrets, variables, deployments and domains | | | | | Yes |
| Manage who has access, invitations and deploy keys | | | | | Yes |
| Rename, archive and change the default branch | | | | | Yes |
| Change visibility | | | | | Yes, if the [member privileges](/guides/workspaces/#member-privileges) allow |
| Transfer or delete the repository | | | | | Owners, or Admins if the member privileges allow |

Everyone can edit and delete their own comments. Maintain and Admin can
edit and delete anyone's; see
[editing and deleting comments](/guides/pull-requests/#editing-and-deleting-comments).

Changing a repository's visibility, transferring it and deleting it also
depend on its workspace's [member privileges](/guides/workspaces/#member-privileges).
By default, a member with Admin can change visibility, and only an owner
can transfer or delete. Someone given Admin on one repository without being
a member, an outside collaborator, can do none of the three.

Some things work a little differently on g1t:

- Whoever opened an issue or pull request can still edit, label and close
  their own, whatever their role.
- A [protected branch](/guides/git/#protected-branches) takes no pushes
  from anyone, Maintain and Admin included. To let a role push, list it as
  a bypass actor of a [ruleset](/guides/rules/) instead.
- Applying a label the repository does not have yet creates it, for
  someone with Write.

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
   [add someone to a repository](#add-someone-to-a-repository). Whoever
   creates a repository is given Admin on it this way, so it stays theirs
   to run whatever the base permission is.
4. **Security manager.** A member who is one of the workspace's
   [security managers](/guides/workspaces/#roles-that-add-to-a-member)
   has Read on every repository, and can see and manage its security
   alerts and security settings whatever their role.
5. **Your teams.** The role each [team](/guides/teams/) you are in has on
   that repository, and the roles of that team's parent teams, which child
   teams inherit. See [repository access](/guides/teams/#repository-access).
6. **Public.** Anyone, signed in or not, can read a public repository.

The highest wins. A member whose base permission is Read and who is given
Maintain on one repository has Maintain there and Read everywhere else. A
role lower than what you already have changes nothing. When a role given to
you and a team's role are the same, the one given to you is shown as where
it comes from.

A workspace's own [access token](/guides/workspaces/#workspace-access-tokens)
has Write on its workspace's repositories, as a member does, and none on any
other. An owner can give one Admin instead, only when making it. A workflow
job's token and a [deploy key](/guides/git/#deploy-keys) have Write at most,
on their one repository. What is for people only, such as transferring or
deleting a repository, still needs a person.

A [personal access token](/guides/authentication/#where-a-token-reaches)
made for one workspace has your role only in that workspace's repositories
that it reaches: all of them, the ones chosen, or none. Everywhere else it
reads public repositories, as anyone can, and does nothing more. A token
made for all your workspaces has your role wherever you have one, unless a
workspace's
[rules for tokens](/guides/authentication/#a-workspaces-rules-for-tokens)
keep it out.

### Private repositories

Someone without at least Read on a private repository cannot tell it
exists: its pages answer 404, and the API answers `404` with
`Repository not found.`, the same as for a repository that does not exist.
Someone who can read it but lacks the role for what they tried gets `403`
and a message naming the role they need:

```text
You need the Admin role or higher on acme/rocket to do that.
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
| **Read** | Read on every repository. What a new workspace starts with. |
| **Write** | Write on every repository. |
| **Admin** | Admin on every repository. Transferring and deleting stay with owners unless the member privileges allow them. |

Owners always have Admin, whatever it says. Only owners can change it:

1. Open **People → Members and invites**, `g1t.sh/<workspace>/-/members#base-permission`. Every member can see it; owners manage it.
2. Under **Base permission**, choose one.

It takes effect on everyone's next request. To give one member more on
one repository, give them a role there; to give them less, lower the base
permission and give roles to the people who need them. Whoever creates a
repository keeps Admin on it however low the base permission is.

### What changed for existing members

A workspace made from 2026-10-08 starts at **Read**. One made before keeps
the base permission it had, **Write** unless an owner changed it.

Before roles, every member of a workspace could also change a repository's
settings, its branch protection and guardrails, webhooks, secrets and
variables, deployments and domains. With Write, members keep pushing,
merging and putting agents to work; changing settings now needs Maintain,
and branch protection, rulesets, guardrails and the rest Admin. Owners
have Admin, so they keep all of it.

On 2026-10-08 the roles were brought in line with the table above:

- Branch protection, rulesets and guardrails moved from Maintain to Admin.
- Creating, editing and deleting labels and milestones moved from Triage
  to Write; Triage still applies them.
- Seeing and dismissing security alerts, secrets included, takes Write;
  changing security settings and custom patterns takes Admin.
- Whoever made each existing repository and is still a member of its
  workspace was given Admin on it, unless they had it already.

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
role and where it comes from: owner, the base permission, a role given to
them, or **Through team** and the team's slug. **Teams with access** lists the
teams given a role on it, with how many people each has. People with Write
or Maintain can see the lists; changing them needs Admin.

Giving a role to someone outside the workspace takes an owner when the
workspace's [member privileges](/guides/workspaces/#member-privileges) turn
off **Repository admins can add outside collaborators**.

Someone with Admin can give a team a role under **Teams with access**:
pick the team and its role, and add it. Only the workspace's own teams can
be added. See [teams](/guides/teams/#repository-access).

What happens depends on who they are:

| Who | What happens |
| --- | --- |
| A member of the workspace | They have the role at once. It matters only where it is higher than the base permission. |
| Someone else on g1t | They are sent an [invitation](#invitations) to accept. Typing the confirmed email address of someone on g1t does the same. |
| An email address with no g1t account | g1t emails an invite code that only that address can use. Signing up with it makes their account and accepts the invitation in one step. |

An invite code to someone without an account uses one of the workspace's
granted invites, or else one of yours (see
[invites](/guides/authentication/#invites)), and works for 30 days.

On a free workspace, only the first row works: its members can be given a
role, but nobody else can be invited until the workspace starts the g1t
plan. **Add people** says **Start the plan to invite people** above the
form, and an invitation is refused with `402` (`payment_required`). An
invitation sent before cannot be accepted until then. See
[who a free workspace can add](/guides/usage-and-billing/#who-a-free-workspace-can-add).

To change someone's role, pick another beside their name. To take it away,
choose **Remove**. Removing takes away only the role given on this
repository: an owner's Admin, a member's base permission and what their
teams give them stay. Anyone
can remove their own role from a repository. Each change is confirmed
under the list; one that is refused says why on that person's row.

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
**Members and invites** page, `g1t.sh/<workspace>/-/members`. **Invite as a member** sends one an invitation to join the
workspace as a member (see [add people](/guides/workspaces/#add-people));
once they accept, the roles they have stay, and the base permission adds
to them.

Removing a member from a workspace, or their leaving it, also removes the
roles they were given on its repositories, and takes them out of its teams.

A workspace that [requires two-factor authentication](/guides/authentication/#require-two-factor-authentication)
holds its outside collaborators to it as it does its members: without it,
they cannot reach its repositories until they turn it on.

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
[credentials](/guides/working-with-g1t/#credentials).

Because putting agents to work spends compute, it needs Write. Someone with
Read or Triage who mentions or assigns an agent is told so, and nothing
starts.

## Deploy keys

A [deploy key](/guides/git/#deploy-keys) is an SSH key that lets a machine
reach one repository: Read, or Write when it was added with write access,
on that repository and no other. It is part of who has access, so managing
deploy keys needs the Admin role:

| Who | Can list, add and delete a repository's deploy keys |
| --- | --- |
| Someone with the Admin role on it, owners included | Yes |
| Someone with Maintain or less | No |
| An agent, whoever it works for | No |
| A workspace's [access token](/guides/workspaces/#workspace-access-tokens) | Only when an owner gave it Admin |
| A deploy key | No |

Adding one also needs a confirmed email address. A personal access token
needs the `access:read` scope to list and read them, and `access:admin` to
add and delete them.

## Through the API

Every route is in the [API reference](/reference/api/). Each is also an
action of an [MCP tool](/reference/mcp/): `access` for a repository's
people, its deploy keys and the base permission, `account` for invitations to you.

| Route | MCP tool and action | What it does | Who |
| --- | --- | --- | --- |
| `GET /repos/{owner}/{name}/collaborators` | `access` `list_collaborators` | Everyone with access to a repository, their role and where it comes from. | Write |
| `GET /repos/{owner}/{name}/collaborators/{username}/permission` | `access` `get_permission` | One person's role on a repository and what it lets them do. | Write, or about yourself |
| `POST /repos/{owner}/{name}/collaborators` | `access` `add_collaborator` | Give someone a role. Body: `invitee` (a username or an email address) and `role`. Answers with `result`: `granted` or `invited`. | Admin |
| `PATCH /repos/{owner}/{name}/collaborators/{username}` | `access` `update_collaborator` | Change someone's role, or a pending invitation's. Body: `role`. | Admin |
| `DELETE /repos/{owner}/{name}/collaborators/{username}` | `access` `remove_collaborator` | Take away the role given to someone on the repository. | Admin, or yourself |
| `GET /repos/{owner}/{name}/invitations` | `access` `list_invitations` | A repository's pending invitations. | Admin |
| `DELETE /repos/{owner}/{name}/invitations/{id}` | `access` `revoke_invitation` | Withdraw a pending invitation. | Admin |
| `GET /user/repository_invitations` | `account` `list_repository_invitations` | The invitations waiting for you. | You |
| `PATCH /user/repository_invitations/{id}` | `account` `accept_repository_invitation` | Accept one. | You |
| `DELETE /user/repository_invitations/{id}` | `account` `decline_repository_invitation` | Decline one. | You |
| `PUT /workspaces/{workspace}/base_permission` | `access` `set_base_permission` | Set the base permission. Body: `base_permission`: `none`, `read`, `write` or `admin`. `PATCH /workspaces/{workspace}` (`workspace` `update`) takes `base_permission` too, with the `access:admin` scope. | Owners |
| `GET /workspaces/{workspace}/outside_collaborators` | `access` `list_outside_collaborators` | A workspace's outside collaborators and the repositories each can reach. | Owners |
| `GET /repos/{owner}/{name}/keys` | `access` `list_deploy_keys` | A repository's [deploy keys](/guides/git/#deploy-keys). | Admin |
| `GET /repos/{owner}/{name}/keys/{id}` | `access` `get_deploy_key` | One deploy key. | Admin |
| `POST /repos/{owner}/{name}/keys` | `access` `add_deploy_key` | Add a deploy key. Body: `title`, `key` and `read_only` (true unless you send false). | Admin |
| `DELETE /repos/{owner}/{name}/keys/{id}` | `access` `remove_deploy_key` | Delete a deploy key. | Admin |

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
  "capabilities": ["read", "participate", "triage", "push", "merge", "manage_labels", "security_alerts", "run"]
}
```

`source` is `owner`, `base`, `direct` or `team`. In the list from
`list_collaborators`, each person also has `direct`, the role given to them
on the repository if any, and `team_role` and `team`: the highest role a
team gives them there, and that team's slug. A team's own roles are managed
through the [teams API](/guides/teams/#through-the-api).

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
`repo.invitation_revoked`, `workspace.base_permission_changed`, and
`repo.deploy_key_added` and `repo.deploy_key_removed` for
[deploy keys](#deploy-keys). A repository's creator being given Admin is
not recorded: it comes with `repo.created`.

A team's role on a repository changing is sent as `team.repo_added`,
`team.repo_role_changed` or `team.repo_removed`; see
[teams](/guides/teams/#webhooks-and-the-audit-log).
