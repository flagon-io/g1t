import { FileDiff as FileIcon, FileMinus, FilePlus } from "lucide-react";

import type { Comparison, DiffLine, FileDiff } from "@g1t/contracts";

import { EmptyState } from "./ui";

const ROW_STYLES: Record<DiffLine["kind"], string> = {
  context: "",
  add: "bg-accent/10",
  delete: "bg-danger/10",
};

const MARKERS: Record<DiffLine["kind"], string> = {
  context: " ",
  add: "+",
  delete: "-",
};

/** `+12 −3` with a five-block bar, like the summary on a pull request. */
function Stat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  const total = additions + deletions;
  const green = total === 0 ? 0 : Math.round((additions / total) * 5);
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
      <span className="text-accent">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
      <span className="flex gap-px" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className={`size-2 rounded-xs ${
              total === 0 ? "bg-line" : i < green ? "bg-accent" : "bg-danger"
            }`}
          />
        ))}
      </span>
    </span>
  );
}

function File({ file }: { file: FileDiff }) {
  const Icon =
    file.status === "added"
      ? FilePlus
      : file.status === "deleted"
        ? FileMinus
        : FileIcon;
  return (
    <section
      id={`file-${file.path}`}
      className="scroll-mt-20 overflow-hidden rounded-xl border border-line"
    >
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <Icon
          size={15}
          className={
            file.status === "added"
              ? "text-accent"
              : file.status === "deleted"
                ? "text-danger"
                : "text-faint"
          }
        />
        <span className="min-w-0 grow truncate font-mono text-[0.8125rem]">
          {file.path}
        </span>
        <Stat additions={file.additions} deletions={file.deletions} />
      </header>
      {file.binary ? (
        <p className="px-4 py-6 text-sm text-muted">
          Binary or large file; its contents are not shown.
        </p>
      ) : file.hunks.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">No line changes.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {file.hunks.map((hunk, index) => (
                <HunkRows key={index} lines={hunk.lines} first={index === 0} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HunkRows({ lines, first }: { lines: DiffLine[]; first: boolean }) {
  return (
    <>
      {!first && (
        <tr aria-hidden="true">
          <td
            colSpan={4}
            className="border-y border-line bg-surface py-1 text-center text-faint"
          >
            ⋯
          </td>
        </tr>
      )}
      {lines.map((line, index) => (
        <tr key={index} className={ROW_STYLES[line.kind]}>
          <td className="w-10 px-2 text-right text-faint select-none">
            {line.old}
          </td>
          <td className="w-10 px-2 text-right text-faint select-none">
            {line.new}
          </td>
          <td
            className={`w-5 text-center select-none ${
              line.kind === "add"
                ? "text-accent"
                : line.kind === "delete"
                  ? "text-danger"
                  : "text-faint"
            }`}
          >
            {MARKERS[line.kind]}
          </td>
          <td className="pr-4 whitespace-pre">{line.text}</td>
        </tr>
      ))}
    </>
  );
}

export function DiffView({ comparison }: { comparison: Comparison }) {
  const { files, truncated } = comparison;
  if (files.length === 0) {
    return (
      <EmptyState title="No changes yet">
        Nothing has been pushed to this attempt's fork, or it matches the
        repository it came from.
      </EmptyState>
    );
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm text-muted">
        <span>
          <span className="font-medium text-fg">{files.length}</span>{" "}
          {files.length === 1 ? "file" : "files"} changed
        </span>
        <Stat additions={additions} deletions={deletions} />
      </div>
      {files.length > 1 && (
        <ul className="rounded-xl border border-line bg-surface p-2 text-sm">
          {files.map((file) => (
            <li key={file.path}>
              <a
                href={`#file-${file.path}`}
                className="flex items-center gap-3 rounded-md px-2 py-1 hover:bg-raised"
              >
                <span className="min-w-0 grow truncate font-mono text-[0.8125rem]">
                  {file.path}
                </span>
                <Stat additions={file.additions} deletions={file.deletions} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {files.map((file) => (
        <File key={file.path} file={file} />
      ))}
      {truncated && (
        <p className="text-center text-sm text-muted">
          This change is too large to show in full.
        </p>
      )}
    </div>
  );
}
