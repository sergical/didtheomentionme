# Vendored anti-slop Oxlint plugins

Source: [sergical/anti-slop](https://github.com/sergical/anti-slop), commit
`9c334873bbc70d348aedc2688286884951731dd3`, path `skills/install-anti-slop/assets/anti-slop`. Copied with that
skill's `scripts/install.mjs`.

Installed plugins:

- `index.ts`: the generic `anti-slop` plugin.
- `effect/index.ts`: the `anti-slop-effect` plugin, because `effect` is a direct dependency.

`vendor/eslint-stylistic/` has its own `UPSTREAM.md` and `LICENSE`.

## Deviations

- No file here differs from the source.
- `.oxlintrc.json` does not enable `anti-slop/no-comments`. Every other rule of both plugins is on at `error`.
