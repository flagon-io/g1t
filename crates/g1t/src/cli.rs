//! The command line's shape: every command, flag and argument.

use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

pub const ABOUT: &str = "Work with g1t from the command line.";

pub const AFTER_HELP: &str = "\
Examples:
  g1t auth login
  g1t work list --label bug
  g1t pr create --fill
  g1t pr checks --watch --fail-fast
  g1t run logs --failed
  g1t workflow run release.yml -f channel=stable
  g1t api list_work_items --jq '.[].title'

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
    /// Repositories: view, clone, create, list, fork, sync.
    #[command(subcommand)]
    Repo(RepoCommand),
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
    /// The repository's actions/cache entries: list, usage, delete.
    #[command(subcommand)]
    Cache(CacheCommand),
    /// Deployments: list and view, and turn a project's g1t.page deployments on or off.
    #[command(subcommand)]
    Deploy(DeployCommand),
    /// A project's logs and errors.
    Logs(LogsArgs),
    /// What needs you: your pull requests, reviews asked of you, failing checks, and your sessions and claims here.
    Status(StatusArgs),
    /// Sessions: one run of an agent's harness, recorded as it works.
    #[command(subcommand)]
    Session(SessionCommand),
    /// Work items: list, view, new, edit, link, close; claims, hand-offs, dependencies, events.
    Work(WorkArgs),
    /// Why a file or line is as it is: its commit, pull request, work item, decisions and sessions.
    Why(WhyArgs),
    /// Upload images, such as a screenshot, to show in a work item, a pull request or a comment; prints their Markdown.
    Attach(AttachArgs),
    /// Call any API operation or path, with your token.
    Api(ApiArgs),
    /// Open the repository, a work item or a pull request in the browser.
    Browse(BrowseArgs),
    /// Shortcuts for commands you type often.
    #[command(subcommand)]
    Alias(AliasCommand),
    /// Print a shell completion script.
    Completion(CompletionArgs),
    /// Push a local container image to g1t's registry, in chunks.
    Push(PushArgs),
    /// Update g1t to the newest release, checked against g1t's release key.
    Upgrade(UpgradeArgs),
}

#[derive(Debug, Args)]
#[command(after_help = "\
Downloads the newest release for this machine from g1t.sh, checks its signature and SHA-256, and puts it
where this g1t is. In a terminal, g1t also says once a day when a newer release is out;
G1T_NO_UPDATE_NOTIFIER=1 turns that off.")]
pub struct UpgradeArgs {
    /// Only say whether a newer release is out.
    #[arg(long)]
    pub check: bool,
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
    /// Fork a repository into one of your workspaces.
    Fork(RepoForkArgs),
    /// List a repository's forks.
    Forks(RepoForksArgs),
    /// Bring a fork's branch up to date with the repository it was forked from.
    Sync(RepoSyncArgs),
    /// Make a fork an ordinary repository, no longer linked to its parent.
    Detach(RepoDetachArgs),
}

#[derive(Debug, Args)]
pub struct RepoForkArgs {
    /// OWNER/NAME; the current repository when left out.
    pub repository: Option<String>,
    /// The workspace to fork it into; your personal workspace when left out.
    #[arg(short, long)]
    pub workspace: Option<String>,
    /// The fork's name; the repository's own when left out.
    #[arg(long)]
    pub name: Option<String>,
    /// Copy every branch and tag, not only the default branch.
    #[arg(long)]
    pub all_branches: bool,
    /// Clone the fork, with the repository it came from as the remote upstream.
    #[arg(short, long)]
    pub clone: bool,
}

#[derive(Debug, Args)]
pub struct RepoForksArgs {
    /// OWNER/NAME; the current repository when left out.
    pub repository: Option<String>,
    #[arg(short = 'L', long, default_value_t = 30)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct RepoSyncArgs {
    /// The fork, OWNER/NAME; the one this directory pushes to (origin) when left out.
    pub repository: Option<String>,
    /// The fork's branch to sync; its default branch when left out.
    #[arg(short, long)]
    pub branch: Option<String>,
}

#[derive(Debug, Args)]
pub struct RepoDetachArgs {
    /// The fork, OWNER/NAME; the one this directory pushes to (origin) when left out.
    pub repository: Option<String>,
    /// Do not ask first.
    #[arg(short, long)]
    pub yes: bool,
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
    /// What it is, in a line: its project's description.
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
    /// Turn on its g1t.page deployments once it is made, so its first push deploys production.
    #[arg(long)]
    pub deploy: bool,
}

#[derive(Debug, Args)]
pub struct RepoListArgs {
    /// Only this workspace's.
    pub workspace: Option<String>,
    /// Only those whose name holds this.
    #[arg(short, long)]
    pub query: Option<String>,
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
}

// --- shared -----------------------------------------------------------

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
pub struct CommentArgs {
    /// The pull request's number; the current branch's when left out.
    pub number: Option<u64>,
    #[command(flatten)]
    pub body: BodyArgs,
    /// An image to show after the text (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more.
    #[arg(long, value_name = "FILE")]
    pub attach: Vec<PathBuf>,
}

#[derive(Debug, Args)]
pub struct ReopenArgs {
    pub number: u64,
    /// Leave a comment as it reopens.
    #[arg(short, long)]
    pub comment: Option<String>,
}

// --- pr ---------------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum PrCommand {
    /// List pull requests.
    List(PrListArgs),
    /// Show a pull request.
    View(PrViewArgs),
    /// Open a pull request from a branch, or start one for a work item.
    Create(PrCreateArgs),
    /// Check a pull request's changes out locally.
    Checkout(PrCheckoutArgs),
    /// Show a pull request's changes as a diff.
    Diff(PrDiffArgs),
    /// Show a pull request's checks; --watch waits for them.
    Checks(PrChecksArgs),
    /// Approve a pull request, or ask for changes.
    Review(PrReviewArgs),
    /// Merge a pull request, now or with auto-merge.
    Merge(PrMergeArgs),
    /// Bring a pull request's branch up to date with its base.
    UpdateBranch(PrUpdateBranchArgs),
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
    /// An image to show after the text (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more.
    #[arg(long, value_name = "FILE")]
    pub attach: Vec<PathBuf>,
    /// The branch to merge into; the default branch when left out.
    #[arg(short = 'B', long)]
    pub base: Option<String>,
    /// The branch with the changes; the current one when left out.
    #[arg(short = 'H', long)]
    pub head: Option<String>,
    /// The work item it is for, by its number in the workspace. Without a branch, starts a draft
    /// in a working copy of its own.
    #[arg(short, long)]
    pub item: Option<u64>,
    /// Take the title and body from the branch's commits.
    #[arg(short, long)]
    pub fill: bool,
    /// Open it as a draft.
    #[arg(short, long)]
    pub draft: bool,
    /// Do not push the branch first.
    #[arg(long)]
    pub no_push: bool,
    /// The fork, OWNER/NAME, that holds the branch. In a clone of your fork (origin) whose
    /// upstream is the repository, origin when left out.
    #[arg(long, value_name = "OWNER/NAME")]
    pub head_repo: Option<String>,
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
#[command(group(clap::ArgGroup::new("method").args(["merge", "squash", "rebase", "ff"])))]
pub struct PrMergeArgs {
    pub number: Option<u64>,
    /// Merge with a merge commit. The repository's default method when no method is given.
    #[arg(short, long)]
    pub merge: bool,
    /// Squash its commits into one.
    #[arg(short, long)]
    pub squash: bool,
    /// Make each of its commits again on top of the base.
    #[arg(short, long)]
    pub rebase: bool,
    /// Fast-forward: move the base to its head, with no new commit.
    #[arg(long)]
    pub ff: bool,
    /// The merge or squash commit's title; the repository's default when left out.
    #[arg(short = 't', long)]
    pub subject: Option<String>,
    /// The rest of the merge or squash commit's message.
    #[command(flatten)]
    pub body: BodyArgs,
    /// Merge on its own once its checks, reviews and rules allow.
    #[arg(long, conflicts_with_all = ["disable_auto", "keep_item_open", "admin", "delete_branch", "keep_branch", "match_head_commit"])]
    pub auto: bool,
    /// Turn its auto-merge off.
    #[arg(long, conflicts_with_all = ["method", "subject", "body", "body_file", "keep_item_open", "admin", "delete_branch", "keep_branch", "match_head_commit"])]
    pub disable_auto: bool,
    /// Do not land the work item it is for: it is only part of the work.
    #[arg(long)]
    pub keep_item_open: bool,
    /// Merge past failing required checks and rules (needs the Admin role).
    #[arg(long)]
    pub admin: bool,
    /// Delete its branch once merged, and the local branch. The repository's setting when left out.
    #[arg(short, long, conflicts_with = "keep_branch")]
    pub delete_branch: bool,
    /// Keep its branch, whatever the repository's setting.
    #[arg(long)]
    pub keep_branch: bool,
    /// Refuse to merge unless its head is still this commit.
    #[arg(long, value_name = "SHA")]
    pub match_head_commit: Option<String>,
}

#[derive(Debug, Args)]
pub struct PrUpdateBranchArgs {
    /// The number; the current branch's when left out.
    pub number: Option<u64>,
    /// Rebase its commits onto the base instead of merging the base in. Rewrites its branch.
    #[arg(long)]
    pub rebase: bool,
}

#[derive(Debug, Args)]
pub struct PrReadyArgs {
    pub number: Option<u64>,
    /// What changed and why; it becomes the description. The current one when left out.
    #[arg(short, long)]
    pub summary: Option<String>,
    /// An image to show after the summary (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more.
    #[arg(long, value_name = "FILE")]
    pub attach: Vec<PathBuf>,

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

// --- cache ------------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum CacheCommand {
    /// List the repository's cache entries, least recently used last.
    List(CacheListArgs),
    /// What the repository's cache entries hold, against its quota.
    Usage,
    /// Delete cache entries: one by its id, or every entry with a key.
    Delete(CacheDeleteArgs),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum CacheSort {
    /// When it was last restored or looked up.
    LastAccessedAt,
    CreatedAt,
    SizeInBytes,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum SortOrder {
    Asc,
    Desc,
}

#[derive(Debug, Args)]
pub struct CacheListArgs {
    /// Only entries whose key starts with this.
    #[arg(short, long)]
    pub key: Option<String>,
    /// Only entries saved by this ref's runs, e.g. refs/heads/main.
    #[arg(short, long = "ref", value_name = "REF")]
    pub git_ref: Option<String>,
    #[arg(short = 'S', long, value_enum, default_value_t = CacheSort::LastAccessedAt)]
    pub sort: CacheSort,
    #[arg(short = 'O', long, value_enum, default_value_t = SortOrder::Desc)]
    pub order: SortOrder,
    #[arg(short = 'L', long, default_value_t = 30)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct CacheDeleteArgs {
    /// An entry's id (a number, from `g1t cache list`), or a key: every entry with exactly that key.
    pub entry: String,
    /// With a key, only the entries this ref's runs saved.
    #[arg(short, long = "ref", value_name = "REF")]
    pub git_ref: Option<String>,
}

// --- deploy -----------------------------------------------------------

#[derive(Debug, Subcommand)]
pub enum DeployCommand {
    /// List deployments, newest first.
    List(DeployListArgs),
    /// Show a deployment and its statuses.
    View(DeployViewArgs),
    /// Show a project's g1t.page deployment settings, or change them with flags.
    Settings(DeploySettingsArgs),
    /// Turn on a project's g1t.page deployments: production builds from the default branch at once.
    Enable(DeployProjectArgs),
    /// Turn off a project's g1t.page deployments: production and every preview come down.
    Disable(DeployProjectArgs),
}

/// A setting turned on or off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Switch {
    On,
    Off,
}

#[derive(Debug, Args)]
pub struct DeployProjectArgs {
    /// The project, as SLUG or WORKSPACE/SLUG; the current repository's when left out.
    #[arg(short, long)]
    pub project: Option<String>,
}

#[derive(Debug, Args)]
pub struct DeploySettingsArgs {
    /// The project, as SLUG or WORKSPACE/SLUG; the current repository's when left out.
    #[arg(short, long)]
    pub project: Option<String>,
    /// Deploy the default branch on every push.
    #[arg(long, value_name = "SWITCH")]
    pub production: Option<Switch>,
    /// A preview for every branch with an open pull request.
    #[arg(long, value_name = "SWITCH")]
    pub previews: Option<Switch>,
    /// auto, static, workers or docker.
    #[arg(long, value_name = "KIND")]
    pub build_as: Option<String>,
    /// Runs instead of the project's own build script; "" for its own.
    #[arg(long, value_name = "COMMAND")]
    pub build_command: Option<String>,
    /// What a static site serves; "" to find it by itself.
    #[arg(long, value_name = "DIR")]
    pub output_dir: Option<String>,
    /// A container's Dockerfile, inside the project; "" for Dockerfile or Containerfile.
    #[arg(long, value_name = "PATH")]
    pub dockerfile: Option<String>,
    /// A container's size: lite, basic, standard-1 to standard-4.
    #[arg(long, value_name = "SIZE")]
    pub instance_type: Option<String>,
    /// A preview no one visits this many days comes down: 1 to 90.
    #[arg(long, value_name = "DAYS")]
    pub idle_days: Option<u32>,
    /// Build through the deploy workflow g1t manages for the project.
    #[arg(long, value_name = "SWITCH")]
    pub via_workflow: Option<Switch>,
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

// --- session ----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum Harness {
    // Spelled as the API spells it, which is what the plugin sends.
    #[value(name = "claude_code", alias = "claude-code")]
    ClaudeCode,
    Codex,
    Cursor,
    Copilot,
    Other,
}

impl Harness {
    pub fn name(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "claude_code",
            Harness::Codex => "codex",
            Harness::Cursor => "cursor",
            Harness::Copilot => "copilot",
            Harness::Other => "other",
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum SessionCommand {
    /// Start a session and remember it for this working copy. Prints its id.
    #[command(after_help = "\
The id is kept in .git/g1t/session (each worktree has its own); G1T_SESSION overrides it.
Starting again with the same --harness-session-id returns the same session.")]
    Start(SessionStartArgs),
    /// Say the current session is still working; renews its claims.
    #[command(after_help = "--usage-json reports the session's token usage so far, which g1t prices at Anthropic's list price:
a JSON list with one entry per model, each {model, tier?, input_tokens, output_tokens,
cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens}. It is cumulative, so it replaces
what the session reported before. - reads it from stdin.")]
    Heartbeat(SessionHeartbeatArgs),
    /// Record a note, prompt or message in the current session.
    Log(SessionLogArgs),
    /// Attach the current session to a work item, a pull request or a branch, or give it a title.
    Attach(SessionAttachArgs),
    /// End the current session.
    End(SessionEndArgs),
    /// List the repository's sessions.
    List(SessionListArgs),
    /// Show a session and what it recorded; the current one when left out.
    View(SessionViewArgs),
    /// Read pending coordination updates without acknowledging them.
    #[command(after_help = "
First says which files this working copy changed (git status, from its root), as `session touch`
would, so another session changing the same files is an overlap.detected for both: heartbeat and
acknowledge do too. G1T_TOUCH=0 turns that off.")]
    Updates(SessionViewArgs),
    /// Record your decision, then acknowledge exact coordination update IDs.
    Acknowledge(SessionAcknowledgeArgs),
    /// Say what the current session touched: files, commits, branches, pull requests, work items.
    #[command(after_help = "\nEach is kept once. A file another active session touched too (a sibling subagent's included)
is an overlap.detected event for both. Pull requests and work items tie the session to them.")]
    Touch(SessionTouchArgs),
}

#[derive(Debug, Args)]
#[command(group(clap::ArgGroup::new("what").required(true).multiple(true).args(["file", "commit", "branch", "pull", "item"])))]
pub struct SessionTouchArgs {
    /// A file it wrote, from the repository's root. Repeat for more.
    #[arg(long)]
    pub file: Vec<String>,
    /// A commit it made.
    #[arg(long)]
    pub commit: Vec<String>,
    /// A branch it pushed.
    #[arg(long)]
    pub branch: Vec<String>,
    /// A pull request it opened.
    #[arg(long)]
    pub pull: Vec<u64>,
    /// A work item it named, by its number in the workspace.
    #[arg(long)]
    pub item: Vec<u64>,
}

#[derive(Debug, Args)]
pub struct SessionStartArgs {
    /// The work item it works on, by its number in the workspace.
    #[arg(short, long)]
    pub item: Option<u64>,
    /// The pull request it works on.
    #[arg(short, long)]
    pub pull: Option<u64>,
    /// The harness running it.
    #[arg(long, value_enum, default_value_t = Harness::Other)]
    pub harness: Harness,
    /// The harness's own id for the run, which makes starting again return the same session.
    #[arg(long, value_name = "ID")]
    pub harness_session_id: Option<String>,
    #[arg(short, long)]
    pub title: Option<String>,
    /// The branch it works on; the current one when left out.
    #[arg(short, long)]
    pub branch: Option<String>,
    /// For a subagent: the session that started it (ses_…).
    #[arg(long, value_name = "SESSION")]
    pub parent: Option<String>,
    /// For a subagent: its kind (Explore, security-reviewer).
    #[arg(long)]
    pub agent_type: Option<String>,
    /// For a subagent: the task it was given, in a few words.
    #[arg(long)]
    pub task: Option<String>,
    /// For a subagent: the prompt its parent gave it.
    #[arg(long)]
    pub prompt: Option<String>,
    /// The model it runs on.
    #[arg(long)]
    pub model: Option<String>,
    /// Do not remember it as this working copy's session (a subagent's, kept by its harness).
    #[arg(long)]
    pub no_remember: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum EntryKind {
    Note,
    Prompt,
    Message,
    // Spelled as the API spells it, which is what the plugin sends.
    #[value(name = "tool_call", alias = "tool-call")]
    ToolCall,
    /// A skill the session used: give its name.
    Skill,
}

impl EntryKind {
    pub fn name(self) -> &'static str {
        match self {
            EntryKind::Note => "note",
            EntryKind::Prompt => "prompt",
            EntryKind::Message => "message",
            EntryKind::ToolCall => "tool_call",
            EntryKind::Skill => "skill",
        }
    }
}

#[derive(Debug, Args)]
pub struct SessionLogArgs {
    /// What to record; - reads it from stdin.
    pub text: String,
    #[arg(short, long, value_enum, default_value_t = EntryKind::Note)]
    pub kind: EntryKind,
    /// The tool, for a tool_call.
    #[arg(long)]
    pub tool: Option<String>,
    /// A key that makes recording it again do nothing.
    #[arg(long)]
    pub key: Option<String>,
}

#[derive(Debug, Args)]
#[command(group(clap::ArgGroup::new("what").required(true).multiple(true).args(["item", "pull", "branch", "head_commit", "title"])))]
pub struct SessionAttachArgs {
    /// A work item, by its number in the workspace.
    #[arg(short, long)]
    pub item: Option<u64>,
    #[arg(short, long)]
    pub pull: Option<u64>,
    #[arg(short, long)]
    pub branch: Option<String>,
    /// The commit it pushed last.
    #[arg(long, value_name = "SHA")]
    pub head_commit: Option<String>,
    /// What it is for, in a few words; replaces its title.
    #[arg(short, long)]
    pub title: Option<String>,
}

#[derive(Debug, Args)]
pub struct SessionHeartbeatArgs {
    /// The session's token usage so far, per model, as JSON; - reads it from stdin.
    #[arg(long, value_name = "JSON")]
    pub usage_json: Option<String>,
}

#[derive(Debug, Args)]
pub struct SessionEndArgs {
    /// Why it ended: done, abandoned, handed_off...
    #[arg(short, long)]
    pub reason: Option<String>,
    /// What it reported when it finished (a subagent's final message); - reads it from stdin.
    #[arg(long)]
    pub result: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum SessionState {
    Active,
    Idle,
    Ended,
}

#[derive(Debug, Args)]
pub struct SessionListArgs {
    /// Only sessions in this state.
    #[arg(short, long, value_enum)]
    pub state: Option<SessionState>,
    /// Only sessions on this work item.
    #[arg(short, long)]
    pub item: Option<u64>,
    #[arg(short, long)]
    pub pull: Option<u64>,
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
    /// Only sessions that touched this file, or any under it when it ends in /.
    #[arg(long)]
    pub path: Option<String>,
    /// List subagents too, under the sessions that started them.
    #[arg(long)]
    pub subagents: bool,
    /// Every repository of a workspace you may read, every kind of session:
    /// this repository's workspace, or the one named.
    #[arg(long, value_name = "SLUG", num_args = 0..=1, default_missing_value = "")]
    pub workspace: Option<String>,
    /// With --workspace: only sessions in this harness (claude_code, codex, …).
    #[arg(long, requires = "workspace")]
    pub harness: Option<String>,
    /// With --workspace: only sessions this person runs, by username.
    #[arg(long, requires = "workspace")]
    pub person: Option<String>,
    /// With --workspace: only sessions in this repository of it, by name.
    #[arg(long = "in", value_name = "NAME", requires = "workspace")]
    pub in_repo: Option<String>,
}

#[derive(Debug, Args)]
pub struct SessionViewArgs {
    /// The session's id (ses_…); the current one when left out.
    pub id: Option<String>,
}

#[derive(Debug, Args)]
pub struct SessionAcknowledgeArgs {
    /// IDs you have considered. Never pass unseen updates. At most 100.
    #[arg(required = true, num_args = 1..=100)]
    pub updates: Vec<String>,
    /// What changed in your plan, or why no change is needed.
    #[arg(long)]
    pub note: String,
    /// Use this session instead of G1T_SESSION or the working copy's session.
    #[arg(long)]
    pub session: Option<String>,
}

// --- work -------------------------------------------------------------

#[derive(Debug, Args)]
pub struct WorkArgs {
    /// The workspace, by its slug; the current repository's when left out.
    #[arg(long, global = true, value_name = "SLUG", env = "G1T_WORKSPACE")]
    pub workspace: Option<String>,
    #[command(subcommand)]
    pub command: WorkCommand,
}

#[derive(Debug, Subcommand)]
pub enum WorkCommand {
    /// List the workspace's work items; with --repo, those linked to that repository.
    List(WorkListArgs),
    /// Show a work item with everything about its work: repositories and what landed, claims,
    /// sessions, pull requests, what it waits on, decisions.
    View(WorkViewArgs),
    /// Open a work item, with the current repository as its origin.
    #[command(after_help = "\nIn a repository, the work item is filed from it (its origin). With --workspace and no
repository of that workspace here, it is filed in the workspace alone. --target names a repository
where the work is meant to land; repeat it for more.
Examples:
  g1t work new --title \"Sign-in times out on slow networks\" --body \"...\"
  g1t work new --title \"Rename the flag\" --target acme/api --target acme/docs")]
    New(WorkNewArgs),
    /// Comment on a work item.
    Comment(WorkCommentArgs),
    /// Change a work item's title, body, labels, assignees or milestone.
    Edit(WorkEditArgs),
    /// Close a work item.
    Close(WorkCloseArgs),
    /// Reopen a work item.
    Reopen(ReopenArgs),
    /// Link a repository to a work item: where the work must land (target), or touched.
    #[command(after_help = "\nThe repository is the current one, or --repo OWNER/NAME. A work item with targets closes once it
has landed in every one.
Examples:
  g1t work link 12 --repo acme/api
  g1t work link 12 --role touched")]
    Link(WorkLinkArgs),
    /// Unlink a repository from a work item (never its origin).
    Unlink(WorkNumber),
    /// Claim a work item: say you are working on it. Others are told, never stopped.
    #[command(after_help = "\nWith --title instead of a number, a new work item is opened (filed from the current repository)
and claimed in one step, and the current session is attached to it: for work that became a change
others should know about.
Examples:
  g1t work claim 12 --note \"Rewriting the retry loop\"
  g1t work claim --title \"Preview builds time out on large repositories\"")]
    Claim(WorkClaimArgs),
    /// Release your claim on a work item.
    Release(WorkReleaseArgs),
    /// Hand a work item over to someone else, or to anyone.
    Handoff(WorkHandoffArgs),
    /// Active claims and sessions in the repository.
    Status,
    /// Say a work item waits on others: it is blocked by them.
    Block(WorkBlockArgs),
    /// Say a work item no longer waits on others.
    Unblock(WorkBlockArgs),
    /// The repository's events; --follow keeps printing them as they happen.
    #[command(after_help = "\
Examples:
  g1t work events --follow --item 12
  g1t work events --follow --type integration.failed --type overlap.detected --json
With --json, each event is one JSON object on a line of its own.")]
    Events(WorkEventsArgs),
    /// Start work on a work item in a session on your own Claude, or print the Claude Code command for it.
    #[command(after_help = "\nWith the workspace's Anthropic AI provider, a Claude Managed Agents session starts on that
account and is recorded on g1t; otherwise (or with --handoff) this prints a `claude` command
to run with g1t's plugin, whose session attaches to the work item as it starts.
Examples:
  g1t work dispatch 12
  g1t work dispatch 12 --mode plan --instruction \"Keep the old flag\"
  g1t work dispatch --title \"Add a healthcheck\" --handoff")]
    Dispatch(WorkDispatchArgs),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum ItemState {
    Open,
    Closed,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum LinkRole {
    Origin,
    Target,
    Touched,
}

impl LinkRole {
    pub fn name(self) -> &'static str {
        match self {
            LinkRole::Origin => "origin",
            LinkRole::Target => "target",
            LinkRole::Touched => "touched",
        }
    }
}

/// The roles a repository can be linked in by hand: the origin is where a
/// work item was filed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum LinkAs {
    Target,
    Touched,
}

impl LinkAs {
    pub fn name(self) -> &'static str {
        match self {
            LinkAs::Target => "target",
            LinkAs::Touched => "touched",
        }
    }
}

#[derive(Debug, Args)]
pub struct WorkListArgs {
    #[arg(short, long, value_enum, default_value_t = ItemState::Open)]
    pub state: ItemState,
    /// Only work items with this label.
    #[arg(short, long)]
    pub label: Option<String>,
    /// Only work items in the workspace milestone of this number.
    #[arg(short, long)]
    pub milestone: Option<u64>,
    /// Only work items assigned to this person (@me for you).
    #[arg(short, long)]
    pub assignee: Option<String>,
    /// Only work items opened by this person (@me for you).
    #[arg(short = 'A', long)]
    pub author: Option<String>,
    /// With --repo: only those linked to it this way.
    #[arg(long, value_enum)]
    pub role: Option<LinkRole>,
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct WorkViewArgs {
    /// The work item's number.
    pub number: u64,
    /// Show its comments too.
    #[arg(short, long)]
    pub comments: bool,
    /// Open it in the browser.
    #[arg(short, long)]
    pub web: bool,
}

#[derive(Debug, Args)]
pub struct WorkNewArgs {
    #[arg(short, long)]
    pub title: Option<String>,
    #[command(flatten)]
    pub body: BodyArgs,
    /// An image to show after the text (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more.
    #[arg(long, value_name = "FILE")]
    pub attach: Vec<PathBuf>,
    /// A repository of the workspace where the work is meant to land, OWNER/NAME; repeat for more.
    #[arg(long, value_name = "OWNER/NAME")]
    pub target: Vec<String>,
    /// A label; repeat for more.
    #[arg(short, long)]
    pub label: Vec<String>,
    /// Someone to assign; repeat for more (@me for you).
    #[arg(short, long)]
    pub assignee: Vec<String>,
    /// A workspace milestone's number.
    #[arg(short, long)]
    pub milestone: Option<u64>,
    /// Open the new work item page in the browser instead.
    #[arg(short, long)]
    pub web: bool,
}

#[derive(Debug, Args)]
pub struct WorkCommentArgs {
    /// The work item's number.
    pub number: u64,
    #[command(flatten)]
    pub body: BodyArgs,
    /// An image to show after the text (PNG, JPEG, GIF or WebP, at most 10 MB): uploaded, and its Markdown added. Repeat for more.
    #[arg(long, value_name = "FILE")]
    pub attach: Vec<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum CloseReason {
    Completed,
    // Spelled as the API spells it.
    #[value(name = "not_planned", alias = "not-planned")]
    NotPlanned,
}

#[derive(Debug, Args)]
pub struct WorkCloseArgs {
    pub number: u64,
    #[arg(short, long, value_enum)]
    pub reason: Option<CloseReason>,
    /// Leave a comment as it closes.
    #[arg(short, long)]
    pub comment: Option<String>,
    /// The commit on the repository's default branch that did it: its message names the work item
    /// after a closing keyword (Fixes #12). Its full hash. It lands there; the work item closes when
    /// nothing else is left to land.
    #[arg(long)]
    pub commit: Option<String>,
}

#[derive(Debug, Args)]
pub struct WorkEditArgs {
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
    /// A workspace milestone's number.
    #[arg(short, long)]
    pub milestone: Option<u64>,
    /// Take it out of its milestone.
    #[arg(long, conflicts_with = "milestone")]
    pub remove_milestone: bool,
}

#[derive(Debug, Args)]
pub struct WorkLinkArgs {
    /// The work item's number.
    pub number: u64,
    /// How the repository is linked.
    #[arg(long, value_enum, default_value_t = LinkAs::Target)]
    pub role: LinkAs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum DispatchMode {
    Plan,
    Implement,
    Review,
}

impl DispatchMode {
    pub fn name(self) -> &'static str {
        match self {
            DispatchMode::Plan => "plan",
            DispatchMode::Implement => "implement",
            DispatchMode::Review => "review",
        }
    }
}

#[derive(Debug, Args)]
#[command(group(clap::ArgGroup::new("which").required(true).args(["number", "title"])))]
pub struct WorkDispatchArgs {
    /// The work item's number.
    pub number: Option<u64>,
    /// Open a new work item with this title and work on it.
    #[arg(long, conflicts_with = "number")]
    pub title: Option<String>,
    /// The new work item's description.
    #[arg(long, requires = "title")]
    pub body: Option<String>,
    /// What to do beyond what the work item says.
    #[arg(short, long)]
    pub instruction: Option<String>,
    /// What kind of work.
    #[arg(short, long, value_enum)]
    pub mode: Option<DispatchMode>,
    /// Print the Claude Code command to run yourself; start nothing.
    #[arg(long, conflicts_with = "managed")]
    pub handoff: bool,
    /// Start it on the workspace's Anthropic account, or fail.
    #[arg(long)]
    pub managed: bool,
}

#[derive(Debug, Args)]
pub struct WorkNumber {
    /// The work item's number.
    pub number: u64,
}

#[derive(Debug, Args)]
#[command(group(clap::ArgGroup::new("which").required(true).args(["number", "title"])))]
pub struct WorkClaimArgs {
    /// The work item's number.
    pub number: Option<u64>,
    /// Open a new work item with this title and claim it; the current session is attached to it.
    #[arg(long, conflicts_with = "number")]
    pub title: Option<String>,
    /// The new work item's description.
    #[arg(long, requires = "title")]
    pub body: Option<String>,
    /// What you are doing about it.
    #[arg(short, long)]
    pub note: Option<String>,
    /// How long the claim lasts unless renewed: 30m, 2h (at most 4h).
    #[arg(long, value_name = "DURATION", value_parser = parse_ttl)]
    pub ttl: Option<u64>,
}

#[derive(Debug, Args)]
pub struct WorkReleaseArgs {
    pub number: u64,
    /// Why: done, blocked, abandoned...
    #[arg(short, long)]
    pub reason: Option<String>,
}

#[derive(Debug, Args)]
pub struct WorkHandoffArgs {
    pub number: u64,
    /// Who takes it over; anyone when left out.
    #[arg(long, value_name = "LOGIN")]
    pub to: Option<String>,
    /// Where it stands and what is left, for whoever takes it.
    #[arg(short, long)]
    pub note: String,
}

#[derive(Debug, Args)]
pub struct WorkBlockArgs {
    /// The work item that waits.
    pub number: u64,
    /// The work item it waits on; repeat for more.
    #[arg(long = "by", value_name = "NUMBER", required = true)]
    pub by: Vec<u64>,
}

#[derive(Debug, Args)]
pub struct WorkEventsArgs {
    /// Keep printing events as they happen, until stopped.
    #[arg(short, long)]
    pub follow: bool,
    /// Only events of this type; repeat for more.
    #[arg(short = 't', long = "type", value_name = "TYPE")]
    pub types: Vec<String>,
    /// Only events about this work item or pull request; repeat for more.
    #[arg(short = 'i', long = "item", value_name = "NUMBER")]
    pub items: Vec<u64>,
    /// Only events since then: 15m, 2h, 1d, or a time like 2026-10-12T09:00:00Z.
    #[arg(short, long)]
    pub since: Option<String>,
    /// Start after this event id, as a follow that stopped would resume.
    #[arg(long, value_name = "EVENT_ID")]
    pub after: Option<String>,
    /// How many past events to show first.
    #[arg(short = 'L', long, default_value_t = 20)]
    pub limit: usize,
}

/// `30m`, `2h`, `90` (minutes) as minutes, from 1 minute to 4 hours.
pub fn parse_ttl(text: &str) -> Result<u64, String> {
    let text = text.trim();
    let (number, unit) = text.split_at(text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len()));
    let wrong = || format!("`{text}` is not a duration: write it as 30m or 2h");
    let number: u64 = number.parse().map_err(|_| wrong())?;
    let minutes = match unit {
        "" | "m" | "min" => number,
        "h" => number * 60,
        _ => return Err(wrong()),
    };
    if minutes == 0 || minutes > 240 {
        return Err("a claim lasts from 1 minute to 4 hours".to_owned());
    }
    Ok(minutes)
}

// --- attach -----------------------------------------------------------

#[derive(Debug, Args)]
#[command(after_help = "\
Prints each image's Markdown, ![name](url), to paste into a description or a comment; --json prints
{ id, name, url, markdown, content_type, size } (a list for several files). The image is served from
g1t's usercontent address, and anyone given that address can see it, even from a private repository.
--attach FILE on g1t work new, g1t work comment, g1t pr create, g1t pr comment and g1t pr ready
uploads and adds the Markdown for you:
  g1t attach preview.png
  g1t pr comment --body 'The preview, after the fix:' --attach preview.png")]
pub struct AttachArgs {
    /// The files: PNG, JPEG, GIF or WebP, at most 10 MB each.
    #[arg(required = true, value_name = "FILE")]
    pub files: Vec<PathBuf>,
}

// --- why --------------------------------------------------------------

#[derive(Debug, Args)]
pub struct WhyArgs {
    /// A file, or a line of it as PATH:LINE.
    pub target: String,
    /// The branch, tag or commit to read it at; the default branch when left out.
    #[arg(long = "ref", value_name = "REF")]
    pub reference: Option<String>,
}

// --- status, api, browse ---------------------------------------------

#[derive(Debug, Args)]
pub struct StatusArgs {}

#[derive(Debug, Args)]
#[command(after_help = "\
ENDPOINT is an operation's name (list_work_items) or a path (/workspaces/{workspace}/work).
{owner}, {name}, {repo} and {workspace} are filled in from the current repository,
and an operation's other path parameters from -f/-F fields of the same name.

Examples:
  g1t api list_work_items -f state=closed
  g1t api /user --jq .username
  g1t api open_work_item -f title='Broken link' -f labels[]=docs
  g1t api list_workflow_runs --paginate --jq '.[].conclusion'
  g1t api --list work")]
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
    /// A work item or pull request number, a file path (path:line), or a commit.
    pub target: Option<String>,
    /// The branch to show files on.
    #[arg(short, long)]
    pub branch: Option<String>,
    #[arg(short, long)]
    pub settings: bool,
    /// The repository's work items: the workspace's Work list, filtered to it.
    #[arg(long)]
    pub work: bool,
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

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::Parser;
    use serde_json::Value;

    /// Every command the Claude Code plugin's hooks run, from the contract
    /// their tests hold them to (plugins/claude-code/test/cli-contract.json),
    /// with every value each flag is given there, parses here.
    #[test]
    fn the_plugin_hooks_commands_parse() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../plugins/claude-code/test/cli-contract.json"
        );
        let contract: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut checked = 0;
        for command in contract["commands"].as_array().unwrap() {
            let words: Vec<String> = command["command"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_str().unwrap().to_owned())
                .collect();
            let flags = command["flags"].as_object().unwrap();
            // One argv for each value of each flag, with every other flag too.
            let mut variants: Vec<Vec<(String, Option<String>)>> = vec![vec![]];
            for (flag, kind) in flags {
                let values: Vec<Option<String>> = match kind {
                    Value::Array(values) => values
                        .iter()
                        .map(|v| Some(v.as_str().unwrap().to_owned()))
                        .collect(),
                    Value::String(kind) => match kind.as_str() {
                        // Spaced, and as --flag=VALUE, which the hooks use for
                        // text that may start with a dash.
                        "text" => vec![
                            Some("a text, with spaces".into()),
                            Some("=- a text that starts with a dash".into()),
                        ],
                        "number" => vec![Some("42".into())],
                        "switch" | "json" => vec![None],
                        other => panic!("{flag}: no type {other}"),
                    },
                    other => panic!("{flag}: {other}"),
                };
                let mut next = Vec::new();
                for variant in &variants {
                    for value in &values {
                        let mut v = variant.clone();
                        v.push((flag.clone(), value.clone()));
                        next.push(v);
                    }
                }
                variants = next;
            }
            let dash_dash = command["dash_dash"].as_bool().unwrap_or(false);
            // A text positional after -- may start with a dash.
            let positionals: Vec<String> = command["positionals"]
                .as_array()
                .map(|p| {
                    p.iter()
                        .map(|k| match (k.as_str(), dash_dash) {
                            (Some("number"), _) => "42".to_owned(),
                            (_, true) => "-a text that starts with a dash".to_owned(),
                            _ => "a_text".to_owned(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            for variant in variants {
                let mut argv = vec!["g1t".to_owned()];
                argv.extend(words.iter().cloned());
                // --json last: with nothing after it, it takes no fields.
                let mut json = false;
                for (flag, value) in &variant {
                    if flag == "--json" {
                        json = true;
                        continue;
                    }
                    match value {
                        Some(v) if v.starts_with('=') => argv.push(format!("{flag}{v}")),
                        _ => {
                            argv.push(flag.clone());
                            argv.extend(value.iter().cloned());
                        }
                    }
                }
                if dash_dash {
                    argv.push("--".into());
                }
                argv.extend(positionals.iter().cloned());
                if json {
                    argv.push("--json".into());
                }
                match Cli::try_parse_from(&argv) {
                    Ok(_) => {}
                    Err(e) if e.kind() == clap::error::ErrorKind::DisplayVersion => {}
                    Err(e) => panic!("the plugin runs {argv:?}, which the CLI refuses: {e}"),
                }
                checked += 1;
            }
        }
        assert!(checked >= 10, "checked {checked}");
        // This CLI is at least the version the hooks ask for.
        let version = |v: &str| {
            v.split('.')
                .map(|n| n.parse::<u32>().unwrap())
                .collect::<Vec<_>>()
        };
        let minimum = contract["minimum_version"].as_str().unwrap();
        assert!(
            version(env!("CARGO_PKG_VERSION")) >= version(minimum),
            "the hooks need {minimum}"
        );
    }

    #[test]
    fn entry_kinds_take_both_spellings() {
        for kind in ["tool_call", "tool-call"] {
            let cli = Cli::try_parse_from(["g1t", "session", "log", "--kind", kind, "x"]).unwrap();
            let super::Command::Session(super::SessionCommand::Log(args)) = cli.command else {
                panic!("not session log")
            };
            assert_eq!(args.kind.name(), "tool_call");
        }
    }

    /// `work claim` takes a work item's number, or a title for a new one, never both.
    #[test]
    fn a_claim_names_a_work_item_or_a_title_for_a_new_one() {
        let claim = |argv: &[&str]| {
            let mut all = vec!["g1t", "work", "claim"];
            all.extend_from_slice(argv);
            Cli::try_parse_from(all).map(|cli| match cli.command {
                super::Command::Work(super::WorkArgs { command: super::WorkCommand::Claim(args), .. }) => args,
                _ => panic!("not work claim"),
            })
        };
        let by_number = claim(&["12", "--note", "on it"]).unwrap();
        assert_eq!((by_number.number, by_number.title), (Some(12), None));
        let new = claim(&["--title", "Preview builds time out", "--body", "On repositories over 1 GB."]).unwrap();
        assert_eq!(new.number, None);
        assert_eq!(new.title.as_deref(), Some("Preview builds time out"));
        assert_eq!(new.body.as_deref(), Some("On repositories over 1 GB."));
        assert!(claim(&[]).is_err());
        assert!(claim(&["12", "--title", "x"]).is_err());
        // --body goes with --title: claim() refuses it with a number.
    }

    #[test]
    fn a_session_takes_a_title_on_its_own() {
        let cli = Cli::try_parse_from(["g1t", "session", "attach", "--title", "Fix the preview builds"]).unwrap();
        let super::Command::Session(super::SessionCommand::Attach(args)) = cli.command else {
            panic!("not session attach")
        };
        assert_eq!(args.title.as_deref(), Some("Fix the preview builds"));
        assert!(Cli::try_parse_from(["g1t", "session", "attach"]).is_err());
    }
    #[test]
    fn harness_neutral_updates_and_acknowledgements_parse() {
        for args in [
            vec!["g1t", "session", "updates", "--json"],
            vec!["g1t", "session", "updates", "ses_child", "--json"],
            vec!["g1t", "session", "acknowledge", "upd_a", "upd_b", "--session", "ses_child", "--note", "My scope is separate"],
        ] { assert!(Cli::try_parse_from(args).is_ok()); }
        assert!(Cli::try_parse_from(["g1t", "session", "acknowledge", "upd_a"]).is_err());
        assert!(Cli::try_parse_from(["g1t", "session", "acknowledge", "--note", "No IDs"]).is_err());
    }


    #[test]
    fn work_items_take_a_workspace_and_there_is_no_issue_command() {
        let cli = Cli::try_parse_from(["g1t", "work", "list", "--workspace", "acme", "--label", "bug"]).unwrap();
        let super::Command::Work(work) = cli.command else { panic!("not work") };
        assert_eq!(work.workspace.as_deref(), Some("acme"));
        assert!(Cli::try_parse_from(["g1t", "work", "view", "12", "--workspace", "acme"]).is_ok());
        assert!(Cli::try_parse_from(["g1t", "work", "link", "12", "--role", "touched", "-R", "acme/api"]).is_ok());
        assert!(Cli::try_parse_from(["g1t", "work", "link", "12", "--role", "origin"]).is_err());
        assert!(Cli::try_parse_from(["g1t", "work", "close", "12", "--commit", "9f2c4e1"]).is_ok());
        assert!(Cli::try_parse_from(["g1t", "work", "events", "-i", "12"]).is_ok());
        assert!(Cli::try_parse_from(["g1t", "pr", "create", "--item", "12"]).is_ok());
        assert!(Cli::try_parse_from(["g1t", "issue", "list"]).is_err());
        assert!(Cli::try_parse_from(["g1t", "pr", "create", "--issue", "12"]).is_err());
    }
}
