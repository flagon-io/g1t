import { Extension, markInputRule, type Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowUp,
  AtSign,
  Bold,
  Code,
  Italic,
  Keyboard,
  Link as LinkIcon,
  List,
  ListOrdered,
  Smile,
  SquareCode,
  Strikethrough,
  TextQuote,
  Type,
  Unlink,
} from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";

import { AgentPill, MemberAvatar } from "./marks";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
// `:shortcode` completion and the emoji picker (components/emoji).
import { useEmojiAutocomplete } from "../emoji/autocomplete";
import { EmojiPickerPopover } from "../emoji/picker";
import { type MentionQuery, type Mentionable, mentionQuery, safeHref, shownHandle } from "../../lib/chat";
import { docToMarkdown, markdownToDoc } from "../../lib/chat-compose";

/** How tall the box grows before it scrolls. */
const MAX_HEIGHT = 240;

export type ComposerProps = {
  /** Where the draft is kept while the tab is open; none when editing a message. */
  draftKey?: string;
  placeholder: string;
  people: Mentionable[];
  onSend: (body: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
  /** Editing a message: its Markdown to start from, and what leaving does. */
  initial?: string;
  onCancel?: () => void;
};

// ---------------------------------------------------------------------------
// The editor's rules: Markdown typed as you go, and the shortcuts.

/** `*bold*` (one star, as chat writes it) and `**bold**`; `_italic_`; `~strike~` and `~~strike~~`. */
const ChatMarks = Extension.create({
  name: "chatMarks",
  // Before the marks' own rules, so `*x*` is bold here, not italic.
  priority: 1000,
  addInputRules() {
    const { bold, italic, strike } = this.editor.schema.marks;
    return [
      markInputRule({ find: /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/, type: bold! }),
      markInputRule({ find: /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/, type: bold! }),
      markInputRule({ find: /(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/, type: italic! }),
      markInputRule({ find: /(?:^|\s)(~(?!\s+~)((?:[^~]+))~(?!\s+~))$/, type: strike! }),
    ];
  },
});

/** The shortcuts beyond the editor's own (Mod+B, Mod+I, Mod+E, Mod+Shift+7 and 8). */
function chatKeys(openLink: RefObject<() => void>) {
  return Extension.create({
    name: "chatKeys",
    addKeyboardShortcuts() {
      return {
        "Mod-Shift-x": () => this.editor.commands.toggleStrike(),
        "Mod-Shift-c": () => this.editor.commands.toggleCode(),
        "Mod-Alt-Shift-c": () => this.editor.commands.toggleCodeBlock(),
        "Mod-Shift-9": () => this.editor.commands.toggleBlockquote(),
        "Mod-k": () => {
          openLink.current();
          return true;
        },
      };
    },
  });
}

/** Whether the caret is inside a node of this type. */
function inside(editor: Editor, type: string): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === type) return true;
  return false;
}

/**
 * The block the caret is in, as a text box: what the `@` and `:` menus
 * read and write, as they would a textarea. Each character of the block's
 * text is one position in the document.
 */
type TextBox = { value: string; selectionStart: number; selectionEnd: number; focus: () => void; setSelectionRange: (from: number, to: number) => void };

function textBox(editor: Editor): TextBox {
  return {
    get value() {
      const parent = editor.state.selection.$from.parent;
      return parent.textBetween(0, parent.content.size, undefined, "￼");
    },
    get selectionStart() {
      return editor.state.selection.$from.parentOffset;
    },
    get selectionEnd() {
      const { $from, $to } = editor.state.selection;
      return $from.sameParent($to) ? $to.parentOffset : $from.parentOffset;
    },
    focus: () => editor.commands.focus(),
    setSelectionRange: (from, to) => {
      const start = editor.state.selection.$from.start();
      editor.commands.setTextSelection({ from: start + from, to: start + to });
    },
  };
}

/** The caret's block made to read `next`: only what changed is replaced, so its formatting stays. */
function replaceBlockText(editor: Editor, next: string) {
  const box = textBox(editor);
  const now = box.value;
  let head = 0;
  while (head < now.length && head < next.length && now[head] === next[head]) head++;
  let tail = 0;
  while (tail < now.length - head && tail < next.length - head && now[now.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const start = editor.state.selection.$from.start();
  const inserted = next.slice(head, next.length - tail);
  const tr = editor.state.tr;
  if (inserted) tr.insertText(inserted, start + head, start + now.length - tail);
  else tr.delete(start + head, start + now.length - tail);
  editor.view.dispatch(tr);
}

/** What a link field holds: an address as typed, made into one a link may go to. */
function linkAddress(typed: string): string | null {
  const trimmed = typed.trim();
  if (!trimmed) return null;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(trimmed)) return safeHref(`mailto:${trimmed}`);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith("/")) return safeHref(`https://${trimmed}`);
  return safeHref(trimmed);
}

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

/** Every formatting shortcut, for the hints and the list. */
const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: "Bold", keys: [MOD, "B"] },
  { label: "Italic", keys: [MOD, "I"] },
  { label: "Strikethrough", keys: [MOD, "Shift", "X"] },
  { label: "Link", keys: [MOD, "K"] },
  { label: "Code", keys: [MOD, "Shift", "C"] },
  { label: "Code block", keys: [MOD, "Alt", "Shift", "C"] },
  { label: "Bulleted list", keys: [MOD, "Shift", "8"] },
  { label: "Numbered list", keys: [MOD, "Shift", "7"] },
  { label: "Quote", keys: [MOD, "Shift", "9"] },
];

const keysOf = (label: string) => SHORTCUTS.find((s) => s.label === label)!.keys.join("+");

/** Whether the formatting bar is shown: as last chosen on this device, else on wider screens. */
function useToolbarShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("chat-formatting");
      if (saved) return setShown(saved === "shown");
    } catch {
      // No storage: the screen decides.
    }
    setShown(window.matchMedia("(min-width: 768px)").matches);
  }, []);
  return [
    shown,
    (next: boolean) => {
      setShown(next);
      try {
        localStorage.setItem("chat-formatting", next ? "shown" : "hidden");
      } catch {
        // Kept only while the page is open.
      }
    },
  ];
}

// ---------------------------------------------------------------------------
// The composer.

/**
 * Where a message is written, formatted as it is typed. Enter sends and
 * Shift+Enter starts a new line; in a list Enter adds an item (twice to
 * leave it), in a code block a line (three times to leave it), and
 * Ctrl+Enter sends from anywhere. Markdown typed inline becomes its
 * formatting; the bar above the text does the same with a click. `@`
 * offers the workspace's people and agents and `:` its emoji (Up and Down
 * to move, Tab or Enter to take one, Escape to dismiss). What is sent is
 * Markdown. A draft is kept per conversation while the tab is open.
 */
export default function ChatEditor({ draftKey, placeholder, people, onSend, onTyping, disabled, autoFocus, compact, initial, onCancel }: ComposerProps) {
  const editing = initial != null;
  const [match, setMatch] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [link, setLink] = useState<{ text: string; href: string; existing: boolean } | null>(null);
  const [toolbar, setToolbar] = useToolbarShown();
  const list = useId();

  // What the editor's handlers read: the latest of each, not the first render's.
  const keys = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const openLink = useRef<() => void>(() => {});
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const typing = useRef(onTyping);
  typing.current = onTyping;
  const loading = useRef(false);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        underline: false,
        dropcursor: false,
        gapcursor: false,
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: true,
          protocols: ["mailto"],
          isAllowedUri: (url) => safeHref(url) != null,
          HTMLAttributes: { rel: "noopener noreferrer nofollow ugc", target: null },
        },
        codeBlock: { HTMLAttributes: { spellcheck: "false" } },
      }),
      ChatMarks,
      chatKeys(openLink),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
    ],
    [],
  );

  const draftOf = (key: string | undefined): string => {
    if (editing) return initial ?? "";
    if (!key) return "";
    try {
      return sessionStorage.getItem(`chat-draft:${key}`) ?? "";
    } catch {
      return "";
    }
  };

  const editor = useEditor({
    extensions,
    immediatelyRender: false,
    autofocus: autoFocus ? "end" : false,
    editable: !disabled,
    content: markdownToDoc(draftOf(draftKey)),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": placeholder,
        "data-1p-ignore": "",
        "data-lpignore": "true",
        class: "chat-editor outline-none",
      },
      handleKeyDown: (_view, event) => keys.current(event),
      // Text pasted without formatting is read as Markdown, the way it would be sent.
      clipboardTextParser: (text, $context, plain, view) => {
        if (plain || $context.parent.type.spec.code) return null as unknown as Slice;
        const doc = view.state.schema.nodeFromJSON(markdownToDoc(text));
        return Slice.maxOpen(doc.content);
      },
    },
    onUpdate: ({ editor: now }) => {
      if (loading.current) return;
      look(now);
      if (!editing && draftKey) {
        const markdown = docToMarkdown(now.getJSON());
        try {
          if (markdown) sessionStorage.setItem(`chat-draft:${draftKey}`, markdown);
          else sessionStorage.removeItem(`chat-draft:${draftKey}`);
        } catch {
          // No storage: the draft lives only while the page does.
        }
      }
      typing.current?.();
    },
    onSelectionUpdate: ({ editor: now }) => look(now),
    onBlur: () =>
      setTimeout(() => {
        setMatch(null);
        emoji.dismiss();
      }, 150),
  });

  // The emoji menu works on the caret's block as on a text box.
  const box = useRef<TextBox | null>(null);
  box.current = editor ? textBox(editor) : null;
  const emoji = useEmojiAutocomplete({
    box: box as unknown as RefObject<HTMLTextAreaElement | null>,
    setText: (next) => editor && replaceBlockText(editor, next),
  });

  // Another conversation's draft when the conversation changes.
  const shownKey = useRef(draftKey);
  useEffect(() => {
    if (!editor || shownKey.current === draftKey) return;
    shownKey.current = draftKey;
    loading.current = true;
    editor.commands.setContent(markdownToDoc(draftOf(draftKey)), { emitUpdate: false });
    loading.current = false;
    setMatch(null);
    setLink(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, draftKey]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const state = useEditorState({
    editor,
    selector: ({ editor: now }) =>
      now
        ? {
            bold: now.isActive("bold"),
            italic: now.isActive("italic"),
            strike: now.isActive("strike"),
            code: now.isActive("code"),
            link: now.isActive("link"),
            codeBlock: now.isActive("codeBlock"),
            bulletList: now.isActive("bulletList"),
            orderedList: now.isActive("orderedList"),
            blockquote: now.isActive("blockquote"),
            empty: now.isEmpty || docToMarkdown(now.getJSON()).trim() === "",
          }
        : null,
  });

  function look(now: Editor) {
    emoji.look();
    const { selection } = now.state;
    if (!selection.empty || inside(now, "codeBlock") || now.isActive("code")) {
      setMatch(null);
      return;
    }
    const text = textBox(now);
    setMatch(mentionQuery(text.value, text.selectionStart, people));
    setActive(0);
  }

  const complete = (person: Mentionable) => {
    if (!editor || !match) return;
    const start = editor.state.selection.$from.start();
    const caret = editor.state.selection.$from.parentOffset;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: start + match.start, to: start + caret }, { type: "text", text: `@${person.name} ` })
      .run();
    setMatch(null);
  };

  const send = () => {
    if (!editor || disabled) return;
    const body = docToMarkdown(editor.getJSON()).trim();
    if (!body) return;
    onSend(body);
    if (editing) return;
    editor.commands.clearContent(true);
    setMatch(null);
    setLink(null);
  };

  openLink.current = () => {
    if (!editor) return;
    // On a link already: its whole text, to change or remove.
    if (editor.isActive("link")) editor.chain().extendMarkRange("link").run();
    const { from, to } = editor.state.selection;
    setLink({ text: editor.state.doc.textBetween(from, to, " "), href: editor.getAttributes("link").href ?? "", existing: editor.isActive("link") });
  };

  keys.current = (event) => {
    if (!editor) return false;
    if (emoji.onKeyDown(event as unknown as ReactKeyboardEvent<HTMLElement>)) return true;
    if (match) {
      const count = match.options.length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return true;
      }
      if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
        event.preventDefault();
        complete(match.options[active] ?? match.options[0]!);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMatch(null);
        return true;
      }
    }
    if (event.key === "Escape" && editing) {
      event.preventDefault();
      onCancel?.();
      return true;
    }
    if (event.key !== "Enter" || event.isComposing) return false;
    // Ctrl+Enter (⌘+Enter) sends from anywhere, a list or code too.
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      send();
      return true;
    }
    const inCode = inside(editor, "codeBlock");
    const inList = inside(editor, "listItem");
    if (inCode) {
      // A new line in the block; three Enters in a row leave it.
      if (event.shiftKey) {
        editor
          .chain()
          .command(({ tr }) => {
            tr.insertText("\n");
            return true;
          })
          .run();
        return true;
      }
      return false;
    }
    if (inList) {
      // A new item, or out of the list from an empty one.
      return event.shiftKey ? editor.commands.splitListItem("listItem") || false : false;
    }
    if (event.shiftKey) {
      // A new line: the next paragraph, so lists and quotes can start on it.
      return editor.commands.splitBlock();
    }
    // ``` and a language, then Enter: a code block.
    const fence = /^```([\w+#.-]*)$/.exec(textBox(editor).value);
    if (fence) {
      const start = editor.state.selection.$from.start();
      editor
        .chain()
        .deleteRange({ from: start, to: start + fence[0].length })
        .setCodeBlock(fence[1] ? { language: fence[1] } : undefined)
        .run();
      return true;
    }
    event.preventDefault();
    send();
    return true;
  };

  // The `@` list is the text box's: say so to a screen reader.
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    if (match) {
      dom.setAttribute("aria-expanded", "true");
      dom.setAttribute("aria-controls", list);
      dom.setAttribute("aria-activedescendant", `${list}-${active}`);
    } else {
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    }
  }, [editor, match, active, list]);

  const applyLink = (text: string, href: string) => {
    if (!editor) return false;
    const address = linkAddress(href);
    if (!address) return false;
    const { from, to } = editor.state.selection;
    if (from === to) {
      const words = text.trim() || address;
      editor
        .chain()
        .focus()
        .insertContent({ type: "text", text: words, marks: [{ type: "link", attrs: { href: address } }] })
        .unsetMark("link")
        .insertContent({ type: "text", text: " " })
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: address }).run();
    }
    return true;
  };

  const tool = (label: string, icon: ReactNode, on: boolean | undefined, run: () => void) => (
    <Hint label={`${label} (${keysOf(label)})`}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={!!on}
        disabled={disabled || !editor}
        onMouseDown={(event) => event.preventDefault()}
        onClick={run}
        className={`flex size-8 shrink-0 items-center justify-center rounded-md transition-colors sm:size-7 ${
          on ? "bg-accent/15 text-accent" : "text-faint hover:bg-raised hover:text-fg"
        }`}
      >
        {icon}
      </button>
    </Hint>
  );

  const chain = () => editor!.chain().focus();

  return (
    <div className="relative">
      {emoji.menu}
      {match && (
        <ul
          id={list}
          role="listbox"
          aria-label="Mention someone"
          className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-sm overflow-hidden rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40"
        >
          {match.options.map((person, index) => (
            <li
              key={`${person.kind}:${person.name}`}
              id={`${list}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => complete(person)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 ${index === active ? "bg-line" : ""}`}
            >
              <MemberAvatar member={person} size={22} />
              <span className="min-w-0 grow truncate text-sm">
                <span className="font-medium text-fg">{person.display_name}</span>
                <span className="ml-1.5 text-faint">@{shownHandle(person)}</span>
              </span>
              {person.kind === "agent" && <AgentPill />}
            </li>
          ))}
        </ul>
      )}
      {link && (
        <LinkForm
          initial={link}
          onApply={(text, href) => {
            if (!applyLink(text, href)) return false;
            setLink(null);
            return true;
          }}
          onRemove={
            link.existing
              ? () => {
                  editor?.chain().focus().extendMarkRange("link").unsetLink().run();
                  setLink(null);
                }
              : undefined
          }
          onClose={() => {
            setLink(null);
            editor?.commands.focus();
          }}
        />
      )}
      <div
        className={`rounded-xl border border-line-strong bg-surface transition-colors focus-within:border-accent/35 focus-within:ring-4 focus-within:ring-accent/[0.06] ${disabled ? "opacity-60" : ""}`}
      >
        {toolbar && (
          <div
            role="toolbar"
            aria-label="Formatting"
            className="flex items-center gap-0.5 overflow-x-auto border-b border-line px-1.5 py-1 [scrollbar-width:none]"
          >
            {tool("Bold", <Bold size={15} strokeWidth={2.4} />, state?.bold, () => chain().toggleBold().run())}
            {tool("Italic", <Italic size={15} />, state?.italic, () => chain().toggleItalic().run())}
            {tool("Strikethrough", <Strikethrough size={15} />, state?.strike, () => chain().toggleStrike().run())}
            <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line" />
            {tool("Link", <LinkIcon size={15} />, state?.link, () => openLink.current())}
            <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line" />
            {tool("Bulleted list", <List size={15} />, state?.bulletList, () => chain().toggleBulletList().run())}
            {tool("Numbered list", <ListOrdered size={15} />, state?.orderedList, () => chain().toggleOrderedList().run())}
            {tool("Quote", <TextQuote size={15} />, state?.blockquote, () => chain().toggleBlockquote().run())}
            <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line" />
            {tool("Code", <Code size={15} />, state?.code, () => chain().toggleCode().run())}
            {tool("Code block", <SquareCode size={15} />, state?.codeBlock, () => chain().toggleCodeBlock().run())}
            <ShortcutList />
          </div>
        )}
        <div
          className={`overflow-y-auto px-3.5 text-[0.9375rem] leading-6 text-fg [scrollbar-width:thin] ${compact ? "pt-2.5 pb-1" : "pt-3 pb-1.5"}`}
          style={{ maxHeight: MAX_HEIGHT }}
          onClick={(event) => {
            // The whole box takes focus, not only its first line.
            if (event.target === event.currentTarget) editor?.commands.focus("end");
          }}
        >
          {editor ? (
            <EditorContent editor={editor} />
          ) : (
            <p aria-hidden="true" className="text-faint">
              {placeholder}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 px-2 pb-2">
          <Hint label={toolbar ? "Hide formatting" : "Show formatting"}>
            <button
              type="button"
              aria-label={toolbar ? "Hide formatting" : "Show formatting"}
              aria-pressed={toolbar}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setToolbar(!toolbar)}
              className={`flex size-7 items-center justify-center rounded-md transition-colors ${toolbar ? "bg-raised text-fg" : "text-faint hover:bg-raised hover:text-fg"}`}
            >
              <Type size={15} />
            </button>
          </Hint>
          <Hint label="Mention someone">
            <Button
              type="button"
              aria-label="Mention someone"
              disabled={disabled || !editor}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!editor) return;
                const text = textBox(editor);
                const before = text.value.slice(0, text.selectionStart);
                editor
                  .chain()
                  .focus()
                  .insertContent({ type: "text", text: before && !/\s$/.test(before) ? " @" : "@" })
                  .run();
                look(editor);
              }}
              variant="ghost"
              size="icon-xs"
              className="text-faint"
            >
              <AtSign size={15} />
            </Button>
          </Hint>
          <EmojiPickerPopover side="top" align="start" onPick={(picked) => editor?.chain().focus().insertContent({ type: "text", text: picked }).run()}>
            <Hint label="Add an emoji">
              <Button
                type="button"
                aria-label="Add an emoji"
                disabled={disabled || !editor}
                variant="ghost"
                size="icon-xs"
                className="text-faint"
              >
                <Smile size={15} />
              </Button>
            </Hint>
          </EmojiPickerPopover>
          {editing ? (
            <>
              <span className="ml-1 hidden text-[0.6875rem] text-faint sm:inline">
                <kbd className="font-sans">Esc</kbd> to cancel · <kbd className="font-sans">Enter</kbd> to save
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <Button
                  type="button"
                  onClick={onCancel}
                  variant="outline"
                  size="sm"
                  className="rounded-lg px-3 text-fg-soft hover:bg-raised"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={disabled || !editor || state?.empty}
                  onClick={send}
                  variant="accent"
                  size="sm"
                  className="rounded-lg px-3 disabled:bg-line disabled:text-faint disabled:opacity-100"
                >
                  Save
                </Button>
              </span>
            </>
          ) : (
            <>
              <span className="ml-1 hidden text-[0.6875rem] text-faint sm:inline">
                <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift+Enter</kbd> for a new line
              </span>
              <Button
                type="button"
                aria-label="Send"
                disabled={disabled || !editor || state?.empty !== false}
                onMouseDown={(event) => event.preventDefault()}
                onClick={send}
                variant="accent"
                size="icon-sm"
                className="ml-auto rounded-lg transition-[background-color,opacity] disabled:bg-line disabled:text-faint disabled:opacity-100"
              >
                <ArrowUp size={16} strokeWidth={2.4} />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The bar's last button: every shortcut, and what Markdown typed becomes. */
function ShortcutList() {
  return (
    <Popover>
      <Hint label="Formatting shortcuts">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Formatting shortcuts" onMouseDown={(event) => event.preventDefault()} className="ml-auto text-faint sm:size-7">
            <Keyboard size={15} />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent side="top" align="end" className="w-80 p-3" onOpenAutoFocus={(event) => event.preventDefault()}>
        <p className="mb-2 text-xs font-semibold text-fg">Formatting shortcuts</p>
        <dl className="space-y-1 text-[0.8125rem]">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.label} className="flex items-center justify-between gap-3">
              <dt className="text-fg-soft">{shortcut.label}</dt>
              <dd className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <kbd key={key} className="rounded border border-line-strong bg-surface px-1.5 font-sans text-[0.6875rem] text-muted">
                    {key}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 mb-1.5 text-xs font-semibold text-fg">Or type Markdown</p>
        <p className="font-mono text-[0.75rem] leading-relaxed text-muted">
          *bold* _italic_ ~strike~ `code`
          <br />
          - list · 1. list · &gt; quote
          <br />
          ``` code block
        </p>
        <p className="mt-3 text-[0.75rem] text-faint">
          <kbd className="font-sans">{MOD}+Enter</kbd> sends from a list or code block.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** Adding or changing a link: its text when nothing is selected, and where it goes. */
function LinkForm({
  initial,
  onApply,
  onRemove,
  onClose,
}: {
  initial: { text: string; href: string; existing: boolean };
  onApply: (text: string, href: string) => boolean;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial.text);
  const [href, setHref] = useState(initial.href);
  const [wrong, setWrong] = useState(false);
  const askText = !initial.text;
  const id = useId();
  const keys = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <form
      aria-label={initial.existing ? "Edit link" : "Add a link"}
      onSubmit={(event) => {
        event.preventDefault();
        setWrong(!onApply(text, href));
      }}
      onKeyDown={keys}
      className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-sm space-y-2 rounded-lg border border-line-strong bg-raised p-3 shadow-xl shadow-black/40"
    >
      {askText && (
        <div className="space-y-1">
          <label htmlFor={`${id}-text`} className="text-xs font-medium text-muted">
            Text
          </label>
          <input
            id={`${id}-text`}
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="What the link says"
            autoComplete="off"
            className="h-8 w-full rounded-md border border-line bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/40"
          />
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor={`${id}-href`} className="text-xs font-medium text-muted">
          Link
        </label>
        <input
          id={`${id}-href`}
          autoFocus={!askText}
          value={href}
          onChange={(event) => {
            setHref(event.target.value);
            setWrong(false);
          }}
          placeholder="https://"
          inputMode="url"
          autoComplete="off"
          aria-invalid={wrong}
          aria-describedby={wrong ? `${id}-wrong` : undefined}
          className="h-8 w-full rounded-md border border-line bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/40 aria-invalid:border-danger/60"
        />
        {wrong && (
          <p id={`${id}-wrong`} className="text-xs text-danger">
            A link goes to a web address (https://…), an email address or a page on g1t.
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        {onRemove && (
          <Button type="button" onClick={onRemove} variant="ghost" size="sm" className="flex px-2 hover:bg-line font-normal">
            <Unlink size={14} />
            Remove link
          </Button>
        )}
        <Button type="button" onClick={onClose} variant="ghost" size="sm" className="ml-auto px-3 hover:bg-line font-normal">
          Cancel
        </Button>
        <Button type="submit" disabled={!href.trim()} variant="accent" size="sm" className="px-3 disabled:bg-line disabled:text-faint disabled:opacity-100">
          {initial.existing ? "Save" : "Add link"}
        </Button>
      </div>
    </form>
  );
}
