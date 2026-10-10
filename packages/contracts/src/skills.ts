/**
 * Agent skills (docs.g1t.sh/guides/agent-skills/): how an agent does a kind
 * of work with the tools it already has. A skill never adds a tool or a
 * permission: it names the tools it uses, and an agent without one of them
 * (in a conversation whose people can't read code, say) is told that part
 * isn't available there.
 *
 * Every skill is a folder in the open SKILL.md format (skill-format.ts).
 * Agents load them progressively: each skill's name and when to use it are
 * in the agent's instructions, and it reads the rest with `use_skill` when
 * a request matches.
 *
 * Every agent starts with g1t's foundational skills, below, which are
 * written out as SKILL.md too (`foundationalSkillMd`). Each says, ability by
 * ability, what works today and what is coming, and the agent is told the
 * same, so it never claims to do what it can't. A workspace's owners can
 * turn any skill off for one agent (`WorkspaceAgent.skills_off`, which
 * holds foundational ids and library skill ids); turning one off takes it
 * out of the agent's instructions and leaves its tools as they were.
 *
 * The workspace's own skills (written, imported, saved from a session, or
 * followed from a repository) are its skill library (skill-library.ts).
 *
 * Wire shapes are snake_case.
 */

export type SkillCategory = "documents" | "research" | "data" | "code" | "communication" | "files";

/** Where a skill comes from: g1t's own, written in the workspace, from the Marketplace, or learned from finished work. */
export type SkillSource = "foundational" | "workspace" | "marketplace" | "learned";

/** One thing a skill does, and whether it works today. */
export type SkillAbility = {
  /** Unique within its skill: `pdf`. */
  id: string;
  /** What it does, as the Skills tab lists it: "Make PDFs". */
  label: string;
  /** `ready` works today with the tools listed; `coming` is planned and the agent says so when asked. */
  status: "ready" | "coming";
  /** The agent's tools it uses; none for a coming ability. */
  tools: string[];
  /** A line on how, or what is missing: "From Markdown, as a file attached to a doc." */
  note: string;
};

export type AgentSkill = {
  /** `documents`, unique among skills. */
  id: string;
  name: string;
  /** One line, as the Skills tab shows it. */
  description: string;
  /** When to use it: the description in its SKILL.md, which agents read to choose it (skill-format.ts `foundationalSkillMd`). */
  when: string;
  category: SkillCategory;
  source: SkillSource;
  /** Which release of it: foundational skills change with g1t's releases. */
  version: string;
  /**
   * The playbook, in the second person, as it is put in the agent's
   * instructions while the skill is on. Coming abilities are added to it
   * as what the agent can't do yet.
   */
  instructions: string;
  abilities: SkillAbility[];
};

/** The foundational skills' release: they change together, with g1t. */
export const FOUNDATIONAL_SKILLS_VERSION = "2026.10";

/** The formats `make_file` writes. */
export const MAKE_FILE_FORMATS = ["pdf", "docx", "xlsx", "csv", "md"] as const;
export type MakeFileFormat = (typeof MAKE_FILE_FORMATS)[number];

const V = FOUNDATIONAL_SKILLS_VERSION;

/**
 * g1t's foundational skills, in the order the Skills tab shows them. The
 * tools named are the agent tools in services/agents (src/tools.ts); a
 * test there fails when one is named that doesn't exist.
 */
export const FOUNDATIONAL_SKILLS: AgentSkill[] = [
  {
    id: "documents",
    when: "Use when someone asks for a document: a PDF, a Word document, a spreadsheet or CSV, or a doc to read and edit together in Artifacts.",
    name: "Documents",
    description: "PDFs, Word documents, spreadsheets and docs in Artifacts.",
    category: "documents",
    source: "foundational",
    version: V,
    instructions: [
      "When someone asks for a document, give them the document, not a description of one.",
      "- A doc to read and edit together: write it with create_artifact (Markdown: headings, lists, tables, task lists, callouts, Mermaid charts), or change one with edit_artifact.",
      '- A file (a PDF, a Word document, a spreadsheet, a CSV): call make_file with the format. For pdf and docx, write the whole document as Markdown in content; for xlsx and csv, give the rows in sheets. Without an artifact, make_file makes a doc holding the content with the file attached; with one, it attaches the file to that doc. Link what it returns: "Here\'s the PDF: <link>".',
      "- Write the finished thing: a title, short sections, real numbers and names from what you read. Never leave placeholders like [Company name] unless they asked for a template.",
      "- PDFs and Word documents keep headings, paragraphs, bold, italic, code, lists, quotes and tables; images and charts don't carry into the file (they do in the doc). PDFs are in Latin script: say so if the text needs another.",
      "- Long or many-step documents belong in a session (start_session), which reports back with the link.",
    ].join("\n"),
    abilities: [
      { id: "doc", label: "Write and edit docs in Artifacts", status: "ready", tools: ["create_artifact", "edit_artifact", "read_artifact"], note: "Markdown with tables, task lists, callouts and Mermaid charts, edited live with people." },
      { id: "pdf", label: "Make PDFs", status: "ready", tools: ["make_file"], note: "From Markdown, attached to a doc. Latin script." },
      { id: "docx", label: "Word documents", status: "ready", tools: ["make_file"], note: "A .docx from Markdown, attached to a doc." },
      { id: "xlsx", label: "Spreadsheets", status: "ready", tools: ["make_file"], note: "An .xlsx with one or more sheets, or a .csv." },
      { id: "slides", label: "Slide decks", status: "coming", tools: [], note: "Comes with slides in Artifacts. Until then, an outline as a doc or a PDF." },
    ],
  },
  {
    id: "research",
    when: "Use when someone asks you to research, investigate or find out what is known about something, or wants a report with sources.",
    name: "Research",
    description: "Reports with sources, from what the workspace knows; the open web is coming.",
    category: "research",
    source: "foundational",
    version: V,
    instructions: [
      "When someone asks you to research something, find what is known before you write, and say where each fact comes from.",
      "- Look in the workspace first: search_artifacts and read_artifact for specs, runbooks and decisions; search_code and read_file for how the code works; search_messages and read_thread for what was said.",
      "- Report what you found, not what you expect: lead with the answer, then the evidence, and link every source (the artifact, file or thread). Say plainly what you couldn't find.",
      "- A report worth keeping goes in a doc (create_artifact) with a Sources section at the end. Long research is a session's job (start_session).",
    ].join("\n"),
    abilities: [
      { id: "cite", label: "Reports with sources", status: "ready", tools: ["search_artifacts", "read_artifact", "search_code", "read_file", "search_messages", "read_thread", "create_artifact"], note: "From the workspace's docs, code and chat, each source linked." },
      { id: "search", label: "Search the web", status: "coming", tools: [], note: "Comes with web access, set per team." },
      { id: "browse", label: "Browse and read pages", status: "coming", tools: [], note: "Comes with web access, set per team." },
    ],
  },
  {
    id: "data",
    when: "Use when someone asks about data: analysing a CSV, JSON, log or table, totals and comparisons, charts, or results as a spreadsheet.",
    name: "Data",
    description: "Analyze files and tables, chart the results and hand back a spreadsheet.",
    category: "data",
    source: "foundational",
    version: V,
    instructions: [
      "When someone asks about data, work from the data itself and show your working.",
      "- Read it where it lives: a CSV, JSON or log file in a repository (read_file), or a table in a doc (read_artifact). Data pasted into the conversation counts too.",
      "- You add up and compare by reasoning, not by running code, so keep tables small enough to check: count rows, say what you totalled, and round sensibly. Above a few hundred rows, say the result is an estimate, or ask for a summary.",
      "- Charts: put a Mermaid chart in a doc. Bar or line: ```mermaid with xychart, a title, x-axis [labels], y-axis \"Unit\", then bar [values] or line [values]. Shares of a whole: pie with \"Label\" : value lines. Label axes and units.",
      "- A table they'll work on goes back as a spreadsheet: make_file with format xlsx (or csv), header row first, numbers as numbers.",
    ].join("\n"),
    abilities: [
      { id: "analyze", label: "Analyze files and tables", status: "ready", tools: ["read_file", "read_artifact"], note: "CSV, JSON and logs in repositories, tables in docs. Worked by the model, not run as code." },
      { id: "charts", label: "Charts in docs", status: "ready", tools: ["create_artifact", "edit_artifact"], note: "Bar, line and pie charts, drawn from Mermaid in a doc." },
      { id: "export", label: "Spreadsheets of results", status: "ready", tools: ["make_file"], note: "An .xlsx or .csv attached to a doc." },
      { id: "dashboards", label: "Dashboards", status: "coming", tools: [], note: "Comes with dashboards in Artifacts." },
      { id: "sql", label: "Query databases and forks", status: "coming", tools: [], note: "Comes with workspace datasets and database connections." },
    ],
  },
  {
    id: "code",
    when: "Use when the work is code: reading or explaining it, reviewing a pull request, or getting a change made.",
    name: "Code",
    description: "Read and review code, and get changes made as pull requests through issues.",
    category: "code",
    source: "foundational",
    version: V,
    instructions: [
      "When the work is code, read before you answer, and get changes made the way the team ships them.",
      "- Find and read it: list_repositories, search_code, read_file; for history, recent_activity, get_issue and get_pull. Quote the lines you mean, with their path.",
      "- Review on the pull request itself with review_pull (approve, request changes or comment), and leave findings with comment. Your review is advisory.",
      "- To get a change made, draft an issue with draft_issue: what to change, why, where in the code, and how to tell it worked (the tests to add or run). Once it's filed, assigning it to @g1t makes the pull request on a runner, with checks and revisions.",
      "- You don't run code yourself: never say you ran, built or tested something. Say what you'd run and why.",
    ].join("\n"),
    abilities: [
      { id: "read", label: "Read and explain code", status: "ready", tools: ["list_repositories", "search_code", "read_file", "recent_activity"], note: "In repositories everyone in the conversation can read." },
      { id: "review", label: "Review pull requests", status: "ready", tools: ["get_pull", "review_pull", "comment"], note: "Advisory: people still give the approvals a merge needs." },
      { id: "pr", label: "Open pull requests", status: "ready", tools: ["draft_issue"], note: "Through an issue assigned to @g1t, which makes the pull request on a runner." },
      { id: "run", label: "Run code on its runner", status: "coming", tools: [], note: "Comes with agents on runners." },
      { id: "test", label: "Write and run tests itself", status: "coming", tools: [], note: "Comes with agents on runners; @g1t runs them on issues today." },
    ],
  },
  {
    id: "communication",
    when: "Use when someone asks you to draft an email or message, summarize a thread, or write a status update.",
    name: "Communication",
    description: "Draft emails and messages, and summarize threads.",
    category: "communication",
    source: "foundational",
    version: V,
    instructions: [
      "When someone asks you to write to people, or to catch them up, do it in their voice and keep it short.",
      "- Drafts: write the email or message ready to send, with a subject line for an email, in a fenced block or a doc they can copy. You can't send email: say they send it.",
      "- Summaries: read the thread first (read_thread, search_messages for related ones). Lead with what was decided and what is open, then who owns each next step, with links to the messages that matter.",
      "- Status updates: from recent_activity, issues and pull requests, say what shipped, what is in progress and what is blocked.",
    ].join("\n"),
    abilities: [
      { id: "draft", label: "Draft emails and messages", status: "ready", tools: [], note: "Written ready to send; sending email is coming." },
      { id: "summarize", label: "Summarize threads", status: "ready", tools: ["search_messages", "read_thread"], note: "Decisions, open questions and owners, with links." },
      { id: "schedule", label: "Find times and book meetings", status: "coming", tools: [], note: "Comes with calendar integrations." },
    ],
  },
  {
    id: "files",
    when: "Use when someone needs a file in another format, or a diagram such as a flowchart, sequence or timeline.",
    name: "Files and media",
    description: "Convert between formats, and draw diagrams.",
    category: "files",
    source: "foundational",
    version: V,
    instructions: [
      "When someone needs a file in another form, make it.",
      "- Text, Markdown and tables convert to PDF, Word, Excel, CSV or Markdown with make_file. To convert a file from a repository or a doc, read it (read_file, read_artifact) and pass its content on.",
      "- Diagrams (flows, sequences, timelines, org charts) are Mermaid fences in a doc (create_artifact).",
      "- You can't see images or read scans, and you can't draw or edit images yet. Say so, and offer what you can do from text.",
    ].join("\n"),
    abilities: [
      { id: "convert", label: "Convert between formats", status: "ready", tools: ["make_file", "read_file", "read_artifact"], note: "Markdown, text and tables to PDF, Word, Excel, CSV or Markdown." },
      { id: "diagrams", label: "Diagrams", status: "ready", tools: ["create_artifact"], note: "Flowcharts, sequences and timelines from Mermaid in a doc." },
      { id: "ocr", label: "Read scans and images", status: "coming", tools: [], note: "Comes with image input for agents." },
      { id: "images", label: "Create and edit images", status: "coming", tools: [], note: "Comes with image models." },
    ],
  },
];

/** The ids of the foundational skills. */
export const FOUNDATIONAL_SKILL_IDS: readonly string[] = FOUNDATIONAL_SKILLS.map((skill) => skill.id);

/** Every tool a skill's ready abilities use. */
export function skillTools(skill: AgentSkill): string[] {
  return [...new Set(skill.abilities.filter((ability) => ability.status === "ready").flatMap((ability) => ability.tools))];
}

/** Where skills come from, and which are here yet. */
export const SKILL_SOURCES: { source: SkillSource; label: string; status: "live" | "coming"; description: string }[] = [
  { source: "foundational", label: "Foundational, from g1t", status: "live", description: "Every agent starts with them, updated with every release." },
  { source: "workspace", label: "Written or imported in your workspace", status: "live", description: "Your own skills, such as how you cut a release or your brand voice: written in the editor, uploaded as SKILL.md or a zip, or read from a repository." },
  { source: "learned", label: "Saved from a session", status: "live", description: "Drafted by the agent from a finished session, published after a person reviews it." },
  { source: "marketplace", label: "From the Marketplace", status: "coming", description: "Skills that extensions bring, added in one step." },
];

/** The foundational skills an agent has on: every one unless `off` names it. */
export function skillsOn(off: readonly string[] | null | undefined): AgentSkill[] {
  const skip = new Set(off ?? []);
  return FOUNDATIONAL_SKILLS.filter((skill) => !skip.has(skill.id));
}
