//! People: a workspace's directory of the people in it, and what each
//! person's place is: a title and what they own. Kept by identity beside
//! membership.
//!
//! **Profiles.** A member's title and what they own are theirs to write,
//! and the workspace's owners can write anyone's.
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

/// One member, as the directory and their profile show them.
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

/// A team as the directory needs it: who is on it, by username, and who
/// leads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryTeam {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub visibility: TeamVisibility,
    pub parent: Option<TeamRef>,
    pub lead: Option<TeamLead>,
    pub channel: Option<TeamChannel>,
    /// Its own people, not its child teams'.
    pub people: Vec<TeamPersonRef>,
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
    /// title and what they own.
    pub can_manage: bool,
}

/// `set_member_profile`: what is given changes; the rest stays. Returns
/// `Outcome<DirectoryPerson>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SetMemberProfileArgs {
    pub actor: User,
    pub workspace: String,
    pub username: String,
    #[serde(default)]
    pub title: Option<String>,
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

/// What may change on someone's profile: their title and what they own,
/// by themselves or an owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileField {
    Title,
    Owns,
}

/// Whether `actor` may change `field` on someone's profile.
pub fn may_edit_profile(field: ProfileField, is_self: bool, owner: bool) -> bool {
    match field {
        ProfileField::Title | ProfileField::Owns => is_self || owner,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn people_write_their_own_and_owners_anyones() {
        assert!(may_edit_profile(ProfileField::Title, true, false));
        assert!(may_edit_profile(ProfileField::Owns, false, true));
        assert!(!may_edit_profile(ProfileField::Owns, false, false));
    }
}
