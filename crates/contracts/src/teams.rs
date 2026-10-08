//! Teams: groups of a workspace's members, given roles on repositories
//! together, mentioned together and asked to review together.
//!
//! **Who is in one.** A team has **maintainers**, who manage its people
//! and settings, and **members**. Only members of the workspace can be in
//! its teams; leaving the workspace takes a person out of all of them.
//! Owners of the workspace manage every team, whether or not they are in
//! it.
//!
//! **Visibility.** A **visible** team is seen by every member of the
//! workspace. A **secret** team is seen only by its own people and the
//! workspace's owners. Secret teams cannot be nested.
//!
//! **Nesting.** A team can have a parent. A child team inherits its
//! parent's roles on repositories (and its parent's parent's), and a
//! mention or review request for the parent reaches the child teams'
//! people too. A team's own people never get anything from its children.
//!
//! **Repository access.** A team is given a [`RepoRole`] on a repository
//! as a person is: a row in `repo_grants` whose principal is the team.
//! Identity resolves it into the same [`RepoGrant`](crate::access::RepoGrant)s
//! on every person in the team and in its child teams, so `access::can`
//! decides with it as with any other grant: the highest role wins.
//!
//! **Review requests.** A pull request can ask a team to review it. With
//! [`ReviewAssignment`] off, everyone in the team is asked. With it on,
//! g1t picks `count` people from it (never the pull request's author) and
//! asks them; the team stays shown as requested beside them.
//!
//! Every method is served by identity at `POST /rpc/<method>`. Changing a
//! team is for people, signed in or with a personal access token; never
//! an agent's or a workspace's token.

use serde::{Deserialize, Serialize};

use crate::{Role, User};
use crate::access::RepoRole;
use crate::repos::RepoPath;

/// The most teams one workspace can have.
pub const MAX_TEAMS: u32 = 500;
/// The longest team name.
pub const MAX_NAME_LENGTH: usize = 80;
/// The longest description.
pub const MAX_DESCRIPTION_LENGTH: usize = 280;
/// How deep teams can nest: a team, its child, and so on.
pub const MAX_DEPTH: usize = 8;
/// The most people review assignment picks for one request.
pub const MAX_ASSIGNED: u32 = 10;

/// Who can see a team.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamVisibility {
    /// Every member of the workspace.
    #[default]
    Visible,
    /// The team's own people and the workspace's owners.
    Secret,
}

impl TeamVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            TeamVisibility::Visible => "visible",
            TeamVisibility::Secret => "secret",
        }
    }

    pub fn parse(text: &str) -> Option<TeamVisibility> {
        match text.trim().to_ascii_lowercase().as_str() {
            "visible" | "closed" => Some(TeamVisibility::Visible),
            "secret" => Some(TeamVisibility::Secret),
            _ => None,
        }
    }
}

/// Who may create a workspace's teams: a workspace setting, changed by
/// its owners (`set_team_creation`). Stored in `workspaces.team_creation`,
/// NULL for the default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamCreation {
    /// Any member with a confirmed email address.
    #[default]
    Members,
    /// The workspace's owners only.
    Owners,
}

impl TeamCreation {
    pub const ALL: [TeamCreation; 2] = [TeamCreation::Members, TeamCreation::Owners];

    pub fn as_str(self) -> &'static str {
        match self {
            TeamCreation::Members => "members",
            TeamCreation::Owners => "owners",
        }
    }

    pub fn parse(text: &str) -> Option<TeamCreation> {
        match text.trim().to_ascii_lowercase().as_str() {
            "members" | "member" | "any" => Some(TeamCreation::Members),
            "owners" | "owner" => Some(TeamCreation::Owners),
            _ => None,
        }
    }

    /// Whether someone with `role` in the workspace may create a team.
    pub fn allows(self, role: Role) -> bool {
        match self {
            TeamCreation::Members => true,
            TeamCreation::Owners => role == Role::Owner,
        }
    }
}

/// `set_team_creation`: who may create the workspace's teams. Owners
/// only, as a person. Returns `Outcome<TeamCreation>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetTeamCreationArgs {
    pub actor: User,
    pub slug: String,
    pub team_creation: TeamCreation,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// A person's place in a team.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRole {
    Member,
    /// Manages the team's people and settings.
    Maintainer,
}

impl TeamRole {
    pub fn as_str(self) -> &'static str {
        match self {
            TeamRole::Member => "member",
            TeamRole::Maintainer => "maintainer",
        }
    }

    pub fn parse(text: &str) -> Option<TeamRole> {
        match text.trim().to_ascii_lowercase().as_str() {
            "member" => Some(TeamRole::Member),
            "maintainer" => Some(TeamRole::Maintainer),
            _ => None,
        }
    }
}

/// How review assignment picks people.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAlgorithm {
    /// Whoever was asked least recently by this team goes first.
    #[default]
    RoundRobin,
    /// Whoever has the fewest pull requests waiting on their review goes
    /// first.
    LoadBalance,
}

impl ReviewAlgorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            ReviewAlgorithm::RoundRobin => "round_robin",
            ReviewAlgorithm::LoadBalance => "load_balance",
        }
    }

    pub fn parse(text: &str) -> Option<ReviewAlgorithm> {
        match text.trim().to_ascii_lowercase().as_str() {
            "round_robin" => Some(ReviewAlgorithm::RoundRobin),
            "load_balance" => Some(ReviewAlgorithm::LoadBalance),
            _ => None,
        }
    }
}

/// What happens when a team is asked to review a pull request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewAssignment {
    /// Off: everyone in the team is asked. On: `count` people are picked.
    pub enabled: bool,
    pub algorithm: ReviewAlgorithm,
    /// How many people to pick, 1 to [`MAX_ASSIGNED`]. People from the team
    /// already asked count towards it.
    pub count: u32,
    /// Leave out anyone with `busy_at` or more open pull requests waiting
    /// on their review.
    pub skip_busy: bool,
    pub busy_at: u32,
    /// Also pick from the people of its child teams.
    pub include_child_teams: bool,
    /// Usernames never picked.
    #[serde(default)]
    pub excluded: Vec<String>,
    /// Also tell the rest of the team when people are picked.
    pub notify_team: bool,
}

impl Default for ReviewAssignment {
    fn default() -> Self {
        ReviewAssignment {
            enabled: false,
            algorithm: ReviewAlgorithm::RoundRobin,
            count: 1,
            skip_busy: false,
            busy_at: 5,
            include_child_teams: false,
            excluded: Vec::new(),
            notify_team: false,
        }
    }
}

impl ReviewAssignment {
    /// The same, with every number within bounds and the usernames
    /// lowercased, each once.
    pub fn bounded(mut self) -> Self {
        self.count = self.count.clamp(1, MAX_ASSIGNED);
        self.busy_at = self.busy_at.clamp(1, 100);
        let mut excluded: Vec<String> = Vec::new();
        for name in self.excluded {
            let name = name.trim().trim_start_matches('@').to_lowercase();
            if !name.is_empty() && !excluded.contains(&name) {
                excluded.push(name);
            }
        }
        excluded.truncate(100);
        self.excluded = excluded;
        self
    }
}

/// A team as another names it: its parent, or a child.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamRef {
    pub slug: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Team {
    pub id: String,
    /// Its workspace's slug.
    pub workspace: String,
    /// Its name in URLs and mentions: `@<workspace>/<slug>`.
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub visibility: TeamVisibility,
    pub parent: Option<TeamRef>,
    /// Whether its people are notified when it is mentioned.
    pub notify: bool,
    pub review_assignment: ReviewAssignment,
    /// Its own people, not counting child teams'.
    pub members_count: u32,
    /// Repositories it has a role on itself, not counting inherited ones.
    pub repos_count: u32,
    pub child_teams_count: u32,
    /// The viewer's place in it, if any.
    pub viewer_role: Option<TeamRole>,
    /// Whether the viewer may change it: an owner of the workspace, or one
    /// of its maintainers.
    pub can_manage: bool,
    /// RFC 3339.
    pub created_at: String,
    pub updated_at: String,
}

impl Team {
    /// How it is mentioned: `@acme/backend`.
    pub fn handle(&self) -> String {
        format!("@{}/{}", self.workspace, self.slug)
    }
}

/// One person in a team.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamMember {
    pub username: String,
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub role: TeamRole,
    /// The child team they are in, when listed through one; null for the
    /// team's own people.
    pub via: Option<String>,
}

/// A repository a team has a role on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamRepo {
    /// `workspace/name`.
    pub repo: String,
    pub repo_id: String,
    pub role: RepoRole,
    /// The parent team it comes from, by slug, when the team inherits it.
    pub inherited_from: Option<String>,
}

/// A team with a role on a repository, as its Access settings list it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoTeam {
    pub slug: String,
    pub name: String,
    pub role: RepoRole,
    pub members_count: u32,
    pub visibility: TeamVisibility,
}

/// A team as services need it to notify or ask its people: everyone in it,
/// and its settings. Never shown as is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedTeam {
    pub id: String,
    pub workspace: String,
    pub slug: String,
    pub name: String,
    pub visibility: TeamVisibility,
    pub notify: bool,
    pub review_assignment: ReviewAssignment,
    /// Its own people.
    pub members: Vec<TeamPerson>,
    /// The people of its child teams (and theirs) who are not its own.
    pub child_members: Vec<TeamPerson>,
    /// Its role on the repository asked about, its own or inherited.
    pub repo_role: Option<RepoRole>,
    /// Whether the person asked about (`asker`) may see it, and so mention
    /// it or ask it to review: a member of its workspace, and for a secret
    /// team, in it or an owner.
    #[serde(default)]
    pub asker_sees: bool,
}

impl ResolvedTeam {
    /// Everyone a mention or a request reaches: its own people, then its
    /// child teams'.
    pub fn everyone(&self) -> impl Iterator<Item = &TeamPerson> {
        self.members.iter().chain(self.child_members.iter())
    }

    pub fn handle(&self) -> String {
        format!("@{}/{}", self.workspace, self.slug)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamPerson {
    pub id: String,
    pub username: String,
}

/// A team's slug from its name: lowercase letters, digits and single
/// hyphens, as mentions spell it. `None` when nothing is left.
pub fn slug_of(name: &str) -> Option<String> {
    let mut slug = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-').chars().take(60).collect::<String>();
    let slug = slug.trim_end_matches('-').to_owned();
    is_valid_slug(&slug).then_some(slug)
}

/// Whether `slug` is a team slug: 1 to 60 lowercase letters, digits and
/// single hyphens, not starting or ending with one.
pub fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 60
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
}

/// `@workspace/team` as written, split; `None` if it is not that shape.
pub fn parse_handle(text: &str) -> Option<(String, String)> {
    let text = text.trim().strip_prefix('@')?;
    let (workspace, slug) = text.split_once('/')?;
    let workspace = workspace.to_lowercase();
    let slug = slug.to_lowercase();
    (crate::is_valid_namespace(&workspace) && is_valid_slug(&slug)).then_some((workspace, slug))
}

// --- Identity methods ---------------------------------------------------------

/// `list_teams`: the teams of a workspace the viewer can see, theirs first,
/// then by name. Members only. `query` narrows by name or slug. Returns
/// `Outcome<Vec<Team>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListTeamsArgs {
    pub viewer: crate::Viewer,
    pub workspace: String,
    #[serde(default)]
    pub query: Option<String>,
}

/// `get_team`, `child_teams`, `team_repos`: one team, its child teams, or
/// the repositories it has a role on (its own and inherited), as the
/// viewer may see them. `team_members` takes `include_child_teams`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TeamArgs {
    pub viewer: crate::Viewer,
    pub workspace: String,
    pub team: String,
    /// `team_members` only: also list the people of child teams.
    #[serde(default)]
    pub include_child_teams: bool,
}

/// `create_team`. Members may create a team, unless the workspace's
/// [`TeamCreation`] says owners only, and become its maintainer; a team
/// with a parent needs an owner, or a maintainer of the parent. Returns
/// `Outcome<Team>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTeamArgs {
    pub actor: User,
    pub workspace: String,
    pub name: String,
    /// Defaults to one made from the name.
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub visibility: Option<TeamVisibility>,
    /// The parent's slug.
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub notify: Option<bool>,
    /// People to add as members, by username, besides the creator.
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `update_team`: what is given changes; the rest stays. `parent` set to an
/// empty string takes the team out from under its parent. Owners and the
/// team's maintainers. Returns `Outcome<Team>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UpdateTeamArgs {
    pub actor: User,
    pub workspace: String,
    pub team: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub visibility: Option<TeamVisibility>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub notify: Option<bool>,
    #[serde(default)]
    pub review_assignment: Option<ReviewAssignment>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `delete_team`: its child teams move up to its parent, and the roles it
/// gave go with it. Owners and the team's maintainers. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteTeamArgs {
    pub actor: User,
    pub workspace: String,
    pub team: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `set_team_member`: adds a member of the workspace to a team, or changes
/// their role in it. Owners and the team's maintainers. Returns
/// `Outcome<TeamMember>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetTeamMemberArgs {
    pub actor: User,
    pub workspace: String,
    pub team: String,
    pub username: String,
    pub role: TeamRole,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `remove_team_member`: owners and the team's maintainers; anyone may
/// leave a team themselves. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoveTeamMemberArgs {
    pub actor: User,
    pub workspace: String,
    pub team: String,
    pub username: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `set_team_repo`: gives a team a role on a repository of its workspace,
/// or changes it. Needs Admin on the repository. Returns
/// `Outcome<TeamRepo>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetTeamRepoArgs {
    pub actor: User,
    pub workspace: String,
    pub team: String,
    pub repo: RepoPath,
    pub role: RepoRole,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `remove_team_repo`: takes a team's role on a repository away. Admin on
/// the repository, an owner, or one of the team's maintainers. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoveTeamRepoArgs {
    pub actor: User,
    pub workspace: String,
    pub team: String,
    pub repo: RepoPath,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `user_teams`: the teams `username` is in within a workspace, as the
/// viewer may see them. Members only. Returns `Outcome<Vec<Team>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UserTeamsArgs {
    pub viewer: crate::Viewer,
    pub workspace: String,
    pub username: String,
}

/// `team_memberships`: for each member of a workspace, the teams they are
/// in that the viewer can see, for the Members page. Members only.
/// Returns `Outcome<Vec<MemberTeams>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TeamMembershipsArgs {
    pub viewer: crate::Viewer,
    pub workspace: String,
}

/// One person's teams in a workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberTeams {
    pub username: String,
    pub teams: Vec<TeamRef>,
}

/// `resolve_teams`: for services. Each team named `workspace/slug` (or
/// `@workspace/slug`) that exists, with everyone in it and, given
/// `repo_id`, its role on that repository. Missing teams are left out.
/// Returns `Vec<ResolvedTeam>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ResolveTeamsArgs {
    pub teams: Vec<String>,
    #[serde(default)]
    pub repo_id: Option<String>,
    /// A user id, for `asker_sees`.
    #[serde(default)]
    pub asker: Option<String>,
}

/// One owner a CODEOWNERS file names, as identity resolved it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedOwner {
    pub owner: crate::codeowners::Owner,
    pub check: crate::codeowners::OwnerCheck,
    /// Who may answer for it, by username: the person, the account a
    /// confirmed address belongs to, or everyone in a team and its child
    /// teams. Empty when it did not resolve.
    pub members: Vec<String>,
    /// For a team: the team, as `workspace/slug`, after `@org/team` was
    /// mapped to the repository's workspace.
    #[serde(default)]
    pub team: Option<String>,
}

/// `resolve_owners`: for services. Resolves the owners a CODEOWNERS file
/// names on a repository: accounts, teams of the repository's workspace
/// (`@org/team` with an `org` that is not a g1t workspace means the
/// repository's own workspace), and confirmed email addresses, checking
/// each has the Write role or higher on it. `g1t` resolves to itself.
/// Returns `Vec<ResolvedOwner>`, in the order asked.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolveOwnersArgs {
    pub repo_id: String,
    /// The repository's workspace, by slug.
    pub workspace: String,
    pub owners: Vec<crate::codeowners::Owner>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn who_may_create_teams() {
        assert_eq!(TeamCreation::default(), TeamCreation::Members);
        assert!(TeamCreation::Members.allows(Role::Member) && TeamCreation::Members.allows(Role::Owner));
        assert!(!TeamCreation::Owners.allows(Role::Member) && TeamCreation::Owners.allows(Role::Owner));
        for setting in TeamCreation::ALL {
            assert_eq!(TeamCreation::parse(setting.as_str()), Some(setting));
            assert_eq!(serde_json::to_value(setting).unwrap(), setting.as_str());
        }
        assert_eq!(TeamCreation::parse(" Owners "), Some(TeamCreation::Owners));
        assert_eq!(TeamCreation::parse("maintainers"), None);
    }

    #[test]
    fn slugs_come_from_names() {
        assert_eq!(slug_of("Backend").as_deref(), Some("backend"));
        assert_eq!(slug_of("  Web & Mobile  ").as_deref(), Some("web-mobile"));
        assert_eq!(slug_of("SRE / On-call").as_deref(), Some("sre-on-call"));
        assert_eq!(slug_of("!!!"), None);
        assert_eq!(slug_of(&"a".repeat(80)).map(|slug| slug.len()), Some(60));
        assert!(is_valid_slug("platform-2"));
        assert!(!is_valid_slug("Platform") && !is_valid_slug("-a") && !is_valid_slug("a--b") && !is_valid_slug(""));
    }

    #[test]
    fn handles_name_a_workspace_and_a_team() {
        assert_eq!(parse_handle("@acme/backend"), Some(("acme".into(), "backend".into())));
        assert_eq!(parse_handle("@Acme/Backend"), Some(("acme".into(), "backend".into())));
        assert_eq!(parse_handle("acme/backend"), None);
        assert_eq!(parse_handle("@acme"), None);
        assert_eq!(parse_handle("@acme/a/b"), None);
    }

    #[test]
    fn words_read_back() {
        for visibility in [TeamVisibility::Visible, TeamVisibility::Secret] {
            assert_eq!(TeamVisibility::parse(visibility.as_str()), Some(visibility));
            assert_eq!(serde_json::to_value(visibility).unwrap(), visibility.as_str());
        }
        for role in [TeamRole::Member, TeamRole::Maintainer] {
            assert_eq!(TeamRole::parse(role.as_str()), Some(role));
            assert_eq!(serde_json::to_value(role).unwrap(), role.as_str());
        }
        for algorithm in [ReviewAlgorithm::RoundRobin, ReviewAlgorithm::LoadBalance] {
            assert_eq!(ReviewAlgorithm::parse(algorithm.as_str()), Some(algorithm));
            assert_eq!(serde_json::to_value(algorithm).unwrap(), algorithm.as_str());
        }
        assert!(TeamRole::Member < TeamRole::Maintainer);
    }

    #[test]
    fn review_assignment_is_kept_within_bounds() {
        let wild = ReviewAssignment {
            count: 0,
            busy_at: 0,
            excluded: vec!["@Ana".into(), "ana".into(), " ".into(), "bo".into()],
            ..ReviewAssignment::default()
        }
        .bounded();
        assert_eq!(wild.count, 1);
        assert_eq!(wild.busy_at, 1);
        assert_eq!(wild.excluded, vec!["ana", "bo"]);
        assert_eq!(ReviewAssignment { count: 50, ..ReviewAssignment::default() }.bounded().count, MAX_ASSIGNED);
    }
}
