# dsh-gonic

Gonic/Subsonic music player for the DeepSeek Harness Web GUI.

- **Player (Client half)**: the browser talks to your Gonic server directly
  (its API answers CORS; `stream.view` URLs carry query-string credentials and
  never expire, and `<audio>` playback needs no CORS at all). Browse
  (artists / albums / genres / recent / random), search, starred songs,
  playlists, play queue with repeat/shuffle, volume, resume of the last
  position, a mini now-playing bar under the composer.
- **Agent tools (Host half)**: `gonic_status`, `gonic_search`, `gonic_browse`,
  `gonic_starred`, `gonic_playlists`, `gonic_playlist`, the write operation
  `gonic_create_playlist`, and `gonic_play` — a Host→browser command channel
  that starts playback (`playlistId` for a whole playlist / `trackIds` for
  specific tracks / `query` to play the first N search hits). The tool writes
  the tracks into an in-memory Host slot; the browser polls
  `/api/dsh-gonic/play-command` every 3 s, executes only commands published
  after the page loaded (baseline), and claims each command via localStorage
  so multiple tabs never play doubled. Requires the GUI open in a browser tab
  that has seen a click (autoplay policy); pause/skip/volume stay on the
  player UI.
- **Setup**: Settings → Gonic Player (or the player page itself) → enter server
  URL, username, password → Save & test.

Credentials live on the Host at `~/.dsh/dsh-gonic.json` (mode 0600), shared by
the tools and the player; the browser holds them in memory only. The queue and
the playback position stay in the browser's `localStorage` (no secrets there).

## Layout

- `lib/index.js` — Host half: config store, Subsonic client, agent tools,
  `/api/dsh-gonic/*` routes (including the play-command slot), system-prompt
  announcement. Pure ESM.
- `lib/client.js` — the whole player: MD5 auth, Subsonic micro-client, queue
  store, Audio singleton, main page / dock / settings UI, play-command
  poller. Hand-written ModuleLoader module, plain React, no build step.
- `scripts/smoke.mjs` — read-only smoke test: `node scripts/smoke.mjs`,
  covering URL normalization, argument validation, error translation and
  (when `~/.dsh/dsh-gonic.json` is configured) live read-only queries. Never
  triggers writes or real playback.

## License

MIT
