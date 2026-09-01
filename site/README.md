# Landing page

The landing-page source lives entirely under `site/`:

- `public/` contains static files copied as-is.
- `content/` contains Markdown rendered during the build.
- `templates/` contains generated-page templates.
- `scripts/` contains build-time generators.

Build the deployable site with:

```bash
pnpm --dir site install --frozen-lockfile --ignore-scripts
pnpm --dir site build
```

Output is written to `site/build/`. That directory is disposable, ignored by Git, and deployed by `.github/workflows/pages.yml`.

Preview it locally with:

```bash
python3 -m http.server 4173 --directory site/build
```
