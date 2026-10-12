# GitHub's workflow schema

`workflow-v1.0.json` is GitHub's schema for workflow files, copied unchanged from
[actions/languageservices](https://github.com/actions/languageservices), file
`workflow-parser/src/workflow-v1.0.json`, at commit
`4043eda158e16579cc5fb1b0b07a4bce2a76f0b5` (5 August 2026). It is MIT licensed;
`LICENSE` is that repository's licence, copied from the same commit.

g1t does not read it at run time. `src/syntax.rs` lists the keys each part of a
workflow may have, and its tests check those lists against this file, so they
cannot drift from GitHub's. To update it, copy the file again, write the commit
here, and run `cargo test -p g1t-actions`.
