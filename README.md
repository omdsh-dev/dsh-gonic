# dsh-gonic

Gonic/Subsonic music player for the DeepSeek Harness Web GUI.

- **Player (Client half)**: the browser talks to your Gonic server directly
  (its API answers CORS; `stream.view` URLs carry query-string credentials and
  never expire, and `<audio>` playback needs no CORS at all). Browse
  (artists / albums / genres / recent / random), search, starred songs,
  playlists, play queue with repeat/shuffle, volume, resume of the last
  position, a mini now-playing bar under the composer.
- **Agent tools (Host half)**: `gonic_status`, `gonic_search`, `gonic_browse`,
  `gonic_starred`, `gonic_playlists`, `gonic_playlist`, and the write
  operation `gonic_create_playlist`. They operate on the server catalogue
  only — the play queue lives in the browser, so tools cannot control what is
  currently playing.
- **Setup**: Settings → Gonic Player (or the player page itself) → enter server
  URL, username, password → Save & test.

Credentials live on the Host at `~/.dsh/dsh-gonic.json` (mode 0600), shared by
the tools and the player; the browser holds them in memory only. The queue and
the playback position stay in the browser's `localStorage` (no secrets there).

## Layout

- `lib/index.js` — Host half: config store, Subsonic client, agent tools,
  `/api/dsh-gonic/*` routes, system-prompt announcement. Pure ESM.
- `lib/client.js` — the whole player: MD5 auth, Subsonic micro-client, queue
  store, Audio singleton, main page / dock / settings UI. Hand-written
  ModuleLoader module, plain React, no build step.

## License

MIT
