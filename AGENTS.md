# DSH Plugin Conventions (omdsh-dev)

This file is the shared engineering contract for the DSH plugins maintained in
the `omdsh-dev` GitHub org. An identical copy lives in every plugin repo; when
you change a convention, change every copy in the same PR series.

## 1. Repository layout

```
src/index.ts          host half (cordis plugin: tools, routes, system prompt)
src/client.ts         client half (ModuleLoader classic script — see §5)
lib/                  tsc OUTPUT — gitignored, rebuilt by `npm run build`
scripts/smoke.mjs     dependency-light smoke test (runs against a stub or URL)
locale/*.json         client i18n (en.json / zh.json) — when the client has UI text
icon.svg              64×64 rounded tile + white glyph (see §7)
cordis.patch.yml      bundle patch row (see §4)
README.md             English — the canonical doc
README.zh.md          Chinese mirror of README.md
LICENSE               MIT
AGENTS.md             this file
.github/workflows/ci.yml
```

## 2. TypeScript toolchain (the only sanctioned stack)

- **tsc only.** No eslint/knip/vitest/tsdown unless a repo genuinely outgrows
  this. `typescript` is pinned to **^5.9.x** — TS 7 removed
  `alwaysStrict: false` and would inject `"use strict"` into the classic-script
  client bundle.
- `tsconfig.json` template (copy verbatim):
  ```json
  {
    "compilerOptions": {
      "target": "ESNext",
      "lib": ["ESNext", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "alwaysStrict": false,
      "rootDir": "src",
      "outDir": "lib",
      "strict": true,
      "esModuleInterop": true,
      "verbatimModuleSyntax": true,
      "skipLibCheck": true,
      "declaration": false,
      "sourceMap": false
    },
    "include": ["src/**/*.ts"]
  }
  ```
- Why `ESNext`+`Bundler` and not `NodeNext`: under NodeNext every file is a
  module, so tsc appends `export {}` to the client bundle and breaks the
  ModuleLoader classic-script contract (see §5).
- Scripts every repo exposes:
  `build` = `tsc -p tsconfig.json`, `typecheck` = `tsc --noEmit`,
  `dev` = `tsc --watch`, `prepublishOnly` = `npm run build`.
- Package manager: **npm** (not pnpm). Install with
  `npm install --legacy-peer-deps` — the `@deepseek-ai/*` dev closure fails
  strict peer resolution.

## 3. package.json contract

- `type: "module"`, `main: "lib/index.js"`.
- `exports`: `"."` → lib/index.js, `"./client"` → lib/client.js,
  `"./icon"` → icon.svg, `"./package.json"`, plus `"./locale/*.json"` when
  locale/ exists.
- `engines`: `{ "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.2.1-rc.2 <0.3.0" }`.
- Dependencies the **host provides at runtime** (anything `@deepseek-ai/*`,
  react/react-dom for the client) are declared as **peerDependencies**; the
  same packages are repeated in **devDependencies** (pinned to the host's
  bundled versions, currently `0.2.1-rc.5`) so `tsc` and smoke tests resolve
  real types. Never add runtime `dependencies` on host packages.
- `dsh.bundle.patch` → `./cordis.patch.yml`; `dsh.client.inject` lists exactly
  the client services used; `dsh.client.platform: "web"`.
- `private: true` until an npm release is intended; then drop it and add
  `publishConfig.access: "public"`.

## 4. Host-side patterns

- **cordis.patch.yml**: one `insert` row `{ id, name, config }`. When the
  plugin has on/off semantics, config carries `announceToAgent: true` and
  `enabled: true` with Chinese inline comments.
- **Credential/config store** (copy the dsh-memos `MemosStore` template):
  file at `~/.dsh/dsh-<name>.json`, `mkdir` mode `0700`, `writeFile` mode
  `0600`; lazy cached `load()`, `save()`, `patch()` (string replaces /
  reset clears / undefined keeps), and `view()` that masks secrets
  (`abcd****wxyz`). Never log or return an unmasked secret.
- **Tools**: `defineTool` from `@deepseek-ai/dsh-tools`; names are
  `<plugin>_<verb>` (registry in §8). Object output schemas must set
  `additionalProperties` explicitly — the type system enforces this, do not
  cast it away. Let `InferArgs`/`InferValue` infer execute/render types.
- **Routes**: exact-path handlers under `/api/dsh-<name>/*`, guarded by the
  loopback fence (`isLoopbackRequest`: 127.0.0.1/::1 + same-origin markers),
  `writeJson` with `referrer-policy: no-referrer`, JSON body cap 64 KiB.
- **ctx typing**: real cordis `Context` + the augmentations from
  `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-system-prompt` (type-only
  import), intersected with a minimal local `webServer` interface — upstream
  augments the service as `httpServer` but the host composition injects
  `webServer`.
- **System prompt**: `ctx.systemPrompt.section({ name: "plugin:dsh-<name>",
  order: <registry>, text })` — orders are registered in §8; claim a new one
  here before using it.

## 5. Client-side patterns

- The client bundle is a **ModuleLoader classic script**:
  `window.__ModuleLoader__.load({ id, factory })`. The emitted
  `lib/client.js` must contain **zero import/export statements** — type the
  script via top-level `interface Window { __ModuleLoader__: … }`
  augmentation and a typed `ModuleRequire` (see dsh-memos/src/client.ts).
- Plain React via `createElement` (no JSX), inline styles only, no runtime
  CSS framework. Use the DSH theme alias variables (`--dsw-*`) when styling
  interactive UI so skins keep working.
- Settings UI registers `settings.section` with an order from the §8
  registry; user-facing strings go through `locale/*.json` (`t(key)`).
- Client build caveat registry (learned the hard way):
  - TS 7 injects `"use strict"` into script emit → pin TS 5.9.x.
  - Write `as` casts so no parens survive emit:
    `expr as T | undefined ?? {}`, never `(expr ?? {}) as T`.
  - JsonValue-targeted payload shapes must be `type` aliases, not interfaces
    (interfaces lack implicit index signatures).

## 6. CI

`.github/workflows/ci.yml` (same shape in every repo): checkout →
setup-node 24 → `npm ci --legacy-peer-deps` → `typecheck` → `build` → host
entry import check → `npm pack --dry-run`. Smoke tests run **locally**
(`node scripts/smoke.mjs …`), not in CI, unless a repo wires a local stub
server into the workflow.

## 7. Docs

- README structure: **Features → Compatibility → Install → Configure →
  Development → License**. README.md is English; README.zh.md is the Chinese
  mirror (a Chinese-primary README lives at README.zh.md with a fresh English
  README.md, not the other way round).
- `icon.svg`: 64×64 viewBox, rounded-rect tile (rx 14) in a distinct brand
  color, single white glyph.
- Versioning: semver; bump in the release commit only.

## 8. Registries (claim before use)

| Registry | dsh-memos | dsh-gonic | dsh-web-skin | dsh-pi-models |
|---|---|---|---|---|
| systemPrompt order | 151 | 152 | — | — |
| settings.section order | 301 | 302 | (theme picker, no section) | — |
| tool prefix | `memos_` | `gonic_` | — | — |
| route prefix | `/api/dsh-memos` | `/api/dsh-gonic` | — | — |
| config file | `~/.dsh/dsh-memos.json` | `~/.dsh/dsh-gonic.json` | localStorage | pi credentials seam |

## 9. Sanctioned exceptions

- **dsh-pi-models** stays pure-JS by design (no build step, no lockfile
  philosophy). Apply only §3 engines, §6 CI shape, and §7 docs to it.
- **dsh-web-skin** is client-only (no tools/routes/store); its palettes are
  data modules and may stay `.mjs`, and `tools/*.mjs` are dev scripts.
- Shared helper package: **deliberately none for now** — the credential store
  and HTTP helpers are copied per plugin from the dsh-memos template. Revisit
  (as e.g. `dsh-plugin-kit`) when a fifth plugin appears or the copied
  surface grows.
