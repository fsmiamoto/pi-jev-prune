# Contributing

[Back to README](README.md)

## Development

Use Node 24. CI runs typechecking and unit tests on every push and pull request.

```bash
npm ci
npm test            # typecheck + unit tests
npm run test:live   # real Jev request; requires TYPESAFE_API_KEY
```

## Experiments

- [replay.ts](experiments/replay.ts): replay recorded sessions with `JEV_PRUNE_SESSIONS='--Users-me-Code-repo--,…'` and optional `JEV_PRUNE_EXCLUDE='pattern'`.
- [live.ts](experiments/live.ts): headless A/B runs on a repository clone.
- [analyze.ts](experiments/analyze.ts): analyze experiment outputs.
- [REPORT.md](experiments/REPORT.md): methodology, results, and limitations.

Review session selection before running replay: Jev receives task text and tool-output excerpts.
Untried directions include ingest-time chunk filtering, applying only when the cache is cold, and nudging delegation to a subagent.

## Maintainer releases

[Publish workflow](.github/workflows/publish.yml) uses Node 24 and explicitly installs npm 11 (trusted publishing requires npm ≥ 11.5.1).

### Trusted publishing setup

In npm package settings → **Trusted Publisher**, configure GitHub Actions:

- Organization/user: `fsmiamoto`
- Repository: `pi-jev-prune`
- Workflow filename: `publish.yml`
- Environment: blank
- Allow direct `npm publish` if asked for allowed actions.

No `NPM_TOKEN` is needed. [Trusted publishing](https://docs.npmjs.com/trusted-publishers/) uses OIDC on GitHub-hosted runners (`ubuntu-latest`); self-hosted runners are unsupported. Keep `package.json`'s `repository.url` matching this repository. Publishing a public package from a public repository gets automatic provenance.

If setting up a new package, an initial authenticated `npm publish --access public` may be needed before configuring its trusted publisher. Run `npm ci` and `npm test` first.
After verifying OIDC publishing, npm recommends **Require two-factor authentication and disallow tokens** in Publishing access.

### Each release

1. Bump `package.json` and `package-lock.json` to a new, unpublished version.
2. Commit reviewed changes and push them with a tag exactly matching `v<package.json version>`.
3. Publish a GitHub Release for that tag. The workflow validates the tag, installs dependencies, runs `npm test`, then runs `npm publish --access public`.

Tag pushes and draft releases do not publish. Published prereleases also trigger publishing and use npm's default `latest` dist-tag; there is no separate prerelease channel.
