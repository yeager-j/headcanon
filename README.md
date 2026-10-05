# Headcanon

Optimistic mutations for Next.js: believe your writes until canon says
otherwise. The package documentation is in
[`packages/headcanon/README.md`](packages/headcanon/README.md).

## Layout

| Path                 | What it is                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/headcanon` | The published `headcanon` package.                                                                         |
| `fixture`            | A private Next.js App Router app. Its Playwright suite tests the client lifecycle through the real router. |

Both are npm workspaces, so the fixture and the package share one installed
copy of React and Next.

## Commands

```sh
npm install
npm run lint
npm run typecheck
npm run depcheck              # bundle-safety and shipped-import gates
npm run check:public-api-docs # every public export has JSDoc
npm test                      # set HEADCANON_TEST_DATABASE_URL to run the Postgres suite
npm run check:package         # publint + Are the Types Wrong
npm run test:e2e              # builds the package, then runs the fixture's Playwright suite
```

## Publishing

`headcanon` depends on
[`serializable-result`](https://www.npmjs.com/package/serializable-result).
Publish that package first.

```sh
cd packages/headcanon
npm publish
```

`prepack` builds `dist/` before npm packs the tarball.
