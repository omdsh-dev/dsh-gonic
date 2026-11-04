# DSH Plugin Conventions (omdsh-dev)

This file collects the current engineering decisions and the hard-won caveats
behind them for the DSH plugins maintained in the `omdsh-dev` GitHub org. It is
a snapshot of reasoning, not authority: every rule here should carry its
evidence and its expiry condition, and any rule whose premise no longer holds
should be challenged and rewritten. An identical copy lives in every plugin
repo; when a convention changes, change every copy in the same PR series.

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

## 2. TypeScript toolchain

- **tsc only, deliberately minimal.** No eslint/knip/vitest/tsdown so far; add
  one only when a concrete failure shows up that tsc cannot catch. `typescript` is pinned to **^5.9.x** — TS 7 removed
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
  react/react-dom for the client) are declared as **peerDependencies** — the
  host must remain the single runtime copy; vendoring them would split module
  identity and version-skew against the loader. The same packages are repeated
  in **devDependencies** (pinned to the host's bundled versions, currently
  `0.2.1-rc.5`) so `tsc` and smoke tests resolve real types.
- `dsh.bundle.patch` → `./cordis.patch.yml`; `dsh.client.inject` lists exactly
  the client services used; `dsh.client.platform: "web"`.
- No `private` field; declare `publishConfig: { "access": "public" }` and
  `repository`. Distribution is covered in §10.

## 4. Host-side patterns

- **cordis.patch.yml**: one `insert` row `{ id, name, config }`. When the
  plugin has on/off semantics, config carries `announceToAgent: true` and
  `enabled: true` with Chinese inline comments.
- **Credential/config store** (copy the dsh-memos `MemosStore` template):
  file at `~/.dsh/dsh-<name>.json`, `mkdir` mode `0700`, `writeFile` mode
  `0600`; lazy cached `load()`, `save()`, `patch()` (string replaces /
  reset clears / undefined keeps), and `view()` that masks secrets
  (`abcd****wxyz`). Do not log or return an unmasked secret — it would land
  in transcripts and session logs.
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
- Plain React via `createElement` (no JSX), no runtime CSS framework. Style
  with the host's `--dsw-*` token layer: `dsh-client-ui-theme` defines
  `--dsw-static-*` primitives and `--dsw-alias-*` semantic aliases on `body`
  (light + `data-ds-dark-theme`), so tokens resolve **with or without a skin
  plugin** — skins merely override the aliases. Inline style objects are fine
  for layout; interactive controls (inputs, buttons) get a small injected
  stylesheet so `:focus`/`:hover`/`:disabled` work (see `.dsm-*` in
  dsh-memos/src/client.ts and `.dsg-*` in dsh-gonic/src/client.ts). Do not
  hardcode grays — they break the stock dark theme even with no skin
  installed.
- Settings forms share one layout **and copy** kit. Layout: `form` (column,
  gap 10, max-width 420) → `form-title` → `note` → `field` blocks
  (`label` + control) → action row → `ok`/`err` feedback line. Copy rules:
  - `form-title` is the **plugin name** (`t("settings")`), not a sentence —
    no parentheticals, no "（自托管 · 只读）" style suffixes.
  - `note` is a **static** line about where credentials live (path + mode
    0600 + who shares it). Do not put dynamic state there.
  - Labels are short nouns ("服务器地址", "访问令牌"); hints belong in the
    input's placeholder, not the label.
  - The form is **prefilled from the saved config**; secrets are shown
    masked in the placeholder with a "leave blank to keep" hint, never
    unmasked and never in a status line.
  - Exactly **one primary button** (`button[data-primary="1"]`), which does
    save → test → ok/err in one action ("保存并测试"); its label switches to
    `t("loading")` while busy. Other actions are plain secondary buttons.
  - All user-facing strings go through `ctx.locale` (`t()`), with `en` and
    `zh` dicts registered in `apply()`; `locale/*.json` carry `meta.title` /
    `meta.description` for the plugin list.
  Reference implementations: `.dsg-*` in dsh-gonic, `.dsm-*` in dsh-memos.
- Settings UI registers `settings.section` with an order from the §8
  registry.
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

## 9. Current exceptions and open questions

- **dsh-web-skin** is client-only (no tools/routes/store); its palettes are
  data modules and stay `.mjs`, and `tools/*.mjs` are dev scripts — converting
  data files to TS would add a build hop with no type surface to check.
- Shared helper package: none so far — the credential store and HTTP helpers
  are copied per plugin from the dsh-memos template. The copy overhead is
  small and a package would add versioning/release coupling; revisit (as e.g.
  `dsh-plugin-kit`) when a fifth plugin appears or the copied surface grows.

## 10. Distribution

Two channels, both fed by the same version bump:

- **GitHub Release tarball** (`release.yml`): every push to `main` packs
  `npm pack` output → `dist/pkg.tgz` → creates or refreshes the `v<version>`
  release. Installs with
  `dsh plugin --profile web add ".../releases/latest/download/pkg.tgz"`.
- **npm** (`publish.yml`): fires when that release is published (or manually).
  Uses OIDC trusted publishing (`permissions: id-token: write`) with
  `npm publish --provenance --access public` — no `NPM_TOKEN` secret is
  stored, so the npmjs.com side must configure a trusted publisher for this
  repository + `publish.yml`. An already-published version is skipped, so
  re-runs are safe.

Rules:

- **No `private` field** — every plugin is publishable. `private: true` is the
  only thing that blocks `npm publish` (note: `--dry-run` does NOT enforce it,
  so it is not a CI safety net), and all four packages are unscoped npm names
  that anyone could otherwise register.
- `publishConfig: { "access": "public" }` and `repository` are declared on
  every package for provenance linking and explicit intent.
- Releasing = bump `version` in `package.json`, push to `main`. Never publish
  a version from a dirty tree, and never reuse a version (npm is immutable).
