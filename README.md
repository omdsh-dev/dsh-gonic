# dsh-gonic

> [中文](README.zh.md) | **English**

Play your [Gonic](https://github.com/sentriz/gonic)/Subsonic music library inside the DeepSeek Harness Web GUI — browse, search, starred songs, playlists, queue and playback — and give agents tools that search your library, build playlists, and start playback in your browser.

## Features

- **Player (client half)** — the browser talks to your Gonic server directly (its API answers CORS; `stream.view` URLs carry query-string credentials and never expire, and `<audio>` playback needs no CORS at all). Browse (artists / albums / genres / recently added / random), search, starred songs, playlists, a play queue with repeat/shuffle, volume control, resume of the last position, and a mini now-playing bar docked under the conversation composer.
- **Agent tools (host half)** — `gonic_status`, `gonic_search`, `gonic_browse`, `gonic_starred`, `gonic_playlists`, `gonic_playlist`, the one write operation `gonic_create_playlist`, and `gonic_play`: a Host→browser command channel that starts playback (`playlistId` for a whole playlist / `trackIds` for specific tracks / `query` to play the first N search hits, `limit` to tune N). The tool writes the tracks into an in-memory Host slot; the browser polls `/api/dsh-gonic/play-command` every 3 s, executes only commands published after the page loaded (baseline), and claims each command via localStorage so multiple tabs never play doubled. Requires the GUI open in a browser tab that has seen a click (autoplay policy); pause/skip/volume stay on the player UI.
- **Settings panel** — Settings → Gonic Player (section order 302) holds the connection form (server URL, username, password) with save + connection test; the same form gates the player page until the server is configured.
- Credentials persist on the Host at `~/.dsh/dsh-gonic.json` (mode 0600), shared by the tools and the player; the browser holds them in memory only. The queue and playback position stay in the browser's `localStorage` (no secrets there).
- The `/api/dsh-gonic/*` routes answer loopback same-origin requests only (127.0.0.1/::1 peers, `sec-fetch-site: cross-site` rejected, `origin` must match the loopback host; responses carry `referrer-policy: no-referrer`) — the config route hands the browser the Subsonic credentials, so neither a LAN peer nor a cross-site web page can read them or push play commands.
- System-prompt announcement (`plugin:dsh-gonic`, order 152) so agents know when to reach for this plugin.

## Compatibility

Any Subsonic-API server answering **API 1.15.0** JSON requests (salt+token auth, `f=json`) — developed against [Gonic](https://github.com/sentriz/gonic). Endpoints used: `ping`, `search3`, `getArtists`, `getArtist`, `getAlbum`, `getAlbumList2`, `getGenres`, `getSongsByGenre`, `getRandomSongs`, `getStarred2`, `getPlaylists`, `getPlaylist`, `createPlaylist`, `getSong`, `getCoverArt`, `stream`.

Host: Node `^22.19.0 || >=24.0.0`, DSH `>=0.2.1-rc.2 <0.3.0`.

## Install

Published releases carry the compiled `lib/` output, so the tarball needs no
build:

```sh
dsh plugin --profile web add "https://github.com/omdsh-dev/dsh-gonic/releases/latest/download/pkg.tgz"
```

For local development, link the checkout instead:

```sh
npm install --legacy-peer-deps && npm run build   # first time only: src/*.ts → lib/
dsh plugin --profile web add link:/path/to/dsh-gonic
```

(`--legacy-peer-deps` because the `@deepseek-ai/*` dev closure fails strict peer resolution.)

Restart `dsh web`. Source is TypeScript (`src/`); `lib/` is `tsc` output — pure ESM with zero runtime dependencies.

## Configure

1. In the DSH web settings page, open **Gonic Player** (or open the player page itself), enter server URL, username and password, then hit **Save & test** — or just ask the agent: "Configure gonic: server http://192.168.1.10:4747, user ..., password ...".
2. Then ask things like "search my library for X", "create a playlist called Y with those tracks", or "play my playlist Z".

> The password is a full Subsonic credential for your library. The agent tools can read and create playlists, but cannot modify, delete, or star anything else.

## Development

- `npm run build` — compile `src/` to `lib/`; `npm run typecheck` — strict check without emit; `npm run dev` — watch mode.
- `src/index.ts` — host half: config store, Subsonic client, agent tools, `/api/dsh-gonic/*` routes (including the play-command slot), system-prompt announcement.
- `src/client.ts` — the whole player: MD5 auth, Subsonic micro-client, queue store, Audio singleton, main page / dock / settings UI, play-command poller. A ModuleLoader classic script (plain React `createElement`, no JSX); the emitted `lib/client.js` must stay free of `import`/`export` statements and starts with `window.__ModuleLoader__.load(`.
- `scripts/smoke.mjs` — read-only smoke test: `node scripts/smoke.mjs`, covering URL normalization, argument validation, the loopback route fence, error translation and (when `~/.dsh/dsh-gonic.json` is configured) live read-only queries. Never triggers writes or real playback.
- `locale/*.json` — plugin meta strings (en / zh); `icon.svg` — panel tile.

## License

MIT
