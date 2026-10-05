# Contributing to Headcanon

The package documentation is in [`README.md`](README.md).

## Layout

| Path      | What it is                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `src`     | The source of the published `headcanon` package.                                                           |
| `fixture` | A private Next.js App Router app. Its Playwright suite tests the client lifecycle through the real router. |

The repo root is the package and an npm workspace root. The fixture is its only
workspace and depends on the package through `file:..`, so both share one
installed copy of React and Next. `files` in `package.json` keeps the fixture
out of the published tarball.

## Commands

```sh
npm install
npm run lint
npm run typecheck
npm run depcheck              # client-entry bundle-safety gate
npm run check:public-api-docs # every public export has JSDoc
npm test                      # set HEADCANON_TEST_DATABASE_URL to run the Postgres suite
npm run check:package         # publint + Are the Types Wrong
npm run test:e2e              # the fixture's Playwright suite; locally it rebuilds the package first
```

## Publishing

`headcanon` depends on
[`serializable-result`](https://www.npmjs.com/package/serializable-result).
Publish that package first. Then, from the repo root:

```sh
npm publish
```

`prepack` builds `dist/` before npm packs the tarball.
