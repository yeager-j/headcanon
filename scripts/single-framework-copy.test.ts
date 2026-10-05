import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { ROOT } from "./package-entries.mjs"

// The fixture runs the package inside a real app. Two copies of React or Next
// would give the package and the app separate hook dispatchers and routers,
// so the e2e suite would fail for a reason unrelated to the package.
describe("workspace install", () => {
  it.each(["react", "react-dom", "next"])(
    "gives the package and the fixture one copy of %s",
    (name) => {
      const fromPackage = createRequire(join(ROOT, "package.json"))
      const fromFixture = createRequire(join(ROOT, "fixture/package.json"))

      expect(fromFixture.resolve(`${name}/package.json`)).toBe(
        fromPackage.resolve(`${name}/package.json`)
      )
    }
  )
})
