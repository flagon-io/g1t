# g1t/detect

Says what a [g1t.page](https://docs.g1t.sh/guides/deployments/) build of
the checkout would find, without building or deploying anything: the
same rules [g1t/deploy](https://g1t.sh/g1t/deploy) builds with.

```yaml
steps:
  - uses: actions/checkout@v5
  - id: detect
    uses: g1t/detect@v1
  - if: steps.detect.outputs.kind == 'none'
    run: echo "::error::Nothing here would be served."
  - if: steps.detect.outputs.install != ''
    run: ${{ steps.detect.outputs.install }}
```

## Inputs

| Input | Default | |
| --- | --- | --- |
| `root-dir` | The checkout | Where the project is in the checkout. |
| `build-command` | None | A build command of your own, as `g1t/deploy` takes it. |
| `output-dir` | None | An output folder of your own, as `g1t/deploy` takes it. |

## Outputs

| Output | |
| --- | --- |
| `kind` | `workers` (a `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`), `static` (a site a build writes), `html` (the files as they are) or `none`. |
| `install` | How dependencies are installed, from the lockfile: `npm ci`, `pnpm install --frozen-lockfile`, and so on. Empty without a `package.json`. |
| `build` | What builds it: your command, `npm run build` for a package with a build script, or `wrangler deploy --dry-run` for Workers. Empty when nothing does. |
| `output-dir` | The folder served, relative to the project (`.` for the project itself): a Workers project's assets directory, or the first of `dist`, `build`, `out`, `public`, `_site`, `.output/public` that exists. Empty when a build has yet to write it. |

It runs `g1t-runner detect`, found or downloaded as `g1t/deploy` finds it.
