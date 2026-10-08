import { GitBranch, Pencil } from "lucide-react";
import { useState } from "react";
import { useFetcher } from "react-router";

import { ErrorText } from "./ui";
import { Hint } from "./ui/hint";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/combobox";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * The branch a pull request merges into, and for someone who may change
 * it, a menu of the repository's branches. The names are fetched when the
 * menu opens; choosing one posts `action=base` with `base`.
 */
export function BaseBranch({
  base,
  head,
  canChange,
  branchesUrl,
}: {
  base: string;
  /** Its own branch, which it cannot merge into. */
  head: string | null;
  canChange: boolean;
  /** Where the branch names are, as JSON. */
  branchesUrl: string;
}) {
  const names = useFetcher<{ branches: string[] }>();
  const save = useFetcher<{ error?: string } | null>();
  const [open, setOpen] = useState(false);
  const shown = save.state !== "idle" ? String(save.formData?.get("base") ?? base) : base;
  const choose = (branch: string) => {
    setOpen(false);
    if (branch === base) return;
    const form = new FormData();
    form.set("action", "base");
    form.set("base", branch);
    save.submit(form, { method: "post" });
  };
  const name = <span className="font-mono text-fg">{shown}</span>;
  if (!canChange) return name;
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next && names.state === "idle" && !names.data) names.load(branchesUrl);
        }}
      >
        <Hint label="Change the branch it merges into">
          <PopoverTrigger asChild>
            <button
              type="button"
              className="group inline-flex items-center gap-1 rounded-md border border-transparent px-1 font-mono text-fg transition-colors hover:border-line hover:bg-raised"
            >
              {shown}
              <Pencil size={12} className="text-faint group-hover:text-fg" />
              <span className="sr-only">Change the branch it merges into</span>
            </button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent align="start" className="w-72 p-0">
          <Command>
            <CommandInput placeholder="Find a branch to merge into" />
            <CommandList>
              {names.data ? (
                <CommandEmpty>No branch by that name.</CommandEmpty>
              ) : (
                <p className="px-3 py-4 text-sm text-faint">Reading branches…</p>
              )}
              <CommandGroup heading="Merge into">
                {(names.data?.branches ?? [])
                  .filter((branch) => branch !== head)
                  .map((branch) => (
                    <CommandItem key={branch} value={branch} onSelect={() => choose(branch)}>
                      <GitBranch />
                      <span className="truncate font-mono text-[0.8125rem]">{branch}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <p className="border-t border-line px-3 py-2 text-xs text-faint">
            Its checks, mergeability and whether it is up to date are worked out against the new base.
          </p>
        </PopoverContent>
      </Popover>
      {save.data?.error && (
        <span className="basis-full">
          <ErrorText>{save.data.error}</ErrorText>
        </span>
      )}
    </>
  );
}
