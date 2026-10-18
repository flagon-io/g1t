# g1t/workflows

g1t's own reusable workflows, published from this folder of g1t's
repository to `g1t/workflows` on g1t.sh by `.g1t/workflows/actions-release.yml`.

| Workflow                    | What it does                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.g1t/workflows/deploy.yml` | Builds the commit onto g1t.page with `g1t/deploy`. The deploy workflow g1t manages for a project calls it. |

```yaml
jobs:
  g1t:
    uses: g1t/workflows/.g1t/workflows/deploy.yml@v1
    with:
      project: web
    secrets: inherit
```
