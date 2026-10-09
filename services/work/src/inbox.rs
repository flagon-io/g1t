//! What an event names, for the inbox (`g1t_contracts::inbox`): the issue
//! or pull request, its people, and the comment, read straight from the
//! rows. The events service asks as each event arrives and decides from
//! the answer who is told; nobody's access is checked here, so nothing it
//! returns is shown to anyone but the people it names, or to those who can
//! read the repository.

use g1t_contracts::credentials::Principal;
use g1t_contracts::inbox::{InboxComment, InboxSubject, InboxSubjectArgs, SubjectKind, TeamMentioned};
use g1t_contracts::is_valid_namespace;
use g1t_contracts::work::{Comment, CommentKind, Issue, Pull};
use worker::Result;

use crate::Work;
use crate::mentions::spoken;
use crate::rows::CommentRow;

/// The most people one comment notifies by name.
const MAX_MENTIONS: usize = 20;
/// About one line of a comment, shown under its title.
const EXCERPT_CHARS: usize = 140;

/// The people a comment mentions by name in its own words (not in code or
/// a quote), lowercased, each once. Not an email address, a package scope
/// or a path, and never a reserved name such as `g1t`.
pub(crate) fn people_mentioned(body: &str) -> Vec<String> {
    let text = spoken(body);
    let chars: Vec<char> = text.chars().collect();
    let mut people: Vec<String> = Vec::new();
    let mut at = 0;
    while at < chars.len() && people.len() < MAX_MENTIONS {
        if chars[at] != '@' {
            at += 1;
            continue;
        }
        let starts_clean = at == 0 || {
            let before = chars[at - 1];
            !(before.is_alphanumeric() || "._%+-/\\@`=".contains(before))
        };
        let name: String = chars[at + 1..]
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric() || **c == '-')
            .collect();
        let end = at + 1 + name.chars().count();
        // A path or a package such as `@scope/name`, or a domain.
        let ends_clean = match chars.get(end) {
            None => true,
            Some(c) if "_@/\\".contains(*c) => false,
            Some('.') => chars.get(end + 1).is_none_or(|c| !c.is_alphanumeric()),
            Some(_) => true,
        };
        let name = name.to_lowercase();
        if starts_clean && ends_clean && is_valid_namespace(&name) && !people.contains(&name) {
            people.push(name);
        }
        at = end.max(at + 1);
    }
    people
}

/// The teams a comment mentions in its own words, as `workspace/slug`,
/// each once: `@acme/backend`, not in code, a quote, an address or a path
/// such as `@acme/backend/x` or `npm i @scope/pkg@1`.
pub(crate) fn teams_mentioned(body: &str) -> Vec<String> {
    let text = spoken(body);
    let chars: Vec<char> = text.chars().collect();
    let mut teams: Vec<String> = Vec::new();
    let mut at = 0;
    while at < chars.len() && teams.len() < MAX_MENTIONS {
        if chars[at] != '@' {
            at += 1;
            continue;
        }
        let starts_clean = at == 0 || {
            let before = chars[at - 1];
            !(before.is_alphanumeric() || "._%+-/\\@`=".contains(before))
        };
        let name: String = chars[at + 1..]
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric() || **c == '-' || **c == '/')
            .collect();
        let end = at + 1 + name.chars().count();
        let ends_clean = match chars.get(end) {
            None => true,
            Some(c) if "_@\\".contains(*c) => false,
            Some('.') => chars.get(end + 1).is_none_or(|c| !c.is_alphanumeric()),
            Some(_) => true,
        };
        if starts_clean
            && ends_clean
            && name.matches('/').count() == 1
            && let Some(team) = crate::team_reviews::team_name(&name)
            && !teams.contains(&team)
        {
            teams.push(team);
        }
        at = end.max(at + 1);
    }
    teams
}

/// Who each team mentioned tells: everyone in it and its child teams, when
/// the writer may see the team and it has notifications on.
pub(crate) fn told_of(teams: &[g1t_contracts::teams::ResolvedTeam], writer: &str) -> Vec<TeamMentioned> {
    teams
        .iter()
        .map(|team| TeamMentioned {
            team: format!("{}/{}", team.workspace, team.slug),
            members: if team.notify && team.asker_sees {
                team.everyone()
                    .map(|person| person.username.clone())
                    .filter(|name| !name.eq_ignore_ascii_case(writer))
                    .collect()
            } else {
                Vec::new()
            },
        })
        .collect()
}

/// The first line a comment says something on, cut to about a line.
pub(crate) fn excerpt(body: &str) -> String {
    let line = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("```") && !line.starts_with('>'))
        .unwrap_or_default();
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= EXCERPT_CHARS {
        return line;
    }
    let cut: String = line.chars().take(EXCERPT_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

fn principal(id: &str, username: &str) -> Principal {
    Principal {
        id: id.to_owned(),
        username: username.to_lowercase(),
    }
}

fn of_issue(issue: Issue) -> InboxSubject {
    let body = issue.body.clone();
    InboxSubject {
        kind: Some(SubjectKind::Issue),
        title: issue.title,
        author: principal(&issue.author.id, &issue.author.username),
        requested_by: issue.requested_by.map(|user| principal(&user.id, &user.username)),
        assignees: issue.assignees,
        mentions: people_mentioned(&body),
        ..InboxSubject::default()
    }
}

fn of_pull(pull: Pull, issue: Option<Issue>) -> InboxSubject {
    InboxSubject {
        kind: Some(SubjectKind::Pull),
        title: pull.title,
        author: principal(&pull.author.id, &pull.author.username),
        requested_by: pull.requested_by.map(|user| principal(&user.id, &user.username)),
        assignees: pull.assignees,
        reviewers: pull.reviewers,
        mentions: people_mentioned(pull.body.as_deref().unwrap_or_default()),
        team_mentions: Vec::new(),
        issue: issue.map(|issue| Box::new(of_issue(issue))),
        comment: None,
    }
}

fn of_comment(comment: Comment) -> InboxComment {
    let event = comment.kind == CommentKind::Event;
    InboxComment {
        author: principal(&comment.author.id, &comment.author.username),
        excerpt: excerpt(&comment.body),
        mentions: if event { Vec::new() } else { people_mentioned(&comment.body) },
        team_mentions: Vec::new(),
        verdict: comment.verdict.map(|verdict| verdict.as_str().to_owned()),
        event,
        acting_for: comment.acting_for.as_ref().map(|user| principal(&user.id, &user.username)),
        advisory: comment.advisory,
        agent: comment.agent,
    }
}

impl Work {
    /// The issue or pull request numbered `number`, with its people, and
    /// the comment asked about. None when there is no such issue or pull
    /// request.
    pub(crate) async fn inbox_subject(&self, a: InboxSubjectArgs) -> Result<Option<InboxSubject>> {
        let comment = async {
            let Some(id) = &a.comment_id else {
                return Ok::<_, worker::Error>(None);
            };
            let Some(row) = self
                .db
                .prepare("SELECT * FROM comments WHERE id = ? AND repo_id = ?")
                .bind(&[id.as_str().into(), a.repo_id.as_str().into()])?
                .first::<CommentRow>(None)
                .await?
            else {
                return Ok(None);
            };
            let comment = Comment::from(row);
            let teams = if comment.kind == CommentKind::Event { Vec::new() } else { teams_mentioned(&comment.body) };
            let mut shown = of_comment(comment.clone());
            shown.team_mentions = self.team_mentions(&a.repo_id, &teams, &comment.author.id, &comment.author.username).await?;
            Ok(Some(shown))
        };
        let (pull, comment) = futures_util::future::try_join(self.pull(&a.repo_id, a.number), comment).await?;
        let mut subject = match pull {
            Some(pull) => {
                let issue = match pull.issue {
                    Some(number) => self.issue(&a.repo_id, number).await?,
                    None => None,
                };
                of_pull(pull, issue)
            }
            None => match self.issue(&a.repo_id, a.number).await? {
                Some(issue) => of_issue(issue),
                None => return Ok(None),
            },
        };
        subject.comment = comment;
        // A description's team mentions, for when it is opened.
        if a.comment_id.is_none() {
            let body = match subject.kind {
                Some(SubjectKind::Pull) => self.pull(&a.repo_id, a.number).await?.and_then(|pull| pull.body),
                _ => self.issue(&a.repo_id, a.number).await?.map(|issue| issue.body),
            };
            let teams = teams_mentioned(body.as_deref().unwrap_or_default());
            let author = subject.author.clone();
            subject.team_mentions = self.team_mentions(&a.repo_id, &teams, &author.id, &author.username).await?;
        }
        Ok(Some(subject))
    }

    /// The teams named, resolved, with who each mention tells.
    async fn team_mentions(&self, repo_id: &str, teams: &[String], writer_id: &str, writer: &str) -> Result<Vec<TeamMentioned>> {
        if teams.is_empty() {
            return Ok(Vec::new());
        }
        let resolved: Vec<g1t_contracts::teams::ResolvedTeam> = g1t_kit::call(
            &self.identity,
            "resolve_teams",
            &g1t_contracts::teams::ResolveTeamsArgs {
                teams: teams.to_vec(),
                repo_id: Some(repo_id.to_owned()),
                asker: Some(writer_id.to_owned()),
            },
        )
        .await?;
        Ok(told_of(&resolved, writer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn people_are_mentioned_by_name_in_their_own_words() {
        assert_eq!(people_mentioned("@ana can you look? cc @Bob-1."), vec!["ana", "bob-1"]);
        // Once each, never g1t, never in code or a quote.
        assert_eq!(people_mentioned("@ana @ana @g1t `@carl`\n> @dee said"), vec!["ana"]);
        // Not an address, a package, a path or a domain.
        assert!(people_mentioned("ops@ana.dev, @scope/pkg, a/@b, @ana.dev").is_empty());
        assert_eq!(people_mentioned("(@ana)"), vec!["ana"]);
    }

    #[test]
    fn teams_are_mentioned_as_workspace_slash_team() {
        assert_eq!(teams_mentioned("cc @acme/backend and @Acme/Web-UI."), vec!["acme/backend", "acme/web-ui"]);
        // Once each; never in code or a quote; not a person.
        assert_eq!(teams_mentioned("@acme/backend @acme/backend `@acme/ops`\n> @acme/sre\n@ana"), vec!["acme/backend"]);
        // Not an address, a deeper path or a versioned package.
        assert!(teams_mentioned("ops@acme/backend a/@acme/x @acme/backend/src npm i @acme/backend@1").is_empty());
        // And a person is still a person.
        assert_eq!(people_mentioned("@ana and @acme/backend"), vec!["ana"]);
    }

    #[test]
    fn a_team_mention_tells_its_people_when_it_may() {
        use g1t_contracts::teams::{ResolvedTeam, TeamPerson};
        let person = |name: &str| TeamPerson {
            id: format!("usr_{name}"),
            username: name.to_owned(),
        };
        let team = |notify: bool, sees: bool| ResolvedTeam {
            workspace: "acme".into(),
            slug: "backend".into(),
            notify,
            asker_sees: sees,
            members: vec![person("ana"), person("bo")],
            child_members: vec![person("cy")],
            ..ResolvedTeam::default()
        };
        let told = told_of(&[team(true, true)], "bo");
        assert_eq!(told[0].team, "acme/backend");
        assert_eq!(told[0].members, vec!["ana", "cy"]);
        assert!(told_of(&[team(false, true)], "zed")[0].members.is_empty());
        assert!(told_of(&[team(true, false)], "zed")[0].members.is_empty());
    }

    #[test]
    fn an_excerpt_is_the_first_line_said() {
        assert_eq!(excerpt("\n\n```\ncode\n```"), "code");
        assert_eq!(excerpt("> quoted\n  Looks   good  \nmore"), "Looks good");
        let long = "word ".repeat(60);
        let cut = excerpt(&long);
        assert!(cut.ends_with('…'));
        assert_eq!(cut.chars().count(), EXCERPT_CHARS);
    }
}
