/**
 * What g1t does when a comment mentions `@g1t-agent`: what it is asked,
 * through the flows that already exist. On an issue, a request assigns it
 * and a question is answered in the thread. On a pull request g1t-agent
 * made, a request sends it back to revise, with the comment as what to
 * address. On any pull request, a review request starts a review and a
 * question is answered. Each mention is one run at most, and g1t-agent says
 * in the thread what it did, or why it did nothing.
 *
 * Only type imports, so it can be tested on its own.
 */
import type { Comment, LifecycleJob, MentionJob, MentionsApi, Pull, RepoPath, Result, User } from "@g1t/contracts";

/** What a mention leads to. */
export type MentionPlan =
  | { kind: "not_member" }
  | { kind: "closed"; reason: string }
  /** Assign the issue to g1t-agent: it opens a pull request and makes the change. */
  | { kind: "assign" }
  /** Answer in the thread, reading the code, changing nothing. */
  | { kind: "answer" }
  /** Send g1t-agent back to the pull request it made, to address the comment. */
  | { kind: "revise" }
  /** Pass the comment to g1t-agent while it is still making the change. */
  | { kind: "message" }
  | { kind: "review" };

export function planMention(job: MentionJob): MentionPlan {
  if (!job.member) return { kind: "not_member" };
  const { pull, intent } = job;
  if (!pull) {
    if (intent !== "work") return { kind: "answer" };
    if (job.issueOpen === false) return { kind: "closed", reason: "This issue is closed, so there is nothing to start on." };
    if (job.workingPull != null) {
      return { kind: "closed", reason: `I am already working on this in #${job.workingPull}. Mention me there to change what I am doing.` };
    }
    return { kind: "assign" };
  }
  const done = pull.status === "merged" || pull.status === "closed";
  if (intent === "question") return { kind: "answer" };
  if (done) return { kind: "closed", reason: `This pull request is already ${pull.status}.` };
  if (intent === "review") return { kind: "review" };
  if (pull.agentAuthored) return pull.status === "draft" ? { kind: "message" } : { kind: "revise" };
  // Someone else's change is theirs to make: say what to change instead.
  return { kind: "answer" };
}

/** What `handleMention` needs from the runner. */
export interface MentionPorts {
  mentions: MentionsApi;
  /** Why `actor` cannot put g1t agents to work in `repo` now, or null. */
  refusal(actor: User, repo: RepoPath): Promise<string | null>;
  assign(job: MentionJob): Promise<Result<Pull>>;
  revise(job: LifecycleJob, startedBy: string): Promise<void>;
  review(job: MentionJob): Promise<Result<boolean>>;
  answer(job: MentionJob): Promise<Result<true>>;
  message(job: MentionJob): Promise<Result<unknown>>;
  /** Records a mention that started nothing as a failed agent run, so it shows with the others. */
  record(job: MentionJob, why: string): Promise<void>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Acts on one mention, taken from the work service. Never throws. */
export async function handleMention(job: MentionJob, ports: MentionPorts): Promise<MentionPlan> {
  const plan = planMention(job);
  const who = `@${job.actor.username}`;
  const reply = (text: string) => ports.mentions.replyMention(job.commentId, text).catch(() => false);
  const refuse = async (why: string) => {
    await ports.record(job, why).catch(() => undefined);
    await reply(`${who}, I could not start on this: ${why}`);
  };
  try {
    if (plan.kind === "not_member") {
      await reply(
        `Thanks for the mention, ${who}. Only members of the ${job.repo.namespace} workspace can put g1t-agent to work here, so I have left this for them.`,
      );
      return plan;
    }
    if (plan.kind === "closed") {
      await reply(`Thanks, ${who}. ${plan.reason}`);
      return plan;
    }
    const refused = await ports.refusal(job.actor, job.repo);
    if (refused) {
      await refuse(refused);
      return plan;
    }
    switch (plan.kind) {
      case "assign": {
        const started = await ports.assign(job);
        if (!started.ok) await refuse(started.error.message);
        else await reply(`On it, ${who}: I opened #${started.value.number} and will mark it ready for review when the change is made.`);
        break;
      }
      case "revise": {
        const revision = await ports.mentions.mentionRevision(job.commentId);
        if (!revision.ok) {
          // A step is already under way: what was said reaches it as a message.
          if (revision.error.code === "conflict") {
            const sent = await ports.message(job);
            if (sent.ok) {
              await reply(`${who}, I am already working on this pull request, so I have passed your comment on: I read it at my next step.`);
              break;
            }
          }
          await refuse(revision.error.message);
          break;
        }
        await ports.revise(revision.value, job.actor.username);
        await reply(`Going back to this, ${who}. I will push the change here when it is made.`);
        break;
      }
      case "message": {
        const sent = await ports.message(job);
        if (!sent.ok) await refuse(sent.error.message);
        else await reply(`${who}, I am still making this change, so I have passed your comment on: I read it at my next step.`);
        break;
      }
      case "review": {
        const started = await ports.review(job);
        if (!started.ok) await refuse(started.error.message);
        else await reply(`Reviewing this now, ${who}. The review will be posted here.`);
        break;
      }
      case "answer": {
        // The answer is the reply, posted by the run itself.
        const started = await ports.answer(job);
        if (!started.ok) await refuse(started.error.message);
        break;
      }
    }
  } catch (error) {
    await refuse(reason(error));
  }
  return plan;
}

/** Longest the conversation before a question is passed on. */
const MAX_THREAD_CHARS = 6000;

/** A thread's comments up to and including `commentId`, oldest first, for an agent answering in it. */
export function describeThread(comments: Comment[], commentId: string): string | null {
  const upTo = comments.findIndex((comment) => comment.id === commentId);
  const said = (upTo < 0 ? comments : comments.slice(0, upTo))
    .filter((comment) => comment.kind !== "event" && comment.body.trim())
    .map((comment) => {
      const where = comment.path ? ` on ${comment.path}${comment.line ? ` line ${comment.line}` : ""}` : "";
      return `- ${comment.author.username}${where}: ${comment.body.trim()}`;
    });
  if (said.length === 0) return null;
  const text = said.join("\n");
  return text.length > MAX_THREAD_CHARS ? `…${text.slice(-MAX_THREAD_CHARS)}` : text;
}

/** What the agent is told when asked something in a comment. */
export function buildMentionPrompt(job: MentionJob, context: { title: string; body: string; thread: string | null }): string {
  const where = job.pull
    ? `pull request #${job.number}, checked out at its head`
    : `issue #${job.number}, with the repository checked out at its default branch, ${job.defaultBranch}`;
  const parts = [
    `You are g1t-agent, a coding agent. ${job.actor.username} mentioned you in a comment on ${where}. The repository is in the current directory. Answer what they asked.`,
    `${job.pull ? "Pull request" : "Issue"} #${job.number}: ${context.title}`,
    context.body,
    context.thread && `The conversation so far, oldest first:\n\n${context.thread}`,
    `What ${job.actor.username} wrote, mentioning you:\n\n${job.body.trim()}`,
    job.pull && !job.pull.agentAuthored
      ? "This change is someone else's, and you cannot push to it. If they asked for a change, say exactly what you would change and where, with a short patch in a code block where that helps."
      : null,
    job.pull
      ? "Do not change any files."
      : "Do not change any files. If answering properly needs work done, say so, and say that mentioning @g1t-agent with a request (such as \"@g1t-agent take this\") starts it.",
  ];
  return parts.filter(Boolean).join("\n\n");
}
