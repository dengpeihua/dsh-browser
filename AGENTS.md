# Repository Guidelines

## Project Structure & Module Organization

`src/` is the source of truth. `src/index.ts` exposes the Cordis plugin, `plugin-tools.ts` registers DSH browser tools, and `tool-schemas.ts` defines their schemas. Browser lifecycle code lives in `src/browser/manager.ts`; implementations are under `src/browser/operations/`, with CDP and DOM support in `src/browser/cdp/` and `src/browser/dom/`.

Tests use Node's built-in runner in `test/*.test.mjs`. Real-browser and installation checks live in `scripts/`. `cordis.patch.yml` connects the plugin to a DSH profile. Treat `lib/`, `node_modules/`, browser output, and `.tgz` packages as generated artifacts.

## Build, Test, and Development Commands

- `npm install` installs development dependencies. Node.js 22.19 or newer is required.
- `npm run build` compiles `src/index.ts` into the ESM package under `lib/`.
- `npm test` builds and runs all `node:test` suites.
- `npm run test:smoke` launches Chromium and exercises the primary browser flow.
- `npm run verify:package` checks bundle metadata, dependencies, and published files.
- `npm run verify:installed` installs the package in a temporary consumer and verifies its exports.
- `npm run check` runs unit/package tests plus installed-package verification.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports with `.js` extensions, two-space indentation, double quotes, and no semicolons. Follow existing names: `camelCase` for functions and variables, `PascalCase` for types/classes, and `browser_snake_case` for tool IDs. Keep schemas in `tool-schemas.ts` and configuration defaults and validation in `config.ts`. No formatter or linter is configured, so match surrounding code and rely on the TypeScript build.

## Testing Guidelines

Name tests `*.test.mjs` and describe observable behavior. Add registration/schema tests for new tools and failure-path tests for approval, cancellation, timeouts, and cleanup. Run `npm test` for ordinary changes; add `test:smoke` for Chromium, CDP, DOM, screenshot, or navigation changes. Static or mocked success does not replace real-browser verification.

## Commit & Pull Request Guidelines

This snapshot has no Git history to inspect. Follow the documented Conventional Commit style, such as `feat: add history navigation`, `fix(dom): preserve selector mapping`, or `docs: clarify installation`. Keep pull requests focused; explain motivation and user-visible effects, link relevant issues, list exact verification commands and results, and include reproducible steps or screenshots for interaction changes.

## Security & Configuration

Never commit cookies, credentials, page content, local browser profiles, or absolute private paths. Preserve agent-scoped browser isolation, propagate abort signals, and fail closed when required approval services are unavailable. Report vulnerabilities through the private process in `SECURITY.md`, not a public issue.
