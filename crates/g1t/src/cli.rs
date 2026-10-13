//! The command line's shape: every command, flag and argument.

use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

pub const ABOUT: &str = "Work with g1t from the command line.";

pub const AFTER_HELP: &str = "\
Examples:
  g1t auth login
  g1t issue list --label bug
  g1t pr create --fill
  g1t pr checks --watch --fail-fast
  g1t run logs --failed
  g1t workflow run release.yml -f channel=stable
  g1t api list_issues --jq '.[].title'

Environment:
  G1T_TOKEN     A token to use instead of the stored one
  G1T_HOST      The host to talk to when no repository names one
  G1T_REPO      The repository, as OWNER/NAME, instead of the git remote
  NO_COLOR      Plain output on a terminal too

Exit codes: 0 done, 1 failed, 2 used wrongly, 4 sign-in needed, 8 checks pending.
Docs: https://docs.g1t.sh/guides/cli/";

#[derive(Debug, Parser)]
#[command(
    name = "g1t",
    version,
    about = ABOUT,
    after_help = AFTER_HELP,
    propagate_version = true,
    max_term_width = 100,
    arg_required_else_help = true
)]
pub struct Cli {
    #[command(flatten)]
    pub global: Global,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Args, Clone, Default)]
pub struct Global {
    /// The repository, as [HOST/]OWNER/NAME, instead of the current directory's.
    #[arg(
        short = 'R',
        long,
        global = true,
        value_name = "[HOST/]OWNER/NAME",
        env = "G1T_REPO"
    )]
    pub repo: Option<String>,
    /// The g1t host, such as g1t.sh or git.example.com.
    #[arg(long, global = true, value_name = "HOST")]
    pub hostname: Option<String>,
    /// Print JSON: every field, or only the comma-separated FIELDS.
    #[arg(
        long,
        global = true,
        value_name = "FIELDS",
        num_args = 0..=1,
        default_missing_value = "",
        help_heading = "Output"
    )]
    pub json: Option<String>,
    /// Run a jq expression over the JSON and print what it gives.
    #[arg(
        long,
        global = true,
        value_name = "EXPRESSION",
        help_heading = "Output"
    )]
    pub jq: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Sign in, sign out, and set git up to use g1t's credentials.
    #[command(subcommand)]
    Auth(AuthCommand),
    /// Repositories: view, clone, create, list.
    #[command(subcommand)]
    Repo(RepoCommand),
    /// Issues: list, view, create, comment, close, reopen, edit.
    #[command(subcommand)]
    Issue(IssueCommand),
    /// Pull requests: list, view, create, check out, diff, checks, review, merge.
    #[command(subcommand)]
    Pr(PrCommand),
    /// Workflow runs: list, view, watch, logs, rerun, cancel.
    #[command(subcommand)]
    Run(RunCommand),
    /// Workflows in .g1t/workflows: list, view, run, enable, disable.
    #[command(subcommand)]
    Workflow(WorkflowCommand),
    /// Secrets for workflows and deployments, a repository's or a workspace's.
    #[command(subcommand)]
    Secret(SecretCommand),
    /// Deployments: list and view.
    #[command(subcommand)]
    Deploy(DeployCommand),
    /// A project's logs and errors.
    Logs(LogsArgs),
    /// What needs you: your pull requests, reviews asked of you, your issues, failing checks.
    Status(StatusArgs),
    /// Call any API operation or path, with your token.
    Api(ApiArgs),
    /// Open the repository, an issue or a pull request in the browser.
    Browse(BrowseArgs),
    /// Shortcuts for commands you type often.
    #[command(subcommand)]
    Alias(AliasCommand),
    /// Print a shell completion script.
    Completion(CompletionArgs),
    /// Push a local container image to g1t's registry, in chunks.
    Push(PushArgs),
}

// --- auth -------------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// Sign in to a g1t host.
    #[command(after_help = "\
Without --with-token, g1t shows a code and a link; approve it in the browser, signed in.
With --with-token, the token is read from stdin:
  g1t auth login --with-token < token.txt")]
    Login(LoginArgs),
    /// Sign out of an account on a host.
    Logout(AccountArgs),
    /// Show which accounts are signed in, and whether their tokens work.
    Status(AuthStatusArgs),
    /// Print the token in use, for another program.
    Token(AccountArgs),
    /// Make another signed-in account on a host the active one.
    Switch(AccountArgs),
    /// Make git use g1t's credentials for pushing and fetching over HTTPS.
    SetupGit(SetupGitArgs),
    /// The git credential helper `setup-git` installs. Git runs it.
    #[command(hide = true)]
    GitCredential(GitCredentialArgs),
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    /// Read a token from stdin instead of approving in the browser.
    #[arg(long)]
    pub with_token: bool,
    /// Keep the token in the config file, not the system keychain.
    #[arg(long)]
    pub insecure_storage: bool,
    /// Do not open the browser; just print the link.
    #[arg(long)]
    pub no_browser: bool,
    /// Also set git up to use g1t's credentials (see `g1t auth setup-git`).
    #[arg(long)]
    pub git: bool,
}

#[derive(Debug, Args)]
pub struct AccountArgs {
    /// The account, when more than one is signed in on the host.
    #[arg(short, long)]
    pub user: Option<String>,
}

#[derive(Debug, Args)]
pub struct AuthStatusArgs {
    /// Print each token too.
    #[arg(long)]
    pub show_token: bool,
}

#[derive(Debug, Args)]
pub struct SetupGitArgs {
    /// Print the git config commands instead of running them.
    #[arg(long)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct GitCredentialArgs {
    /// get, store or erase, as git says.
    pub operation: String,
}

// --- repo -------------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum RepoCommand {
    /// Show a repository.
    View(RepoViewArgs),
    /// Clone a repository.
    Clone(RepoCloneArgs),
    /// Make a repository.
    Create(RepoCreateArgs),
    /// List repositories you can see.
    List(RepoListArgs),
}

#[derive(Debug, Args)]
pub struct RepoViewArgs {
    /// OWNER/NAME; the current repository when left out.
    pub repository: Option<String>,
    /// Open it in the browser.
    #[arg(short, long)]
    pub web: bool,
}

#[derive(Debug, Args)]
pub struct RepoCloneArgs {
    /// OWNER/NAME, or NAME for one of your own.
    pub repository: String,
    /// Where to clone it.
    pub directory: Option<String>,
    /// Flags for git clone, after --.
    #[arg(last = true)]
    pub git_flags: Vec<String>,
}

#[derive(Debug, Args)]
pub struct RepoCreateArgs {
    /// NAME, or WORKSPACE/NAME.
    pub name: Option<String>,
    /// Anyone can see it. Repositories are private unless this is given.
    #[arg(long, conflicts_with = "private")]
    pub public: bool,
    /// Only people with a role on it can see it (the default).
    #[arg(long)]
    pub private: bool,
    #[arg(short, long)]
    pub description: Option<String>,
    /// Clone it once it is made.
    #[arg(short, long)]
    pub clone: bool,
    /// Add it as a remote of this directory's repository and push it there.
    #[arg(long, value_name = "DIR")]
    pub source: Option<String>,
    /// The remote's name, with --source.
    #[arg(long, default_value = "origin")]
    pub remote: String,
}

#[derive(Debug, Args)]
pub struct RepoListArgs {
    /// Only this workspace's.
    pub workspace: Option<String>,
    /// Only those whose name or description holds this.
    #[arg(short, long)]
    pub query: Option<String>,
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
}

// --- issue ------------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum IssueCommand {
    /// List issues.
    List(IssueListArgs),
    /// Show an issue, with its comments.
    View(IssueViewArgs),
    /// Open an issue.
    Create(IssueCreateArgs),
    /// Comment on an issue.
    Comment(CommentArgs),
    /// Close an issue.
    Close(IssueCloseArgs),
    /// Reopen an issue.
    Reopen(ReopenArgs),
    /// Change an issue's title, body, labels, assignees or milestone.
    Edit(IssueEditArgs),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum IssueState {
    Open,
    Closed,
    All,
}

#[derive(Debug, Args)]
pub struct IssueListArgs {
    #[arg(short, long, value_enum, default_value_t = IssueState::Open)]
    pub state: IssueState,
    /// Only issues with this label.
    #[arg(short, long)]
    pub label: Option<String>,
    /// Only issues in the milestone of this number.
    #[arg(short, long)]
    pub milestone: Option<u64>,
    /// Only issues assigned to this person (@me for you).
    #[arg(short, long)]
    pub assignee: Option<String>,
    /// Only issues opened by this person (@me for you).
    #[arg(short = 'A', long)]
    pub author: Option<String>,
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct IssueViewArgs {
    /// The issue's number.
    pub number: u64,
    /// Show its comments too.
    #[arg(short, long)]
    pub comments: bool,
    /// Open it in the browser.
    #[arg(short, long)]
    pub web: bool,
}

#[derive(Debug, Args)]
pub struct BodyArgs {
    /// The text. Markdown.
    #[arg(short, long)]
    pub body: Option<String>,
    /// Read the text from a file, or - for stdin.
    #[arg(short = 'F', long, value_name = "FILE")]
    pub body_file: Option<String>,
}

#[derive(Debug, Args)]
pub struct IssueCreateArgs {
    #[arg(short, long)]
    pub title: Option<String>,
    #[command(flatten)]
    pub body: BodyArgs,
    /// A label; repeat for more.
    #[arg(short, long)]
    pub label: Vec<String>,
    /// Someone to assign; repeat for more (@me for you).
    #[arg(short, long)]
    pub assignee: Vec<String>,
    /// A milestone's number.
    #[arg(short, long)]
    pub milestone: Option<u64>,
    /// Open the new-issue page in the browser instead.
    #[arg(short, long)]
    pub web: bool,
}

#[derive(Debug, Args)]
pub struct CommentArgs {
    /// The number; for a pull request, the current branch's when left out.
    pub number: Option<u64>,
    #[command(flatten)]
    pub body: BodyArgs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum CloseReason {
    Completed,
    NotPlanned,
}

#[derive(Debug, Args)]
pub struct IssueCloseArgs {
    pub number: u64,
    #[arg(short, long, value_enum)]
    pub reason: Option<CloseReason>,
    /// Leave a comment as it closes.
    #[arg(short, long)]
    pub comment: Option<String>,
}

#[derive(Debug, Args)]
pub struct ReopenArgs {
    pub number: u64,
    /// Leave a comment as it reopens.
    #[arg(short, long)]
    pub comment: Option<String>,
}

#[derive(Debug, Args)]
pub struct IssueEditArgs {
    pub number: u64,
    #[arg(short, long)]
    pub title: Option<String>,
    #[command(flatten)]
    pub body: BodyArgs,
    #[arg(long, value_name = "LABEL")]
    pub add_label: Vec<String>,
    #[arg(long, value_name = "LABEL")]
    pub remove_label: Vec<String>,
    #[arg(long, value_name = "LOGIN")]
    pub add_assignee: Vec<String>,
    #[arg(long, value_name = "LOGIN")]
    pub remove_assignee: Vec<String>,
    /// A milestone's number.
    #[arg(short, long)]
    pub milestone: Option<u64>,
    /// Take it out of its milestone.
    #[arg(long, conflicts_with = "milestone")]
    pub remove_milestone: bool,
}

// --- pr ---------------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum PrCommand {
    /// List pull requests.
    List(PrListArgs),
    /// Show a pull request.
    View(PrViewArgs),
    /// Open a pull request from a branch, or start one for an issue.
    Create(PrCreateArgs),
    /// Check a pull request's changes out locally.
    Checkout(PrCheckoutArgs),
    /// Show a pull request's changes as a diff.
    Diff(PrDiffArgs),
    /// Show a pull request's checks; --watch waits for them.
    Checks(PrChecksArgs),
    /// Approve a pull request, or ask for changes.
    Review(PrReviewArgs),
    /// Merge a pull request.
    Merge(PrMergeArgs),
    /// Mark a draft ready for review, or turn it back into a draft.
    Ready(PrReadyArgs),
    /// Comment on a pull request.
    Comment(CommentArgs),
    /// Close a pull request without merging it.
    Close(PrSelect),
    /// Reopen a closed pull request.
    Reopen(PrSelect),
}

#[derive(Debug, Args)]
pub struct PrSelect {
    /// The number; the current branch's when left out.
    pub number: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum PrState {
    Open,
    Closed,
    Merged,
    All,
}

#[derive(Debug, Args)]
pub struct PrListArgs {
    #[arg(short, long, value_enum, default_value_t = PrState::Open)]
    pub state: PrState,
    /// Only those merging into this branch.
    #[arg(short = 'B', long)]
    pub base: Option<String>,
    #[arg(short, long)]
    pub label: Option<String>,
    /// Only those opened by this person (@me for you).
    #[arg(short = 'A', long)]
    pub author: Option<String>,
    /// Only drafts.
    #[arg(short, long)]
    pub draft: bool,
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct PrViewArgs {
    /// The number; the current branch's when left out.
    pub number: Option<u64>,
    #[arg(short, long)]
    pub comments: bool,
    #[arg(short, long)]
    pub web: bool,
}

#[derive(Debug, Args)]
pub struct PrCreateArgs {
    #[arg(short, long)]
    pub title: Option<String>,
    #[command(flatten)]
    pub body: BodyArgs,
    /// The branch to merge into; the default branch when left out.
    #[arg(short = 'B', long)]
    pub base: Option<String>,
    /// The branch with the changes; the current one when left out.
    #[arg(short = 'H', long)]
    pub head: Option<String>,
    /// The issue it is for. Without a branch, starts a draft in a working copy of its own.
    #[arg(short, long)]
    pub issue: Option<u64>,
    /// Take the title and body from the branch's commits.
    #[arg(short, long)]
    pub fill: bool,
    /// Open it as a draft.
    #[arg(short, long)]
    pub draft: bool,
    /// Do not push the branch first.
    #[arg(long)]
    pub no_push: bool,
}

#[derive(Debug, Args)]
pub struct PrCheckoutArgs {
    pub number: u64,
    /// The local branch's name; pr-NUMBER when left out.
    #[arg(short, long)]
    pub branch: Option<String>,
    /// Reset the local branch to the pull request's head even if it has other commits.
    #[arg(short, long)]
    pub force: bool,
}

#[derive(Debug, Args)]
pub struct PrDiffArgs {
    pub number: Option<u64>,
    /// Only the changed files' names.
    #[arg(long)]
    pub name_only: bool,
    /// Color: auto, always or never.
    #[arg(long, default_value = "auto")]
    pub color: String,
}

#[derive(Debug, Args)]
pub struct PrChecksArgs {
    pub number: Option<u64>,
    /// Wait until every check has finished.
    #[arg(short, long)]
    pub watch: bool,
    /// With --watch, stop at the first failing check.
    #[arg(long, requires = "watch")]
    pub fail_fast: bool,
    /// Seconds between looks, with --watch.
    #[arg(short, long, default_value_t = 10)]
    pub interval: u64,
}

#[derive(Debug, Args)]
#[command(group(clap::ArgGroup::new("verdict").required(true).args(["approve", "request_changes", "comment"])))]
pub struct PrReviewArgs {
    pub number: Option<u64>,
    #[arg(short, long)]
    pub approve: bool,
    #[arg(short, long)]
    pub request_changes: bool,
    /// Comment without approving or asking for changes.
    #[arg(short, long)]
    pub comment: bool,
    #[command(flatten)]
    pub body: BodyArgs,
}

#[derive(Debug, Args)]
pub struct PrMergeArgs {
    pub number: Option<u64>,
    /// Leave the issue it is for open.
    #[arg(long)]
    pub keep_issue_open: bool,
    /// Merge past failing required checks and rules (needs the Admin role).
    #[arg(long)]
    pub admin: bool,
    /// Delete the local and remote branch afterwards.
    #[arg(short, long)]
    pub delete_branch: bool,
}

#[derive(Debug, Args)]
pub struct PrReadyArgs {
    pub number: Option<u64>,
    /// What changed and why; it becomes the description. The current one when left out.
    #[arg(short, long)]
    pub summary: Option<String>,
    /// Turn it back into a draft.
    #[arg(long)]
    pub undo: bool,
}

// --- run --------------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum RunCommand {
    /// List workflow runs, newest first.
    List(RunListArgs),
    /// Show a run's jobs and steps.
    View(RunViewArgs),
    /// Follow a run until it finishes; exits 1 if it fails.
    Watch(RunWatchArgs),
    /// Print a run's logs; --failed prints only the failing steps' tails.
    Logs(RunLogsArgs),
    /// Run a run again: all of it, its failed jobs, or one job.
    Rerun(RunRerunArgs),
    /// Cancel a run.
    Cancel(RunSelect),
}

#[derive(Debug, Args)]
pub struct RunSelect {
    /// The run's id (run_…) or number; the current branch's latest when left out.
    pub run: Option<String>,
}

#[derive(Debug, Args)]
pub struct RunListArgs {
    /// Only this workflow's: its file name or id.
    #[arg(short, long)]
    pub workflow: Option<String>,
    #[arg(short, long)]
    pub branch: Option<String>,
    /// Only runs for this event: push, pull_request, schedule...
    #[arg(short, long)]
    pub event: Option<String>,
    /// Only runs of this commit.
    #[arg(short, long)]
    pub commit: Option<String>,
    /// Only runs for this pull request.
    #[arg(long)]
    pub pr: Option<u64>,
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct RunViewArgs {
    pub run: Option<String>,
    /// Show this job's steps only.
    #[arg(short, long)]
    pub job: Option<String>,
    /// Print the log too.
    #[arg(long)]
    pub log: bool,
    /// Print the failing steps' logs too.
    #[arg(long)]
    pub log_failed: bool,
    #[arg(short, long)]
    pub web: bool,
    /// Exit 1 when the run failed.
    #[arg(long)]
    pub exit_status: bool,
}

#[derive(Debug, Args)]
pub struct RunWatchArgs {
    pub run: Option<String>,
    /// Seconds between looks.
    #[arg(short, long, default_value_t = 3)]
    pub interval: u64,
}

#[derive(Debug, Args)]
pub struct RunLogsArgs {
    pub run: Option<String>,
    /// Only this job's (its id, key or name).
    #[arg(short, long)]
    pub job: Option<String>,
    /// Only the failing steps, and only their last lines.
    #[arg(short, long)]
    pub failed: bool,
    /// How many lines of each failing step to print, with --failed.
    #[arg(short = 'n', long, default_value_t = 60)]
    pub tail: usize,
}

#[derive(Debug, Args)]
pub struct RunRerunArgs {
    pub run: Option<String>,
    /// Only the jobs that failed.
    #[arg(long)]
    pub failed: bool,
    /// Only this job (its id).
    #[arg(short, long, conflicts_with = "failed")]
    pub job: Option<String>,
    /// With debug logging.
    #[arg(short, long)]
    pub debug: bool,
}

// --- workflow ---------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum WorkflowCommand {
    /// List the workflows in .g1t/workflows, with whether each is on.
    List(WorkflowListArgs),
    /// Show a workflow and its latest runs; --yaml prints its file.
    View(WorkflowViewArgs),
    /// Run a workflow that has `on: workflow_dispatch`, and print its run's address.
    #[command(after_help = "\
Inputs are given with -f (or -F, where @FILE reads a file), or as a JSON object on
stdin with --json. At a terminal, with none given, g1t asks for each input.

Examples:
  g1t workflow run release.yml
  g1t workflow run release.yml --ref v1.4.0 -f channel=stable -f dry_run=true
  echo '{\"channel\":\"stable\"}' | g1t workflow run Release --json")]
    Run(WorkflowRunArgs),
    /// Turn a workflow on again.
    Enable(WorkflowSelect),
    /// Turn a workflow off: its file stays, and nothing starts it until it is turned on.
    Disable(WorkflowSelect),
}

#[derive(Debug, Args)]
pub struct WorkflowSelect {
    /// Its file name (ci.yml), id (wfl_…) or name; asked for at a terminal when left out.
    pub workflow: Option<String>,
}

#[derive(Debug, Args)]
pub struct WorkflowListArgs {
    /// Include the workflows that are turned off.
    #[arg(short, long)]
    pub all: bool,
    #[arg(short = 'L', long, default_value_t = 50)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct WorkflowViewArgs {
    /// Its file name (ci.yml), id (wfl_…) or name; asked for at a terminal when left out.
    pub workflow: Option<String>,
    /// Print the workflow's file.
    #[arg(short, long)]
    pub yaml: bool,
    /// The branch or tag to read the file on, with --yaml; the default branch when left out.
    #[arg(short, long = "ref", value_name = "REF", requires = "yaml")]
    pub git_ref: Option<String>,
    /// Open it in the browser.
    #[arg(short, long, conflicts_with = "yaml")]
    pub web: bool,
}

#[derive(Debug, Args)]
pub struct WorkflowRunArgs {
    /// Its file name (ci.yml), id (wfl_…) or name; asked for at a terminal when left out.
    pub workflow: Option<String>,
    /// The branch or tag to run it on; the default branch when left out.
    #[arg(short, long = "ref", value_name = "REF")]
    pub git_ref: Option<String>,
    /// An input, key=value; repeat for more.
    #[arg(short = 'f', long = "raw-field", value_name = "KEY=VALUE")]
    pub raw_field: Vec<String>,
    /// An input, key=value, where @FILE reads the value from a file (@- from stdin).
    #[arg(short = 'F', long = "field", value_name = "KEY=VALUE")]
    pub field: Vec<String>,
}

// --- secret -----------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum SecretCommand {
    /// List secrets' names (never their values).
    List(SecretScope),
    /// Set a secret. The value is read from stdin when not given.
    Set(SecretSetArgs),
    /// Delete a secret.
    Delete(SecretDeleteArgs),
}

#[derive(Debug, Args)]
pub struct SecretScope {
    /// A workspace's secrets instead of the repository's.
    #[arg(short, long, value_name = "WORKSPACE")]
    pub workspace: Option<String>,
    /// Only the value for this environment (production, preview...).
    #[arg(short, long, value_name = "ENVIRONMENT")]
    pub env: Option<String>,
}

#[derive(Debug, Args)]
pub struct SecretSetArgs {
    /// The secret's name; uppercased.
    pub name: String,
    /// The value. Read from stdin when left out, so it stays out of your shell's history.
    #[arg(short, long)]
    pub body: Option<String>,
    #[command(flatten)]
    pub scope: SecretScope,
    /// Who can read it: workflows, deployments, or both (repeat).
    #[arg(long, value_name = "WHO")]
    pub available_to: Vec<String>,
    /// Broker it: jobs get a stand-in, and g1t fills the value in only on requests to this host. Repeat for more.
    #[arg(long, value_name = "HOST")]
    pub brokered_host: Vec<String>,
    /// A note for whoever reads the list.
    #[arg(long)]
    pub note: Option<String>,
}

#[derive(Debug, Args)]
pub struct SecretDeleteArgs {
    pub name: String,
    #[command(flatten)]
    pub scope: SecretScope,
}

// --- deploy -----------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum DeployCommand {
    /// List deployments, newest first.
    List(DeployListArgs),
    /// Show a deployment and its statuses.
    View(DeployViewArgs),
}

#[derive(Debug, Args)]
pub struct DeployListArgs {
    #[arg(short, long)]
    pub env: Option<String>,
    /// queued, in_progress, success, failure, error or inactive.
    #[arg(short, long)]
    pub state: Option<String>,
    /// api, actions or g1t_page.
    #[arg(long)]
    pub source: Option<String>,
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct DeployViewArgs {
    pub id: String,
    #[arg(short, long)]
    pub web: bool,
}

// --- logs -------------------------------------------------------------

#[derive(Debug, Args)]
pub struct LogsArgs {
    /// The project; the current repository's when left out.
    #[arg(short, long)]
    pub project: Option<String>,
    /// Grouped errors instead of log lines.
    #[arg(long)]
    pub errors: bool,
    /// Lines holding all of these words, or a "quoted phrase".
    #[arg(short, long)]
    pub query: Option<String>,
    /// Levels: trace, debug, info, warn, error, fatal (comma-separated).
    #[arg(short, long)]
    pub level: Option<String>,
    #[arg(short, long)]
    pub env: Option<String>,
    #[arg(long)]
    pub service: Option<String>,
    /// How far back: 15m, 2h, 1d, or a time like 2026-10-12T09:00:00Z.
    #[arg(short, long)]
    pub since: Option<String>,
    /// With --errors: open, resolved or ignored.
    #[arg(long)]
    pub state: Option<String>,
    /// Keep printing new lines as they come.
    #[arg(short, long, conflicts_with = "errors")]
    pub follow: bool,
    #[arg(short = 'L', long, default_value_t = 50)]
    pub limit: usize,
}

// --- status, api, browse ---------------------------------------------

#[derive(Debug, Args)]
pub struct StatusArgs {}

#[derive(Debug, Args)]
#[command(after_help = "\
ENDPOINT is an operation's name (list_issues) or a path (/repos/{owner}/{name}/issues).
{owner}, {name}, {repo} and {workspace} are filled in from the current repository,
and an operation's other path parameters from -f/-F fields of the same name.

Examples:
  g1t api list_issues -f state=closed
  g1t api /user --jq .username
  g1t api create_issue -f title='Broken link' -f labels[]=docs
  g1t api list_workflow_runs --paginate --jq '.[].conclusion'
  g1t api --list issue")]
pub struct ApiArgs {
    /// An operation's name, or a path.
    pub endpoint: Option<String>,
    /// List the operations, or those matching this word.
    #[arg(long, value_name = "QUERY", num_args = 0..=1, default_missing_value = "")]
    pub list: Option<String>,
    /// The HTTP method: GET unless fields are given, then POST.
    #[arg(short = 'X', long)]
    pub method: Option<String>,
    /// A string field, key=value. key[]=value adds to a list.
    #[arg(short = 'f', long = "raw-field", value_name = "KEY=VALUE")]
    pub raw_field: Vec<String>,
    /// A typed field: true, false, null and numbers become JSON; @file reads a file.
    #[arg(short = 'F', long = "field", value_name = "KEY=VALUE")]
    pub field: Vec<String>,
    /// A request header, key:value.
    #[arg(short = 'H', long = "header", value_name = "KEY:VALUE")]
    pub header: Vec<String>,
    /// The request body, from a file or - for stdin.
    #[arg(long, value_name = "FILE")]
    pub input: Option<String>,
    /// Follow next pages until there are none.
    #[arg(long)]
    pub paginate: bool,
    /// With --paginate, put every page's items into one array.
    #[arg(long, requires = "paginate")]
    pub slurp: bool,
    /// Print the status line and headers too.
    #[arg(short, long)]
    pub include: bool,
    /// Print nothing on success.
    #[arg(long)]
    pub silent: bool,
}

#[derive(Debug, Args)]
pub struct BrowseArgs {
    /// An issue or pull request number, a file path (path:line), or a commit.
    pub target: Option<String>,
    /// The branch to show files on.
    #[arg(short, long)]
    pub branch: Option<String>,
    #[arg(short, long)]
    pub settings: bool,
    #[arg(long)]
    pub issues: bool,
    #[arg(long)]
    pub pulls: bool,
    #[arg(long)]
    pub actions: bool,
    /// Print the address instead of opening it.
    #[arg(short, long)]
    pub no_browser: bool,
}

// --- alias, completion, push -----------------------------------------

#[derive(Debug, Subcommand)]
pub enum AliasCommand {
    /// Make an alias: g1t alias set co 'pr checkout'. Start it with ! to run it through the shell.
    Set(AliasSetArgs),
    /// List aliases.
    List,
    /// Delete an alias.
    Delete(AliasDeleteArgs),
}

#[derive(Debug, Args)]
pub struct AliasSetArgs {
    pub name: String,
    /// What it expands to. $1, $2... take the arguments after it.
    pub expansion: String,
}

#[derive(Debug, Args)]
pub struct AliasDeleteArgs {
    pub name: String,
}

#[derive(Debug, Args)]
pub struct CompletionArgs {
    #[arg(value_enum)]
    pub shell: clap_complete::Shell,
}

#[derive(Debug, Args)]
#[command(after_help = "\
The token is the first of: --token-stdin, G1T_TOKEN, the account `g1t auth login`
signed in for the registry's host, or what `docker login g1t.sh` stored.")]
pub struct PushArgs {
    /// The local image, [REGISTRY/]NAME[:TAG].
    pub image: Option<String>,
    /// Where to push, when the image's own name is not an address on g1t.sh. The tag defaults to latest.
    #[arg(long = "as", value_name = "ADDRESS")]
    pub target: Option<String>,
    /// How much of a layer each request carries: 5MB to 95MB.
    #[arg(long, value_name = "SIZE", default_value = "90MB", value_parser = parse_chunk)]
    pub chunk_size: u64,
    /// Read the g1t token from stdin.
    #[arg(long)]
    pub token_stdin: bool,
    /// Push a tarball `docker save` wrote, instead of asking docker for the image.
    #[arg(long, value_name = "FILE", conflicts_with = "image")]
    pub archive: Option<PathBuf>,
}

fn parse_chunk(text: &str) -> Result<u64, String> {
    crate::chunk::check_chunk(crate::chunk::parse_size(text)?)
}
