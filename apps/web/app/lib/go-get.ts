/**
 * `go get g1t.sh/<workspace>/<repo>[/<package>]`: Go asks the address with
 * `?go-get=1` and reads where the module's code is from a `go-import` meta
 * tag. Every repository answers, public or private, without looking it up:
 * the answer only says where git would find it, and git then asks for
 * credentials (GOPRIVATE and .netrc) as it would for a clone.
 */

const WORKSPACE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const REPO = /^[a-z0-9._-]{1,100}$/;

/** The page Go reads for `url`, or null when it is not a go-get request for a repository. */
export function goImport(url: URL): string | null {
  if (url.searchParams.get("go-get") !== "1") return null;
  const [workspace, rawRepo] = url.pathname.split("/").filter(Boolean);
  if (!workspace || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/, "");
  if (!WORKSPACE.test(workspace) || !REPO.test(repo) || repo.startsWith(".") || workspace === "-" || repo === "-") return null;
  const host = url.host;
  const prefix = `${host}/${workspace}/${repo}`;
  const home = `${url.protocol}//${prefix}`;
  return [
    "<!doctype html>",
    "<html><head>",
    `<meta name="go-import" content="${prefix} git ${home}.git">`,
    `<meta name="go-source" content="${prefix} ${home} ${home}/tree/HEAD{/dir} ${home}/blob/HEAD{/dir}/{file}#L{line}">`,
    "</head><body>",
    `go get ${prefix}`,
    "</body></html>",
    "",
  ].join("\n");
}
