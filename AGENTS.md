# AGENTS.md - StreamBridge

## Overview

StreamBridge is a Stremio addon that resolves streams from Emby servers. It is a small Node.js (Express 5) project with plain JavaScript (CommonJS), no TypeScript, no linter, no formatter, no test framework. Deployed via BeamUp (Stremio addon hosting).

## Structure

```
/opt/streambridgeNEW/
  index.js              # Express server: routes, manifest, stream handler, auth endpoint
  lib/
    commonClient.js     # Shared helpers: ID parsing, media-info extraction, stream enrichment, sorting
    embyClient.js       # Emby API client: item lookup (movie/series/episode), playback streams
    jellyfinClient.js   # Jellyfin API client (same shape as embyClient, currently unused/commented out)
    redact.js           # URL redaction for safe logging
  public/
    configure.html      # Single-page config UI (inline CSS + JS, dark theme)
  scripts/
    bump-version.js     # Patch version bumper: updates package.json + readme badge
  package.json
  readme.md
```

## Commands

```bash
# Install dependencies
npm install

# Run the server (default port 7000)
npm start                        # or: node index.js
PORT=3000 npm start              # custom port

# Bump patch version (1.2.X -> 1.2.X+1) in package.json and readme badge
npm run version:patch

# Deploy to BeamUp
git push beamup main:master
```

## No Tests / No Linting

There are no test files, no test runner, no `.eslintrc`, no `.prettierrc`, no `tsconfig.json`. If you add tests, use a lightweight runner (e.g., `node --test` built-in or vitest) and place test files next to the source as `*.test.js`.

## Code Style

### Language & Module System
- **Plain JavaScript (ES2020+)** with CommonJS (`require` / `module.exports`)
- No TypeScript. No ESM (`import`/`export`). Keep it CommonJS.
- Node.js >= 14 target (per readme), but uses optional chaining (`?.`), nullish coalescing (`??`), logical assignment (`||=`), so effectively Node >= 16.

### Formatting
- 2-space indentation in most files; some alignment padding on `const` declarations in `index.js` (e.g., `const express = require(...)` with aligned `=`). Follow whichever local style the file already uses.
- Double quotes for strings (`"string"`), not single quotes. Exceptions exist in `commonClient.js` which uses single quotes for object keys — match the file you're editing.
- Semicolons: **always** used.
- Trailing commas: **not used**.
- Max line length: no formal limit; keep reasonable (~120 chars).

### Naming
- **Functions**: `camelCase` — `getStream`, `parseMediaId`, `findMovieItem`, `decodeCfg`.
- **Constants**: `UPPER_SNAKE_CASE` — `ITEM_TYPE_MOVIE`, `DEFAULT_FIELDS`, `CODEC_FORMAT_MAP`.
- **Local variables**: `camelCase` — `foundItems`, `streamDetailsArray`, `qualityTitle`.
- **Private/internal helpers**: prefix with `_` — `_isMatchingProviderId`.
- **Files**: `camelCase.js` — `embyClient.js`, `commonClient.js`.

### Imports
- Group: Node built-ins first, then npm packages, then local modules.
- Destructure only when importing specific named exports: `const { redactServerUrl } = require("./lib/redact")`.
- For modules with many exports, import the whole module: `const common = require("./commonClient")`.

### Functions
- Regular `function` declarations for top-level named functions (hoisted).
- Arrow functions (`=>`) for callbacks and inline handlers.
- `async/await` for all asynchronous code (no raw `.then()` chains).
- JSDoc on all exported functions with `@param` and `@returns`.

### Error Handling
- **SECURITY-CRITICAL**: Never log full error objects, config, tokens, or server URLs. Log only `err?.message || String(err)`. Use `redactServerUrl()` for any URL in logs.
- Return `null` on failure (not throw) in client functions (`makeApiRequest`, `findMovieItem`, etc.).
- Express route handlers: catch errors and return a JSON response (usually `{ streams: [] }` for stream routes, `{ err: "message" }` for auth).
- Stack traces: only log in `development` mode (`process.env.NODE_ENV === 'development'`).
- Use emoji prefixes in `console.warn`/`console.error` for quick scanning: `"❌ ..."`, `"⚠️ ..."`, `"🔧 ..."`.

### API Pattern (Emby/Jellyfin clients)
- `embyClient.js` and `jellyfinClient.js` are structurally identical. Both re-export `common.parseMediaId` and `common.deduplicateAndSortStreams`.
- The main entry point is `getStream(idOrExternalId, config)` where `config = { serverUrl, userId, accessToken }`.
- Item lookup uses a multi-strategy approach: Strategy 1 (direct ID param) then Strategy 2 (AnyProviderIdEquals) as fallback.
- Always verify provider IDs with `_isMatchingProviderId()` after each search.

### Express Routes
- Parameterised routes use a base64url-encoded config blob as `:cfg` path param.
- `decodeCfg()` in `index.js` handles decoding with backward-compatible defaults.
- Rate limiting on sensitive endpoints (auth).
- CORS enabled globally.
- Static files served from `public/`.

### Frontend (configure.html)
- Single HTML file with inline `<style>` and `<script>` — no build step, no framework.
- CSS custom properties for theming (dark mode only).
- Vanilla JS with `$` shorthand for `querySelector`.
- Uses `// JELLYFIN:` comment prefix for all Jellyfin-related code that is commented out for future support.

## Security Rules (CRITICAL — do not violate)

1. **Never log user credentials**: `accessToken`, `userId`, `serverUrl` must never appear in logs. Use `redactServerUrl()`.
2. **Never log full error objects**: only `err?.message || String(err)`.
3. **Never log `cfgString`**: it contains base64-encoded credentials.
4. **Auth endpoint**: rate-limited (5 req / 15 min). Validates URL scheme. Proxies auth through server-side to avoid CORS.
5. **Config in URL**: sensitive by design (tokens in base64 path). Don't add query-string logging middleware.

## Architecture Notes

- **Jellyfin support** is fully coded but commented out everywhere (marked with `// JELLYFIN:` comments). The `jellyfinClient.js` file exists and works. Re-enabling requires uncommenting in `index.js`, `configure.html`, and the Jellyfin card UI.
- `commonClient.js` is the shared core — all media enrichment, ID parsing, and stream sorting lives here. Both `embyClient.js` and `jellyfinClient.js` depend on it.
- Stream enrichment builds a multi-line description with quality tag, HDR info, codec, audio, container, bitrate, and file size.
- `shouldFilterStream()` in `index.js` filters streams by user-configured hide preferences (4K, 1080p, DV, HDR).
- Version is read from `package.json` at startup and used in the manifest and auth headers.

## Backward Compatibility

This addon has live users. Config blobs are stored in Stremio client URLs. When adding new config fields:
1. Always provide defaults in `decodeCfg()` for missing fields.
2. Never rename or remove existing config keys (`serverUrl`, `userId`, `accessToken`, `serverType`, `showServerName`, `streamName`, `hideStreamTypes`, `includeSubtitles`).
3. New optional fields must be omitted (not set to `null`/`false`) when unconfigured so old URLs keep working.

## Dependencies

| Package | Purpose |
|---------|---------|
| express@5 | HTTP server + routing |
| axios | HTTP client for Emby/Jellyfin API calls |
| cors | CORS middleware |
| express-rate-limit | Rate limiting on auth endpoint |
| dotenv | `.env` file loading |
| stremio-addon-sdk | Listed as dep but not directly imported (manifest structure follows its conventions) |
