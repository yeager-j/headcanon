# Contributing to Headcanon

The package documentation is in [`README.md`](README.md) and the guides in
[`docs/`](docs).

## Layout

| Path      | What it is                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `src`     | The source of the published `headcanon` package.                                                           |
| `scripts` | The repo gates (`check-*.mjs`), their tests, and the vitest setup that unmounts DOM tests' React roots.    |
| `fixture` | A private Next.js App Router app. Its Playwright suite tests the client lifecycle through the real router. |

The repo root is the package and an npm workspace root. The fixture is its only
workspace and depends on the package through `file:..`, so both resolve one
installed copy of React and Next; `npm test` fails if they do not. `files` in
`package.json` keeps the fixture out of the published tarball and ships
`docs/`, so JSDoc pointers such as `docs/server-setup.md#...` resolve in an
installed copy.

`package.json#exports` is the one list of public entries. The gates read it, so
a new export is checked with no edit to them. Every export ships to browsers
unless `scripts/check-bundle-safety.mjs` lists it as server-only.

Inside `src`, export `./a` builds from `src/a/index.ts` and `./a/b` from
`src/a/b.ts` or `src/a/b/index.ts`. The one exception is
`headcanon/drizzle-schema`, which builds from `src/drizzle/schema.ts`. Every
other file is internal. An `index.ts` only re-exports; code lives in named
files beside it. Tests sit beside the file they test.

Relative imports name no extension and no `/index`: write `../react`, not
`../react/index`. `tsconfig.build.json` (`moduleResolution: "Bundler"`) is the
one authority for how an import resolves. The build's `tsc-alias` step turns
each into a full Node path, and the gates that follow imports ask TypeScript
with the same options instead of guessing.

| Folder        | What it holds                                                                    |
| ------------- | -------------------------------------------------------------------------------- |
| `src/core`    | The protocol model and authority. No React or Next: it is the `headcanon` graph. |
| `src/react`   | The predicted root (hook, context, ledger), the observed root, and refresh.      |
| `src/server`  | The binder and command outcomes. No React or Next: it is `headcanon/server`.     |
| `src/next`    | The Next bindings. `server/` splits revalidation and the action.                 |
| `src/ably`    | The Ably invalidation transport.                                                 |
| `src/drizzle` | The Postgres authority and its receipt table.                                    |
| `src/testing` | Test doubles; the contract suites are in `suites/`.                              |

`headcanon` is for application code. Every export there is used by the docs
or the fixture, names a type in a public signature, or is grouped under the
diagnostics comment in `src/index.ts`. Adapter internals stay unexported: the
authority receipt protocol in `src/core/authority.ts` (only the Drizzle and
in-memory authorities implement `MutationAuthorityAdapter`), the invalidation
payload parser and lazy adapter, and the Ably channel names. Exporting one
later is an addition; removing one is a breaking change.

`headcanon/testing` holds only test doubles and must import no test framework:
`scripts/check-bundle-safety.mjs` walks its import graph and rejects `vitest`
and Testing Library. Contract suites go in `src/testing/suites/`. The refresh
suite is published from `headcanon/testing/react` (vitest, Testing Library,
DOM). The authority and invalidation suites are internal: Headcanon's own
adapters run them by relative import. Each suite's cases also run against
deliberately broken harnesses in `src/testing/*.test.ts`, so a new case needs a
broken harness that it catches.

## Commands

Node 22 or later. The fixture uses the package's built `dist/`; each root
script that needs it builds it first, and fixture scripts never do.

```sh
npm install
npm run lint
npm run typecheck             # the package and gate scripts; no build
npm run check:bundle-safety   # browser entries import nothing server-only; test doubles import no test framework
npm run check:public-api-docs # every public export has JSDoc
npm run check:doc-links       # doc links resolve; the README lists every export
npm test                      # set HEADCANON_TEST_DATABASE_URL to run the Postgres suite
npm run check:package         # builds; publint + Are the Types Wrong
npm run check:fixture         # builds; type-checks the fixture with its generated route types
npm run test:e2e              # builds the package and fixture; Playwright against `next start`
npm run dev:fixture           # builds; the fixture's dev server on port 3900
```

The e2e suite never retries: it is the control for an intermittent deadlock. A
failure keeps its Playwright trace in `fixture/test-results/`.

## Publishing

`headcanon` depends on
[`serializable-result`](https://www.npmjs.com/package/serializable-result).
Publish that package first. Then, from the repo root:

```sh
npm publish
```

`prepack` builds `dist/` before npm packs the tarball.
