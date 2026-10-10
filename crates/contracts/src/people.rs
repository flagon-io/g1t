//! People: a workspace's directory of everyone in it, people and agents,
//! and what each person's place is: a title, who they report to, and what
//! they own. Kept by identity beside membership; agents come from the
//! agents service, which identity names only by id.
//!
//! **Profiles.** A member's title and what they own are theirs to write,
//! and the workspace's owners can write anyone's. Who someone reports to
//! (their manager) is set by owners: always another member, never
//! themselves, and never a loop.
//!
//! **Agents on teams.** A team can have agents as well as people: mixed,
//! people only or agents only. An agent is on a team when it was added to
//! it (`set_team_agent`) and on the team its own profile names, its home
//! team. Agents are told who is on their visible teams every turn
//! (`agent_teams`).
//!
//! Every method is served by identity at `POST /rpc/<method>`.

use serde::{Deserialize, Serialize};

use crate::teams::{TeamChannel, TeamLead, TeamRef, TeamRole, TeamVisibility};
use crate::{Role, User};

/// The longest title.
pub const MAX_TITLE_LENGTH: usize = 80;
/// The most things one person owns, as their profile lists them.
pub const MAX_OWNS: usize = 8;
/// The longest of them.
pub const MAX_OWNS_LENGTH: usize = 60;
/// How far up a reporting line is followed, looking for a loop.
pub const MAX_CHAIN: usize = 64;

/// One member, as the directory, their profile and the org chart show them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryPerson {
    pub user_id: String,
    pub username: String,
    /// The username as its owner wrote it, when that differs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_username: Option<String>,
    pub name: Option<String>,
    pub avatar: Option<String>,
    /// From their public profile.
    pub bio: Option<String>,
    pub location: Option<String>,
    pub pronouns: Option<String>,
    /// An IANA name, such as `America/Denver`, for their local time.
    pub timezone: Option<String>,
    /// Owner or member.
    pub role: Role,
    /// Their title in this workspace.
    pub title: Option<String>,
    /// Who they report to, by username.
    pub manager: Option<String>,
    /// What they own: a few short phrases.
    pub owns: Vec<String>,
    /// When they joined the workspace (RFC 3339).
    pub joined_at: String,
}

/// One person on a team, as the directory names them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamPersonRef {
    pub username: String,
    pub role: TeamRole,
}

/// A team as the directory and the org chart need it: who is on it, by
/// username and agent id, and who leads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryTeam {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub visibility: TeamVisibility,
    pub parent: Option<TeamRef>,
    pub lead: Option<TeamLead>,
    pub channel: Option<TeamChannel>,
    pub budget_micros: Option<i64>,
    /// Its own people, not its child teams'.
    pub people: Vec<TeamPersonRef>,
    /// The agents added to it, by id. Agents whose home team it is are
    /// on it too; the agents service names those.
    pub agent_ids: Vec<String>,
    /// Repositories it has a role on itself.
    pub repos_count: u32,
}

/// `people_directory`: everyone in a workspace and its teams, as the
/// viewer may see them (secret teams only for their people and owners).
/// Members only. Returns `Outcome<PeopleDirectory>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct PeopleArgs {
    pub viewer: crate::Viewer,
    pub workspace: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeopleDirectory {
    pub people: Vec<DirectoryPerson>,
    pub teams: Vec<DirectoryTeam>,
    /// What members get on every repository: `none`, `read`, `write` or `admin`.
    pub base_permission: String,
    /// Whether the viewer owns the workspace: they can set anyone's
    /// title, manager and what they own.
    pub can_manage: bool,
}

/// `set_member_profile`: what is given changes; the rest stays. `manager`
/// set to an empty string clears it. Returns `Outcome<DirectoryPerson>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SetMemberProfileArgs {
    pub actor: User,
    pub workspace: String,
    pub username: String,
    #[serde(default)]
    pub title: Option<String>,
    /// A member's username, or an empty string for none. Owners only.
    #[serde(default)]
    pub manager: Option<String>,
    #[serde(default)]
    pub owns: Option<Vec<String>>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// A title as stored: trimmed, at most [`MAX_TITLE_LENGTH`] characters,
/// `None` when nothing is left.
pub fn clean_title(title: &str) -> Option<String> {
    let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_TITLE_LENGTH).collect();
    let title = title.trim().to_owned();
    (!title.is_empty()).then_some(title)
}

/// What someone owns, as stored: each phrase trimmed and cut to
/// [`MAX_OWNS_LENGTH`], blanks and repeats (ignoring case) left out, at
/// most [`MAX_OWNS`].
pub fn clean_owns(owns: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for phrase in owns {
        let phrase: String = phrase.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_OWNS_LENGTH).collect();
        let phrase = phrase.trim().trim_end_matches(['.', ',', ';']).trim().to_owned();
        if phrase.is_empty() || out.iter().any(|kept| kept.eq_ignore_ascii_case(&phrase)) {
            continue;
        }
        out.push(phrase);
        if out.len() == MAX_OWNS {
            break;
        }
    }
    out
}

/// What may change on someone's profile: their title and what they own
/// by themselves or an owner; their manager by an owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileField {
    Title,
    Owns,
    Manager,
}

/// Whether `actor` may change `field` on someone's profile.
pub fn may_edit_profile(field: ProfileField, is_self: bool, owner: bool) -> bool {
    match field {
        ProfileField::Title | ProfileField::Owns => is_self || owner,
        ProfileField::Manager => owner,
    }
}

/// Whether making `manager` the manager of `person` would make a loop.
/// `manager_of` gives each person's current manager.
pub fn makes_loop(person: &str, manager: &str, manager_of: impl Fn(&str) -> Option<String>) -> bool {
    if person == manager {
        return true;
    }
    let mut at = manager.to_owned();
    for _ in 0..MAX_CHAIN {
        match manager_of(&at) {
            Some(next) if next == person => return true,
            Some(next) => at = next,
            None => return false,
        }
    }
    // A chain this long is treated as a loop rather than followed further.
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn titles_are_tidied() {
        assert_eq!(clean_title("  Staff   Engineer "), Some("Staff Engineer".to_owned()));
        assert_eq!(clean_title("   "), None);
        assert_eq!(clean_title(&"a".repeat(200)).map(|t| t.len()), Some(MAX_TITLE_LENGTH));
    }

    #[test]
    fn what_someone_owns_is_kept_short_and_once() {
        let owns = clean_owns(&[
            " storefront ".into(),
            "Storefront".into(),
            "".into(),
            "the release process.".into(),
            "x".repeat(100),
        ]);
        assert_eq!(owns[0], "storefront");
        assert_eq!(owns[1], "the release process");
        assert_eq!(owns[2].len(), MAX_OWNS_LENGTH);
        assert_eq!(owns.len(), 3);
        let many: Vec<String> = (0..20).map(|i| format!("thing {i}")).collect();
        assert_eq!(clean_owns(&many).len(), MAX_OWNS);
    }

    #[test]
    fn people_write_their_own_and_owners_set_managers() {
        assert!(may_edit_profile(ProfileField::Title, true, false));
        assert!(may_edit_profile(ProfileField::Owns, false, true));
        assert!(!may_edit_profile(ProfileField::Owns, false, false));
        assert!(!may_edit_profile(ProfileField::Manager, true, false));
        assert!(may_edit_profile(ProfileField::Manager, false, true));
    }

    #[test]
    fn reporting_lines_never_loop() {
        // ana -> priya -> chase
        let managers: HashMap<&str, &str> = HashMap::from([("ana", "priya"), ("priya", "chase")]);
        let of = |id: &str| managers.get(id).map(|m| (*m).to_owned());
        assert!(makes_loop("chase", "ana", of));
        assert!(makes_loop("priya", "priya", of));
        assert!(!makes_loop("ana", "chase", of));
        assert!(!makes_loop("dev", "priya", of));
    }
}
