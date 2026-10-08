import { inlineParts } from "../lib/inline-markdown";

/** One line of an agent's or a memory's text, with its bold, italics and code shown as such. */
export function InlineMarkdown({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) =>
        part.kind === "strong" ? (
          <strong key={index} className="font-semibold text-fg">
            {part.text}
          </strong>
        ) : part.kind === "em" ? (
          <em key={index}>{part.text}</em>
        ) : part.kind === "code" ? (
          <code key={index} className="rounded bg-raised px-1 font-mono text-[0.9em]">
            {part.text}
          </code>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
