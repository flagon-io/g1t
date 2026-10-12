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
  - if: steps.detect.outputs.framework == 'hugo'
    run: echo "A Hugo site, served from ${{ steps.detect.outputs.output-dir }}"
  - if: steps.detect.outputs.install != ''
    run: ${{ steps.detect.outputs.install }}
```

## Inputs

| Input | Default | |
| --- | --- | --- |
| `root-dir` | The checkout | Where the project is in the checkout. |
| `build-command` | None | A build command of your own, as `g1t/deploy` takes it. |
| `output-dir` | None | An output folder of your own, as `g1t/deploy` takes it. |
| `build-as` | `auto` | What it is built as: `auto`, `static`, `workers` or `docker`, as `g1t/deploy` takes it. |
| `dockerfile` | None | A Dockerfile's path of your own, as `g1t/deploy` takes it. |

## Outputs

| Output | |
| --- | --- |
| `kind` | `workers` (a `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`, or a framework's Cloudflare adapter), `static` (a site a build writes), `html` (the files as they are), `container` (a `Dockerfile`, a framework set up to need a server, or a server g1t writes a Dockerfile for) or `none` (nothing to serve). |
| `framework` | The framework it is built with, from the table below; for a container without one, `dockerfile`, or the server g1t writes a Dockerfile for (`node`, `django`, `flask`, `fastapi`, `python`, `go`, `rails`, `rack`, `laravel`, `php`). Empty when there is none. |
| `dockerfile` | A container's own Dockerfile, relative to the project. Empty when g1t writes one, and for anything that is not a container. |
| `port` | The port a container listens on: its Dockerfile's `EXPOSE`, else `8080`. |
| `install` | How dependencies are installed, from the lockfile: `npm ci`, `pnpm install --frozen-lockfile`, and so on, and `bundle install` for Jekyll. Empty when there is nothing to install. |
| `build` | What builds it: your command, the package's `build` script (`npm run build`), the framework's own command, or `wrangler deploy --dry-run` for Workers. Empty when nothing does. |
| `output-dir` | The folder served, relative to the project (`.` for the project itself): yours, a Workers project's assets directory, the folder the framework writes, or the first of `dist`, `build`, `out`, `public`, `_site`, `.output/public` that exists. Empty when a build has yet to write it, as for a Cloudflare adapter's Worker. |

When `kind` is `none`, the step's log says what to change or add, such as
a `Dockerfile`. [Docker deployments](https://docs.g1t.sh/guides/deployments/#docker-deployments)
has the order in which a project's kind is decided.

## Frameworks

| `framework` | Found by | Serves |
| --- | --- | --- |
| `vite`, `vite-react`, `vite-vue`, `vite-svelte`, `vite-solid`, `vite-preact` | `vite`, and the framework's Vite plugin | `dist`, or `build.outDir` |
| `astro` | `astro` | `dist`, or `outDir`; a Worker with `@astrojs/cloudflare` |
| `nextjs` | `next` | `out` with `output: 'export'`; a Worker with `@opennextjs/cloudflare` and a `wrangler.jsonc` |
| `sveltekit` | `@sveltejs/kit` | `build` with `adapter-static`; a Worker with `adapter-cloudflare` |
| `nuxt` | `nuxt` | `.output/public`, from `nuxi generate` |
| `react-router`, `remix` | `@react-router/dev`, `@remix-run/dev` | `build/client` with `ssr: false` |
| `gatsby` | `gatsby` | `public` |
| `docusaurus` | `@docusaurus/core` | `build` |
| `eleventy` | `@11ty/eleventy` | `_site` |
| `angular` | `@angular/core` and `angular.json` | `dist/<project>/browser` |
| `create-react-app` | `react-scripts` | `build` |
| `hugo` | `hugo.toml`, or Hugo's `config.toml` | `public` |
| `jekyll` | `_config.yml` and a `Gemfile` | `_site` |
| `mdbook` | `book.toml` | `book` |

[What deploys](https://docs.g1t.sh/guides/deployments/#frameworks) has
each one's build command. Your `build-command` and `output-dir` win over
what is detected.

It runs `g1t-runner detect`, found or downloaded as `g1t/deploy` finds it.
