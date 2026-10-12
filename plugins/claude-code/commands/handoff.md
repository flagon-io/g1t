---
description: Hand a g1t issue off to someone else, with a note on where it stands
argument-hint: "<issue number> [@login]"
allowed-tools: Bash(g1t:*) Bash(git:*)
---

Hand off g1t issue $1. Arguments: $ARGUMENTS

1. Make sure nothing is lost: commit and push work in progress on the
   issue's branch, and say if anything could not be pushed.
2. Write a hand-off note for whoever picks it up: what is done, what is
   left, what you tried that did not work, and anything to watch out for.
   Keep it to a few lines.
3. Run `g1t work handoff $1 --note "THE NOTE"`, with `--to LOGIN` if a
   login (such as `@ana`, given without the `@`) is in the arguments.
4. Show me the note you left.
