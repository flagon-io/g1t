//! What an event names, for the inbox (`g1t_contracts::inbox`): the issue
//! or pull request, its people, and the comment, read straight from the
//! rows. The events service asks as each event arrives and decides from
//! the answer who is told; nobody's access is checked here, so nothing it
//! returns is shown to anyone but the people it names, or to those who can
//! read the repository.

use g1t_contracts::credentials::Principal;
use g1t_contracts::inbox::{InboxComment, InboxSubject, InboxSubjectArgs, SubjectKind};
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
    InboxSubject {
        kind: Some(SubjectKind::Issue),
        title: issue.title,
        author: principal(&issue.author.id, &issue.author.username),
        requested_by: issue.requested_by.map(|user| principal(&user.id, &user.username)),
        assignees: issue.assignees,
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
        verdict: comment.verdict.map(|verdict| verdict.as_str().to_owned()),
        event,
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
            Ok(self
                .db
                .prepare("SELECT * FROM comments WHERE id = ? AND repo_id = ?")
                .bind(&[id.as_str().into(), a.repo_id.as_str().into()])?
                .first::<CommentRow>(None)
                .await?
                .map(|row| of_comment(Comment::from(row))))
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
        Ok(Some(subject))
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
    fn an_excerpt_is_the_first_line_said() {
        assert_eq!(excerpt("\n\n```\ncode\n```"), "code");
        assert_eq!(excerpt("> quoted\n  Looks   good  \nmore"), "Looks good");
        let long = "word ".repeat(60);
        let cut = excerpt(&long);
        assert!(cut.ends_with('…'));
        assert_eq!(cut.chars().count(), EXCERPT_CHARS);
    }
}
