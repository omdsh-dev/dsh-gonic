/**
 * dsh-gonic — Gonic/Subsonic player (client half).
 *
 * The browser calls the Subsonic REST API directly (the server answers CORS;
 * stream.view URLs carry query-string credentials and never expire, and
 * <audio> needs no CORS at all). Credentials live on the Host
 * (~/.dsh/dsh-gonic.json, mode 0600) — fetched over the same-origin
 * /api/dsh-gonic route and held in memory only — so the agent tools and this
 * client share one configuration. The queue persists in localStorage;
 * playback is a module-level Audio singleton shared by the main page, the
 * settings section and every per-session composer dock.
 *
 * Hand-written ModuleLoader module: plain React (createElement), component
 * styles ride a <style> element so unmounting removes them. No build step.
 */
window.__ModuleLoader__.load({
	id: "dsh-gonic",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		//#region md5 — RFC 1321 over UTF-8 bytes (Web Crypto has no MD5)
		var MD5_K = new Uint32Array(64);
		for (var ki = 0; ki < 64; ki++) MD5_K[ki] = Math.floor(Math.abs(Math.sin(ki + 1)) * 4294967296);
		var MD5_S = [
			7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
			5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
			4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
			6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
		];
		function md5hex(text) {
			var src = new TextEncoder().encode(text);
			var len = src.length;
			var bitLen = len * 8;
			var total = (((len + 8) >> 6) + 1) << 6;
			var buf = new Uint8Array(total);
			buf.set(src);
			buf[len] = 0x80;
			var dv = new DataView(buf.buffer);
			dv.setUint32(total - 8, bitLen >>> 0, true);
			dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);
			var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
			var M = new Uint32Array(16);
			for (var off = 0; off < total; off += 64) {
				for (var i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
				var A = a0, B = b0, C = c0, D = d0;
				for (var j = 0; j < 64; j++) {
					var F, g, r = j >> 4;
					if (r === 0) { F = (B & C) | (~B & D); g = j; }
					else if (r === 1) { F = (D & B) | (~D & C); g = (5 * j + 1) & 15; }
					else if (r === 2) { F = B ^ C ^ D; g = (3 * j + 5) & 15; }
					else { F = C ^ (B | ~D); g = (7 * j) & 15; }
					F = (F + A + MD5_K[j] + M[g]) | 0;
					A = D; D = C; C = B;
					B = (B + ((F << MD5_S[j]) | (F >>> (32 - MD5_S[j])))) | 0;
				}
				a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
			}
			var out = new Uint8Array(16);
			var odv = new DataView(out.buffer);
			odv.setUint32(0, a0 >>> 0, true); odv.setUint32(4, b0 >>> 0, true);
			odv.setUint32(8, c0 >>> 0, true); odv.setUint32(12, d0 >>> 0, true);
			var hex = "";
			for (var oi = 0; oi < 16; oi++) hex += out[oi].toString(16).padStart(2, "0");
			return hex;
		}
		//#endregion

		//#region storage helpers + stores
		var CONFIG_KEY = "dsh-gonic:config";
		var QUEUE_KEY = "dsh-gonic:queue";
		var PLAYBACK_KEY = "dsh-gonic:playback";

		function loadJSON(key, fallback) {
			try {
				var raw = localStorage.getItem(key);
				return raw ? JSON.parse(raw) : fallback;
			} catch (_) {
				return fallback;
			}
		}
		function saveJSON(key, value) {
			try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* quota: keep session state only */ }
		}

		function createStore(initial) {
			var state = initial;
			var listeners = new Set();
			return {
				get: function () { return state; },
				update: function (patch) {
					state = Object.assign({}, state, typeof patch === "function" ? patch(state) : patch);
					listeners.forEach(function (fn) { fn(); });
				},
				replace: function (next) {
					state = next;
					listeners.forEach(function (fn) { fn(); });
				},
				subscribe: function (fn) {
					listeners.add(fn);
					return function () { listeners.delete(fn); };
				},
			};
		}
		function useStore(store) {
			if (React.useSyncExternalStore) {
				return React.useSyncExternalStore(store.subscribe, store.get, store.get);
			}
			var pair = React.useState(store.get());
			var setValue = pair[1];
			React.useEffect(function () {
				return store.subscribe(function () { setValue(store.get()); });
			}, [store]);
			return pair[0];
		}

		var configStore = createStore({ baseUrl: "", username: "", password: "", loaded: false });
		function isConfigured(cfg) {
			return Boolean(cfg && cfg.loaded && cfg.baseUrl && cfg.username && cfg.password);
		}
		/**
		 * Load the config from the Host (single source shared with the agent
		 * tools), migrating a legacy v1 localStorage config once if the Host has
		 * none. The browser keeps the password in memory only.
		 */
		function loadConfig() {
			return fetch("/api/dsh-gonic/config").then(function (res) { return res.json(); }).then(function (view) {
				if (view && view.configured) {
					configStore.replace({ baseUrl: view.baseUrl, username: view.username, password: view.password, loaded: true });
					return;
				}
				var legacy = loadJSON(CONFIG_KEY, null);
				if (legacy && legacy.baseUrl && legacy.username && legacy.password) {
					fetch("/api/dsh-gonic/config", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(legacy),
					}).then(function (res) { return res.json(); }).then(function (saved) {
						if (saved && saved.ok) {
							try { localStorage.removeItem(CONFIG_KEY); } catch (_) { /* best effort */ }
							configStore.replace({ baseUrl: saved.baseUrl, username: saved.username, password: saved.password, loaded: true });
							return;
						}
						configStore.update({ loaded: true });
					}).catch(function () { configStore.update({ loaded: true }); });
					return;
				}
				configStore.update({ loaded: true });
			}).catch(function () {
				configStore.update({ loaded: true });
			});
		}

		var queueStore = createStore(loadJSON(QUEUE_KEY, { tracks: [], cursor: -1, repeat: "off", shuffle: false }));
		function persistQueue() { saveJSON(QUEUE_KEY, queueStore.get()); }
		var queue = {
			setList: function (tracks, startIndex) {
				queueStore.replace({
					tracks: tracks.slice(),
					cursor: tracks.length ? (typeof startIndex === "number" ? startIndex : 0) : -1,
					repeat: queueStore.get().repeat,
					shuffle: queueStore.get().shuffle,
				});
				persistQueue();
			},
			append: function (track) {
				var q = queueStore.get();
				queueStore.update({ tracks: q.tracks.concat([track]), cursor: q.tracks.length ? q.cursor : 0 });
				persistQueue();
			},
			remove: function (index) {
				var q = queueStore.get();
				var wasCurrent = index === q.cursor;
				var tracks = q.tracks.filter(function (_, i) { return i !== index; });
				var cursor = q.cursor;
				if (index < cursor) cursor--;
				else if (wasCurrent) cursor = tracks.length ? Math.min(cursor, tracks.length - 1) : -1;
				queueStore.update({ tracks: tracks, cursor: cursor });
				persistQueue();
				if (wasCurrent) {
					if (!tracks.length) stopPlayback();
					else {
						var st = player.get().status;
						if (st === "playing" || st === "loading") playAt(cursor);
					}
				}
			},
			clear: function () {
				queueStore.update({ tracks: [], cursor: -1 });
				persistQueue();
				stopPlayback();
			},
			cycleRepeat: function () {
				var order = ["off", "all", "one"];
				var next = order[(order.indexOf(queueStore.get().repeat) + 1) % order.length];
				queueStore.update({ repeat: next });
				persistQueue();
			},
			toggleShuffle: function () {
				queueStore.update({ shuffle: !queueStore.get().shuffle });
				persistQueue();
			},
		};
		//#endregion

		//#region subsonic client
		function signParams(cfg) {
			var saltBytes = new Uint8Array(8);
			crypto.getRandomValues(saltBytes);
			var salt = "";
			for (var i = 0; i < saltBytes.length; i++) salt += saltBytes[i].toString(16).padStart(2, "0");
			return { u: cfg.username, s: salt, t: md5hex(cfg.password + salt), v: "1.15.0", c: "dsh-gonic", f: "json" };
		}
		function endpoint(cfg, view, params) {
			var q = new URLSearchParams();
			var auth = signParams(cfg);
			for (var k in auth) q.set(k, auth[k]);
			if (params) for (var p in params) q.set(p, params[p]);
			return cfg.baseUrl.replace(/\/+$/, "") + "/rest/" + view + "?" + q.toString();
		}
		async function api(cfg, view, params) {
			var res;
			try {
				res = await fetch(endpoint(cfg, view, params));
			} catch (error) {
				throw new Error(t("err.network") + ": " + (error && error.message ? error.message : error));
			}
			if (!res.ok) throw new Error("HTTP " + res.status);
			var json = await res.json();
			var body = json && json["subsonic-response"];
			if (!body || body.status !== "ok") {
				throw new Error(body && body.error && body.error.message ? body.error.message : "subsonic: bad response");
			}
			return body;
		}
		function toTrack(song) {
			return {
				id: String(song && song.id != null ? song.id : ""),
				title: (song && song.title) || "?",
				artist: (song && song.artist) || "",
				album: (song && song.album) || "",
				duration: Math.max(0, Math.floor((song && song.duration) || 0)),
				coverId: (song && (song.coverArt || song.id)) || "",
			};
		}
		function toTracks(list) {
			return (Array.isArray(list) ? list : []).filter(function (s) { return s && s.id != null; }).map(toTrack);
		}
		/**
		 * Walk the catalogue like muse's SubsonicSource.browse: the root is a
		 * menu, every other level is addressed by a `<kind>:<id>` path.
		 */
		async function browse(cfg, path) {
			if (!path) {
				return {
					nodes: [
						{ path: "artists", label: t("browse.artists") },
						{ path: "albums", label: t("browse.albums") },
						{ path: "genres", label: t("browse.genres") },
						{ path: "recent", label: t("browse.recent") },
						{ path: "random", label: t("browse.random") },
					],
					tracks: [],
				};
			}
			var sep = path.indexOf(":");
			var kind = sep === -1 ? path : path.slice(0, sep);
			var id = sep === -1 ? "" : path.slice(sep + 1);
			if (kind === "artists") {
				var ab = await api(cfg, "getArtists.view");
				var index = (ab.artists && ab.artists.index) || [];
				var artists = [];
				index.forEach(function (entry) { (entry.artist || []).forEach(function (a) { artists.push(a); }); });
				return {
					nodes: artists.filter(function (a) { return a && a.id; }).map(function (a) {
						return { path: "artist:" + a.id, label: (a.name || "").trim() || String(a.id), detail: a.albumCount ? a.albumCount + " " + t("unit.album") : "" };
					}),
					tracks: [],
				};
			}
			if (kind === "artist") {
				var arb = await api(cfg, "getArtist.view", { id: id });
				return { nodes: albumNodes((arb.artist && arb.artist.album) || []), tracks: [] };
			}
			if (kind === "album") {
				var alb = await api(cfg, "getAlbum.view", { id: id });
				return { nodes: [], tracks: toTracks(alb.album && alb.album.song) };
			}
			if (kind === "albums") {
				var albb = await api(cfg, "getAlbumList2.view", { type: "alphabeticalByName", size: "500" });
				return { nodes: albumNodes((albb.albumList2 && albb.albumList2.album) || []), tracks: [] };
			}
			if (kind === "recent") {
				var rb = await api(cfg, "getAlbumList2.view", { type: "newest", size: "50" });
				return { nodes: albumNodes((rb.albumList2 && rb.albumList2.album) || []), tracks: [] };
			}
			if (kind === "genres") {
				var gb = await api(cfg, "getGenres.view");
				var genres = ((gb.genres && gb.genres.genre) || [])
					.filter(function (g) { return g && (g.value || "").trim() !== ""; })
					.sort(function (a, b) { return (b.songCount || 0) - (a.songCount || 0); });
				return {
					nodes: genres.map(function (g) {
						return { path: "genre:" + g.value, label: g.value, detail: g.songCount ? g.songCount + " " + t("unit.song") : "" };
					}),
					tracks: [],
				};
			}
			if (kind === "genre") {
				var sb = await api(cfg, "getSongsByGenre.view", { genre: id, count: "500" });
				return { nodes: [], tracks: toTracks(sb.songsByGenre && sb.songsByGenre.song) };
			}
			if (kind === "random") {
				var rdb = await api(cfg, "getRandomSongs.view", { size: "50" });
				return { nodes: [], tracks: toTracks(rdb.randomSongs && rdb.randomSongs.song) };
			}
			throw new Error("unknown browse path: " + path);
		}
		function albumNodes(albums) {
			return albums.filter(function (al) { return al && al.id; }).map(function (al) {
				var name = (al.name || al.title || "").trim() || String(al.id);
				var label = (al.artist || "").trim() ? name + " · " + al.artist.trim() : name;
				return { path: "album:" + al.id, label: label, detail: al.songCount ? al.songCount + " " + t("unit.song") : "" };
			});
		}
		function coverUrl(cfg, coverId, size) {
			return endpoint(cfg, "getCoverArt.view", { id: coverId, size: String(size || 64) });
		}
		//#endregion

		//#region player — one Audio element per module run
		var audio = new Audio();
		audio.preload = "auto";
		var resumeCache = loadJSON(PLAYBACK_KEY, null);
		var player = createStore({
			status: "idle", // idle | loading | playing | paused | error
			position: 0,
			duration: 0,
			volume: resumeCache && typeof resumeCache.volume === "number" ? Math.min(100, Math.max(0, resumeCache.volume)) : 80,
			error: "",
		});
		audio.volume = player.get().volume / 100;

		function persistPlayback() {
			var q = queueStore.get();
			var cur = q.cursor >= 0 ? q.tracks[q.cursor] : null;
			saveJSON(PLAYBACK_KEY, { id: cur ? cur.id : null, position: audio.currentTime || 0, volume: player.get().volume });
		}
		function playAt(index) {
			var cfg = configStore.get();
			var q = queueStore.get();
			var track = q.tracks[index];
			if (!track || !isConfigured(cfg)) return;
			queueStore.update({ cursor: index });
			persistQueue();
			var resume = resumeCache && resumeCache.id === track.id ? Math.max(0, resumeCache.position || 0) : 0;
			resumeCache = null; // consume: one resume per fresh page load
			player.update({ status: "loading", position: resume, duration: track.duration || 0, error: "" });
			audio.src = endpoint(cfg, "stream.view", { id: track.id });
			if (resume > 0) {
				var onMeta = function () {
					audio.removeEventListener("loadedmetadata", onMeta);
					try { audio.currentTime = resume; } catch (_) { /* not seekable yet */ }
				};
				audio.addEventListener("loadedmetadata", onMeta);
			}
			var played = audio.play();
			if (played && played.catch) {
				played.catch(function (error) {
					player.update({ status: "error", error: String(error && error.message ? error.message : error) });
				});
			}
			persistPlayback();
		}
		function playTracks(tracks, startIndex) {
			if (!tracks.length) return;
			queue.setList(tracks, startIndex);
			playAt(typeof startIndex === "number" ? startIndex : 0);
		}
		function toggle() {
			var q = queueStore.get();
			if (!q.tracks.length) return;
			if (audio.src && q.cursor >= 0) {
				if (audio.paused) { void audio.play().catch(function () {}); }
				else audio.pause();
			} else {
				playAt(q.cursor >= 0 ? q.cursor : 0);
			}
		}
		function nextTrack(auto) {
			var q = queueStore.get();
			if (!q.tracks.length) return;
			if (auto && q.repeat === "one") {
				audio.currentTime = 0;
				void audio.play().catch(function () {});
				return;
			}
			var ni;
			if (q.shuffle && q.tracks.length > 1) {
				do { ni = Math.floor(Math.random() * q.tracks.length); } while (ni === q.cursor);
			} else {
				ni = q.cursor + 1;
			}
			if (ni >= q.tracks.length) {
				if (q.repeat === "all") ni = 0;
				else if (auto) { player.update({ status: "idle" }); persistPlayback(); return; }
				else ni = 0;
			}
			playAt(ni);
		}
		function prevTrack() {
			var q = queueStore.get();
			if (!q.tracks.length) return;
			if (audio.currentTime > 3 || q.cursor <= 0) {
				audio.currentTime = 0;
				player.update({ position: 0 });
				return;
			}
			playAt(q.cursor - 1);
		}
		function stopPlayback() {
			audio.pause();
			audio.removeAttribute("src");
			try { audio.load(); } catch (_) { /* element already gone */ }
			player.update({ status: "idle", position: 0, duration: 0 });
			persistPlayback();
		}
		function seek(sec) {
			if (!audio.src) return;
			try { audio.currentTime = sec; } catch (_) { return; }
			player.update({ position: sec });
		}
		function setVolume(v) {
			v = Math.min(100, Math.max(0, Math.round(v)));
			audio.volume = v / 100;
			player.update({ volume: v });
			persistPlayback();
		}

		audio.addEventListener("timeupdate", function () {
			player.update({ position: audio.currentTime || 0, duration: audio.duration || player.get().duration });
		});
		audio.addEventListener("play", function () { player.update({ status: "playing" }); });
		audio.addEventListener("pause", function () {
			if (player.get().status === "playing") player.update({ status: "paused" });
			persistPlayback();
		});
		audio.addEventListener("ended", function () {
			persistPlayback();
			nextTrack(true);
		});
		audio.addEventListener("error", function () {
			if (!audio.src) return;
			player.update({ status: "error", error: t("player.error") });
		});
		//#endregion

		//#region icons — small original SVG glyphs, currentColor
		function fillIcon(d) {
			return function (size) {
				return h("svg", { viewBox: "0 0 24 24", width: size || 18, height: size || 18, fill: "currentColor", "aria-hidden": true },
					h("path", { d: d }));
			};
		}
		function strokeIcon(paths) {
			return function (size) {
				return h("svg", {
					viewBox: "0 0 24 24", width: size || 18, height: size || 18, fill: "none",
					stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
				}, paths.map(function (d, i) { return h("path", { key: i, d: d }); }));
			};
		}
		var icoPlay = fillIcon("M8 5v14l11-7z");
		var icoPause = fillIcon("M7 5h3.5v14H7zM13.5 5H17v14h-3.5z");
		var icoNext = fillIcon("M6.5 6l8 6-8 6zM16.5 6H18v12h-1.5z");
		var icoPrev = fillIcon("M17.5 6l-8 6 8 6zM6 6h1.5v12H6z");
		var icoPlus = strokeIcon(["M12 5v14", "M5 12h14"]);
		var icoX = strokeIcon(["M6 6l12 12", "M18 6L6 18"]);
		var icoRefresh = strokeIcon(["M20 8A9 9 0 1 0 20.9 13", "M20 3v5h-5"]);
		var icoSearch = function (size) {
			return h("svg", {
				viewBox: "0 0 24 24", width: size || 18, height: size || 18, fill: "none",
				stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": true,
			}, h("circle", { cx: 11, cy: 11, r: 6.5 }), h("path", { d: "M16 16l5 5" }));
		};
		var icoRepeat = strokeIcon(["M17 7H7v4", "M7 17h10v-4", "M14 4l3 3-3 3", "M10 20l-3-3 3-3"]);
		var icoShuffle = strokeIcon(["M3 7h4l10 10h4", "M18 14l3 3-3 3", "M3 17h4l2.5-2.5", "M13.5 9.5L17 7h4", "M18 4l3 3-3 3"]);
		function PanelIcon(props) {
			var size = (props && props.size) || 20;
			var color = props && props.active ? "var(--dsw-alias-brand-primary)" : "currentColor";
			return h("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", "aria-hidden": true },
				h("path", { d: "M9 18V6l10-2v12", stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }),
				h("circle", { cx: 6.5, cy: 18, r: 2.5, fill: color }),
				h("circle", { cx: 16.5, cy: 16, r: 2.5, fill: color }));
		}
		//#endregion

		//#region shared styles + formatting
		var CSS = [
			".dsg-page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px}",
			".dsg-head{display:flex;align-items:baseline;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
			".dsg-title{font-size:15px;font-weight:600}",
			".dsg-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsg-tabs{display:flex;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}",
			".dsg-tab{padding:6px 12px;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;border-bottom:2px solid transparent;border-radius:6px 6px 0 0}",
			".dsg-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".dsg-tab[data-on=\"1\"]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}",
			".dsg-content{flex:1;overflow:auto;padding:10px 12px;min-height:0}",
			".dsg-toolbar{display:flex;align-items:center;gap:6px;padding:2px 4px 10px;flex-wrap:wrap}",
			".dsg-spacer{flex:1}",
			".dsg-crumb{border:none;background:none;color:var(--dsw-alias-brand-primary);cursor:pointer;padding:2px 4px;font-size:12px;border-radius:4px}",
			".dsg-crumb:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsg-crumb[data-cur=\"1\"]{color:var(--dsw-alias-label-primary);font-weight:600;cursor:default}",
			".dsg-node{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 10px;border:none;border-radius:var(--dsw-radius-md);background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;box-sizing:border-box}",
			".dsg-node:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsg-node-detail{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsg-track{display:flex;align-items:center;gap:10px;padding:5px 8px;border-radius:var(--dsw-radius-md)}",
			".dsg-track:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsg-track[data-on=\"1\"]{background:var(--dsw-alias-interactive-bg-active)}",
			".dsg-cover{width:32px;height:32px;border-radius:6px;object-fit:cover;background:var(--dsw-alias-bg-layer-2);flex:none}",
			".dsg-cover-ph{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}",
			".dsg-t{overflow:hidden;min-width:0;flex:1}",
			".dsg-t1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsg-t2{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsg-dur{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;flex:none}",
			".dsg-ib{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;flex:none;position:relative}",
			".dsg-ib:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsg-ib[data-on=\"1\"]{color:var(--dsw-alias-brand-primary)}",
			".dsg-ib:disabled{opacity:.4;cursor:default}",
			".dsg-badge{position:absolute;top:2px;right:2px;font-size:8px;line-height:1;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-radius:4px;padding:1px 3px}",
			".dsg-bar{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none}",
			".dsg-range{-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);cursor:pointer;outline:none}",
			".dsg-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-brand-primary)}",
			".dsg-range::-moz-range-thumb{width:12px;height:12px;border:none;border-radius:50%;background:var(--dsw-alias-brand-primary)}",
			".dsg-time{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:11px;flex:none}",
			".dsg-input{padding:6px 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;box-sizing:border-box}",
			".dsg-input:focus{border-color:var(--dsw-alias-brand-primary)}",
			".dsg-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}",
			".dsg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsg-btn[data-primary=\"1\"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}",
			".dsg-btn:disabled{opacity:.5;cursor:default}",
			".dsg-empty{color:var(--dsw-alias-label-secondary);padding:32px 16px;text-align:center}",
			".dsg-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 4px}",
			".dsg-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}",
			".dsg-form{display:flex;flex-direction:column;gap:10px;max-width:420px;padding:16px}",
			".dsg-form-title{font-size:14px;font-weight:600;margin:0}",
			".dsg-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}",
			".dsg-field{display:flex;flex-direction:column;gap:4px}",
			".dsg-label{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsg-dock{display:flex;align-items:center;gap:8px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-primary)}",
			".dsg-dock-title{border:none;background:none;color:inherit;cursor:pointer;padding:2px 4px;border-radius:4px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;text-align:left}",
			".dsg-dock-title:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsg-progress{flex:1;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;min-width:48px}",
			".dsg-progress>i{display:block;height:100%;background:var(--dsw-alias-brand-primary)}",
			".dsg-cover-sm{width:22px;height:22px;border-radius:4px;object-fit:cover;background:var(--dsw-alias-bg-layer-2);flex:none}",
		].join("\n");
		function fmt(sec) {
			sec = Math.max(0, Math.floor(sec || 0));
			return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
		}
		function hostOf(baseUrl) {
			try { return new URL(baseUrl).host; } catch (_) { return baseUrl; }
		}
		//#endregion

		//#region track list + player bar
		function Cover(props) {
			var cfg = useStore(configStore);
			if (!props.coverId || !isConfigured(cfg)) {
				return h("span", { className: "dsg-cover dsg-cover-ph" }, icoPlay(14));
			}
			return h("img", {
				className: props.small ? "dsg-cover-sm" : "dsg-cover",
				src: coverUrl(cfg, props.coverId, props.small ? 40 : 64),
				loading: "lazy",
				alt: "",
			});
		}

		function TrackList(props) {
			var q = useStore(queueStore);
			var p = useStore(player);
			var cur = q.cursor >= 0 ? q.tracks[q.cursor] : null;
			if (!props.tracks.length) return h("div", { className: "dsg-empty" }, props.emptyText || t("list.empty"));
			return h("div", null,
				props.tracks.map(function (track, index) {
					var on = cur && cur.id === track.id;
					return h("div", { className: "dsg-track", key: track.id + ":" + index, "data-on": on ? "1" : undefined },
						h("button", {
							className: "dsg-ib",
							title: t("row.play"),
							onClick: function () { playTracks(props.tracks, index); },
						}, on && p.status === "playing" ? icoPause(14) : icoPlay(14)),
						h(Cover, { coverId: track.coverId }),
						h("div", { className: "dsg-t" },
							h("div", { className: "dsg-t1" }, track.title),
							h("div", { className: "dsg-t2" }, (track.artist || "—") + (track.album ? " · " + track.album : ""))),
						h("span", { className: "dsg-dur" }, fmt(track.duration)),
						h("button", {
							className: "dsg-ib",
							title: t("queue.add"),
							onClick: function () { queue.append(track); },
						}, icoPlus(14)));
				}));
		}

		function PlayerBar() {
			var q = useStore(queueStore);
			var p = useStore(player);
			var track = q.cursor >= 0 ? q.tracks[q.cursor] : null;
			if (!track) return h("div", { className: "dsg-bar" }, h("span", { className: "dsg-sub" }, t("player.empty")));
			var dur = Math.max(p.duration || 0, track.duration || 0);
			var playing = p.status === "playing";
			return h("div", { className: "dsg-bar" },
				h(Cover, { coverId: track.coverId }),
				h("div", { className: "dsg-t", style: { maxWidth: "220px" } },
					h("div", { className: "dsg-t1" }, track.title),
					h("div", { className: "dsg-t2" }, track.artist || "—")),
				h("button", { className: "dsg-ib", title: t("player.prev"), onClick: prevTrack }, icoPrev(16)),
				h("button", {
					className: "dsg-ib", title: playing ? t("player.pause") : t("player.play"), onClick: toggle,
					style: { width: "34px", height: "34px", color: "var(--dsw-alias-brand-primary)" },
				}, p.status === "loading" ? h("span", null, "…") : playing ? icoPause(18) : icoPlay(18)),
				h("button", { className: "dsg-ib", title: t("player.next"), onClick: function () { nextTrack(false); } }, icoNext(16)),
				h("span", { className: "dsg-time" }, fmt(p.position)),
				h("input", {
					className: "dsg-range", type: "range", min: 0, max: Math.max(1, Math.floor(dur)), step: 1,
					value: Math.min(Math.floor(p.position), Math.max(1, Math.floor(dur))),
					style: { flex: 1 },
					onChange: function (e) { seek(Number(e.target.value)); },
				}),
				h("span", { className: "dsg-time" }, fmt(dur)),
				h("button", {
					className: "dsg-ib", "data-on": q.repeat !== "off" ? "1" : undefined,
					title: t("player.repeat") + ": " + t("repeat." + q.repeat), onClick: queue.cycleRepeat,
				}, icoRepeat(15), q.repeat === "one" ? h("span", { className: "dsg-badge" }, "1") : null),
				h("button", {
					className: "dsg-ib", "data-on": q.shuffle ? "1" : undefined,
					title: t("player.shuffle"), onClick: queue.toggleShuffle,
				}, icoShuffle(15)),
				h("input", {
					className: "dsg-range", type: "range", min: 0, max: 100, step: 1, value: p.volume,
					title: t("player.volume"), style: { width: "72px" },
					onChange: function (e) { setVolume(Number(e.target.value)); },
				}),
				p.error ? h("span", { className: "dsg-err", style: { padding: 0 } }, p.error) : null);
		}
		//#endregion

		//#region tabs
		function useRemoteLoad(loader, deps) {
			var pair = React.useState({ loading: true, error: "", data: null });
			var state = pair[0], setState = pair[1];
			var seq = React.useRef(0);
			var reload = React.useCallback(function () {
				var my = ++seq.current;
				setState(function (s) { return { loading: true, error: "", data: s.data }; });
				loader().then(function (data) {
					if (seq.current === my) setState({ loading: false, error: "", data: data });
				}).catch(function (error) {
					if (seq.current === my) setState({ loading: false, error: String(error && error.message ? error.message : error), data: null });
				});
			}, deps);
			React.useEffect(function () { reload(); }, [reload]);
			return [state, reload];
		}

		function ErrorLine(props) {
			return h("div", { className: "dsg-err" },
				props.text + " ",
				h("button", { className: "dsg-crumb", onClick: props.onRetry }, t("retry")));
		}

		function BrowseTab() {
			var cfg = useStore(configStore);
			var stackPair = React.useState([{ path: "", label: t("browse.root") }]);
			var stack = stackPair[0], setStack = stackPair[1];
			var current = stack[stack.length - 1];
			var loaded = useRemoteLoad(function () { return browse(cfg, current.path); }, [cfg, current.path]);
			var state = loaded[0], reload = loaded[1];
			var data = state.data || { nodes: [], tracks: [] };
			return h("div", null,
				h("div", { className: "dsg-toolbar" },
					stack.map(function (entry, i) {
						var last = i === stack.length - 1;
						return h("span", { key: i, style: { display: "inline-flex", alignItems: "center" } },
							i > 0 ? h("span", { className: "dsg-sub" }, " / ") : null,
							h("button", {
								className: "dsg-crumb", "data-cur": last ? "1" : undefined,
								onClick: last ? undefined : function () { setStack(stack.slice(0, i + 1)); },
							}, entry.label));
					}),
					h("span", { className: "dsg-spacer" }),
					data.tracks.length > 0 ? h("button", {
						className: "dsg-btn", onClick: function () { playTracks(data.tracks, 0); },
					}, icoPlay(13), t("play.all")) : null,
					h("button", { className: "dsg-ib", title: t("refresh"), onClick: reload }, icoRefresh(14))),
				state.error ? h(ErrorLine, { text: state.error, onRetry: reload }) : null,
				state.loading && !state.data ? h("div", { className: "dsg-empty" }, t("loading")) : null,
				data.nodes.map(function (node) {
					return h("button", {
						className: "dsg-node", key: node.path,
						onClick: function () { setStack(stack.concat([{ path: node.path, label: node.label }])); },
					}, h("span", { className: "dsg-t1" }, node.label), node.detail ? h("span", { className: "dsg-node-detail" }, node.detail) : null, h("span", { className: "dsg-sub" }, "›"));
				}),
				data.tracks.length > 0 ? h(TrackList, { tracks: data.tracks, emptyText: t("list.empty") }) : null);
		}

		function SearchTab() {
			var cfg = useStore(configStore);
			var inputPair = React.useState("");
			var text = inputPair[0], setText = inputPair[1];
			var resultPair = React.useState(null); // null | { loading } | { tracks } | { error }
			var result = resultPair[0], setResult = resultPair[1];
			var seq = React.useRef(0);
			function run() {
				var query = text.trim();
				if (!query) return;
				var my = ++seq.current;
				setResult({ loading: true });
				api(cfg, "search3.view", { query: query, songCount: "50", artistCount: "0", albumCount: "0" }).then(function (body) {
					if (seq.current === my) setResult({ tracks: toTracks(body.searchResult3 && body.searchResult3.song) });
				}).catch(function (error) {
					if (seq.current === my) setResult({ error: String(error && error.message ? error.message : error) });
				});
			}
			return h("div", null,
				h("form", {
					className: "dsg-toolbar",
					onSubmit: function (e) { e.preventDefault(); run(); },
				},
					h("input", {
						className: "dsg-input", style: { flex: 1, minWidth: "180px" },
						placeholder: t("search.placeholder"), value: text,
						onChange: function (e) { setText(e.target.value); },
					}),
					h("button", { className: "dsg-btn", "data-primary": "1", type: "submit" }, icoSearch(13), t("search.go"))),
				!result ? h("div", { className: "dsg-empty" }, t("search.hint")) : null,
				result && result.loading ? h("div", { className: "dsg-empty" }, t("loading")) : null,
				result && result.error ? h(ErrorLine, { text: result.error, onRetry: run }) : null,
				result && result.tracks ? (result.tracks.length
					? h(TrackList, { tracks: result.tracks, emptyText: t("search.empty") })
					: h("div", { className: "dsg-empty" }, t("search.empty"))) : null);
		}

		function StarredTab() {
			var cfg = useStore(configStore);
			var loaded = useRemoteLoad(function () {
				return api(cfg, "getStarred2.view").then(function (body) {
					return toTracks(body.starred2 && body.starred2.song);
				});
			}, [cfg]);
			var state = loaded[0], reload = loaded[1];
			return h("div", null,
				h("div", { className: "dsg-toolbar" },
					h("span", { className: "dsg-sub" }, state.data ? state.data.length + " " + t("unit.song") : ""),
					h("span", { className: "dsg-spacer" }),
					state.data && state.data.length > 0 ? h("button", { className: "dsg-btn", onClick: function () { playTracks(state.data, 0); } }, icoPlay(13), t("play.all")) : null,
					h("button", { className: "dsg-ib", title: t("refresh"), onClick: reload }, icoRefresh(14))),
				state.error ? h(ErrorLine, { text: state.error, onRetry: reload }) : null,
				state.loading ? h("div", { className: "dsg-empty" }, t("loading")) : null,
				state.data ? h(TrackList, { tracks: state.data, emptyText: t("starred.empty") }) : null);
		}

		function PlaylistsTab() {
			var cfg = useStore(configStore);
			var detailPair = React.useState(null); // {id,name} | null
			var detail = detailPair[0], setDetail = detailPair[1];
			var listLoaded = useRemoteLoad(function () {
				return api(cfg, "getPlaylists.view").then(function (body) {
					return ((body.playlists && body.playlists.playlist) || []).map(function (pl) {
						return { id: String(pl.id), name: pl.name || String(pl.id), count: pl.songCount || 0 };
					});
				});
			}, [cfg]);
			var detailLoaded = useRemoteLoad(function () {
				if (!detail) return Promise.resolve(null);
				return api(cfg, "getPlaylist.view", { id: detail.id }).then(function (body) {
					return toTracks(body.playlist && body.playlist.entry);
				});
			}, [cfg, detail && detail.id]);
			if (detail) {
				var state = detailLoaded[0], reloadDetail = detailLoaded[1];
				return h("div", null,
					h("div", { className: "dsg-toolbar" },
						h("button", { className: "dsg-crumb", onClick: function () { setDetail(null); } }, "‹ " + t("back")),
						h("span", { className: "dsg-title", style: { fontSize: "13px" } }, detail.name),
						h("span", { className: "dsg-spacer" }),
						state.data && state.data.length > 0 ? h("button", { className: "dsg-btn", onClick: function () { playTracks(state.data, 0); } }, icoPlay(13), t("play.all")) : null,
						h("button", { className: "dsg-ib", title: t("refresh"), onClick: reloadDetail }, icoRefresh(14))),
					state.error ? h(ErrorLine, { text: state.error, onRetry: reloadDetail }) : null,
					state.loading ? h("div", { className: "dsg-empty" }, t("loading")) : null,
					state.data ? h(TrackList, { tracks: state.data, emptyText: t("list.empty") }) : null);
			}
			var state2 = listLoaded[0], reload2 = listLoaded[1];
			return h("div", null,
				h("div", { className: "dsg-toolbar" },
					h("span", { className: "dsg-sub" }, state2.data ? state2.data.length + " " + t("unit.list") : ""),
					h("span", { className: "dsg-spacer" }),
					h("button", { className: "dsg-ib", title: t("refresh"), onClick: reload2 }, icoRefresh(14))),
				state2.error ? h(ErrorLine, { text: state2.error, onRetry: reload2 }) : null,
				state2.loading ? h("div", { className: "dsg-empty" }, t("loading")) : null,
				state2.data && state2.data.length === 0 ? h("div", { className: "dsg-empty" }, t("playlists.empty")) : null,
				(state2.data || []).map(function (pl) {
					return h("button", { className: "dsg-node", key: pl.id, onClick: function () { setDetail(pl); } },
						h("span", { className: "dsg-t1" }, pl.name),
						h("span", { className: "dsg-node-detail" }, pl.count + " " + t("unit.song")),
						h("span", { className: "dsg-sub" }, "›"));
				}));
		}

		function QueueTab() {
			var q = useStore(queueStore);
			var p = useStore(player);
			return h("div", null,
				h("div", { className: "dsg-toolbar" },
					h("span", { className: "dsg-sub" }, q.tracks.length + " " + t("unit.song")),
					h("span", { className: "dsg-spacer" }),
					h("button", {
						className: "dsg-ib", "data-on": q.repeat !== "off" ? "1" : undefined,
						title: t("player.repeat") + ": " + t("repeat." + q.repeat), onClick: queue.cycleRepeat,
					}, icoRepeat(14), q.repeat === "one" ? h("span", { className: "dsg-badge" }, "1") : null),
					h("button", {
						className: "dsg-ib", "data-on": q.shuffle ? "1" : undefined,
						title: t("player.shuffle"), onClick: queue.toggleShuffle,
					}, icoShuffle(14)),
					h("button", { className: "dsg-btn", onClick: function () { queue.clear(); }, disabled: !q.tracks.length }, t("queue.clear"))),
				!q.tracks.length ? h("div", { className: "dsg-empty" }, t("queue.empty")) : null,
				q.tracks.map(function (track, index) {
					var on = index === q.cursor;
					return h("div", { className: "dsg-track", key: track.id + ":" + index, "data-on": on ? "1" : undefined },
						h("button", {
							className: "dsg-ib", title: t("row.play"),
							onClick: function () { playAt(index); },
						}, on && p.status === "playing" ? icoPause(14) : icoPlay(14)),
						h(Cover, { coverId: track.coverId }),
						h("div", { className: "dsg-t" },
							h("div", { className: "dsg-t1" }, track.title),
							h("div", { className: "dsg-t2" }, (track.artist || "—") + (track.album ? " · " + track.album : ""))),
						h("span", { className: "dsg-dur" }, fmt(track.duration)),
						h("button", { className: "dsg-ib", title: t("queue.remove"), onClick: function () { queue.remove(index); } }, icoX(13)));
				}));
		}
		//#endregion

		//#region settings form (settings.section + in-page gate)
		function SettingsForm(props) {
			var cfg = useStore(configStore);
			var urlPair = React.useState(cfg.baseUrl || "");
			var baseUrl = urlPair[0], setBaseUrl = urlPair[1];
			var userPair = React.useState(cfg.username || "");
			var username = userPair[0], setUsername = userPair[1];
			var passPair = React.useState(cfg.password || "");
			var password = passPair[0], setPassword = passPair[1];
			var statePair = React.useState({ busy: false, ok: "", error: "" });
			var state = statePair[0], setState = statePair[1];
			function save() {
				var next = { baseUrl: baseUrl.trim(), username: username.trim(), password: password };
				setState({ busy: true, ok: "", error: "" });
				fetch("/api/dsh-gonic/config", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(next),
				}).then(function (res) { return res.json(); }).then(function (view) {
					if (!view || !view.ok) throw new Error(view && view.message || "save failed");
					configStore.replace({ baseUrl: view.baseUrl, username: view.username, password: view.password, loaded: true });
					if (!view.configured) {
						setState({ busy: false, ok: "", error: t("form.incomplete") });
						return null;
					}
					return fetch("/api/dsh-gonic/test", { method: "POST" }).then(function (res) { return res.json(); }).then(function (result) {
						if (result && result.ok) {
							setState({ busy: false, ok: t("form.saved"), error: "" });
							if (props && props.onSaved) props.onSaved();
						} else {
							setState({ busy: false, ok: "", error: t("form.failed") + ": " + (result && result.message || "") });
						}
					});
				}).catch(function (error) {
					setState({ busy: false, ok: "", error: String(error && error.message ? error.message : error) });
				});
			}
			return h("div", { className: "dsg-form" },
				h("p", { className: "dsg-form-title" }, t("settings")),
				h("div", { className: "dsg-note" }, t("form.note")),
				h("div", { className: "dsg-field" },
					h("label", { className: "dsg-label" }, t("form.baseUrl")),
					h("input", {
						className: "dsg-input", placeholder: "http://192.168.1.10:4747",
						value: baseUrl, onChange: function (e) { setBaseUrl(e.target.value); },
					})),
				h("div", { className: "dsg-field" },
					h("label", { className: "dsg-label" }, t("form.username")),
					h("input", { className: "dsg-input", value: username, onChange: function (e) { setUsername(e.target.value); } })),
				h("div", { className: "dsg-field" },
					h("label", { className: "dsg-label" }, t("form.password")),
					h("input", {
						className: "dsg-input", type: "password", value: password,
						onChange: function (e) { setPassword(e.target.value); },
					})),
				h("div", null,
					h("button", { className: "dsg-btn", "data-primary": "1", onClick: save, disabled: state.busy },
						state.busy ? t("loading") : t("form.save")),
					props && props.after ? props.after : null),
				state.ok ? h("div", { className: "dsg-ok" }, state.ok) : null,
				state.error ? h("div", { className: "dsg-err" }, state.error) : null);
		}
		//#endregion

		//#region slot components
		var TABS = ["browse", "search", "starred", "playlists", "queue"];

		function MainPage() {
			var cfg = useStore(configStore);
			var tabPair = React.useState("browse");
			var tab = tabPair[0], setTab = tabPair[1];
			var head = h("div", { className: "dsg-head", key: "head" },
				h("span", { className: "dsg-title" }, t("page.title")),
				h("span", { className: "dsg-sub" }, isConfigured(cfg) ? hostOf(cfg.baseUrl) : t("form.need")));
			if (!cfg.loaded) {
				return h("div", { className: "dsg-page" }, h("style", null, CSS), head,
					h("div", { className: "dsg-empty", key: "content" }, t("loading")));
			}
			if (!isConfigured(cfg)) {
				return h("div", { className: "dsg-page" }, h("style", null, CSS), head,
					h("div", { className: "dsg-content", key: "content" }, h(SettingsForm, null)));
			}
			var content = null;
			if (tab === "browse") content = h(BrowseTab, null);
			else if (tab === "search") content = h(SearchTab, null);
			else if (tab === "starred") content = h(StarredTab, null);
			else if (tab === "playlists") content = h(PlaylistsTab, null);
			else content = h(QueueTab, null);
			return h("div", { className: "dsg-page" },
				h("style", null, CSS),
				head,
				h("div", { className: "dsg-tabs", key: "tabs" },
					TABS.map(function (id) {
						return h("button", {
							key: id, className: "dsg-tab", "data-on": tab === id ? "1" : undefined,
							onClick: function () { setTab(id); },
						}, t("tab." + id));
					})),
				h("div", { className: "dsg-content", key: "content" }, content),
				h(PlayerBar, { key: "bar" }));
		}

		function DockBar() {
			var q = useStore(queueStore);
			var p = useStore(player);
			var cfg = useStore(configStore);
			var track = q.cursor >= 0 ? q.tracks[q.cursor] : null;
			if (!track || !isConfigured(cfg)) return null;
			var dur = Math.max(p.duration || 0, track.duration || 0);
			var frac = dur > 0 ? Math.min(1, (p.position || 0) / dur) : 0;
			return h("div", { className: "dsg-dock" },
				h("style", null, CSS),
				h(Cover, { coverId: track.coverId, small: true }),
				h("button", {
					className: "dsg-dock-title", title: track.title,
					onClick: function () { if (layoutRef) layoutRef.selectPanel("dsh-gonic"); },
				}, track.title + " · " + (track.artist || "—")),
				h("button", { className: "dsg-ib", style: { width: "22px", height: "22px" }, title: t("player.prev"), onClick: prevTrack }, icoPrev(12)),
				h("button", {
					className: "dsg-ib", style: { width: "22px", height: "22px" },
					title: p.status === "playing" ? t("player.pause") : t("player.play"), onClick: toggle,
				}, p.status === "playing" ? icoPause(12) : icoPlay(12)),
				h("button", { className: "dsg-ib", style: { width: "22px", height: "22px" }, title: t("player.next"), onClick: function () { nextTrack(false); } }, icoNext(12)),
				h("div", { className: "dsg-progress" }, h("i", { style: { width: (frac * 100).toFixed(1) + "%" } })));
		}

		function SettingsSection(props) {
			var cfg = useStore(configStore);
			if (!cfg.loaded) return h("div", null, h("style", null, CSS), h("div", { className: "dsg-empty" }, t("loading")));
			return h("div", null, h("style", null, CSS), h(SettingsForm, {
				after: h("button", {
					className: "dsg-btn", style: { marginLeft: "8px" },
					onClick: function () {
						if (props && props.close) props.close();
						if (layoutRef) layoutRef.selectPanel("dsh-gonic");
					},
				}, t("openPlayer")),
			}));
		}
		//#endregion

		//#region locale dicts
		var DICT_EN = {
			"nav": "Music",
			"settings": "Gonic Player",
			"page.title": "Gonic Music",
			"tab.browse": "Browse",
			"tab.search": "Search",
			"tab.starred": "Starred",
			"tab.playlists": "Playlists",
			"tab.queue": "Queue",
			"browse.root": "Library",
			"browse.artists": "Artists",
			"browse.albums": "Albums",
			"browse.genres": "Genres",
			"browse.recent": "Recently added",
			"browse.random": "Random",
			"unit.song": "songs",
			"unit.album": "albums",
			"unit.list": "playlists",
			"play.all": "Play all",
			"row.play": "Play",
			"queue.add": "Add to queue",
			"queue.clear": "Clear",
			"queue.remove": "Remove",
			"queue.empty": "Queue is empty — add tracks from Browse or Search.",
			"list.empty": "Nothing here.",
			"search.placeholder": "Search titles, artists…",
			"search.go": "Search",
			"search.hint": "Type a keyword and press Enter.",
			"search.empty": "No results.",
			"starred.empty": "No starred songs yet — star them in any Subsonic client.",
			"playlists.empty": "No playlists on the server.",
			"player.empty": "Nothing playing — pick a track to start.",
			"player.play": "Play",
			"player.pause": "Pause",
			"player.prev": "Previous",
			"player.next": "Next",
			"player.repeat": "Repeat",
			"player.shuffle": "Shuffle",
			"player.volume": "Volume",
			"player.error": "Playback failed",
			"repeat.off": "off",
			"repeat.all": "all",
			"repeat.one": "one",
			"loading": "Loading…",
			"retry": "Retry",
			"refresh": "Refresh",
			"back": "Back",
			"openPlayer": "Open player",
			"err.network": "Network request failed",
			"form.baseUrl": "Server URL",
			"form.username": "Username",
			"form.password": "Password",
			"form.save": "Save & test",
			"form.saved": "Saved — server answered ping.",
			"form.failed": "Connection failed",
			"form.incomplete": "Saved, but URL, username and password are all required.",
			"form.need": "Set up your Gonic server to start.",
			"form.note": "Read-only player + agent tools. Credentials live on the Host at ~/.dsh/dsh-gonic.json (mode 0600); this browser holds them in memory only.",
		};
		var DICT_ZH = {
			"nav": "音乐",
			"settings": "Gonic 播放器",
			"page.title": "Gonic 音乐",
			"tab.browse": "浏览",
			"tab.search": "搜索",
			"tab.starred": "收藏",
			"tab.playlists": "歌单",
			"tab.queue": "队列",
			"browse.root": "曲库",
			"browse.artists": "艺人",
			"browse.albums": "专辑",
			"browse.genres": "风格",
			"browse.recent": "最近添加",
			"browse.random": "随机",
			"unit.song": "首",
			"unit.album": "张",
			"unit.list": "个",
			"play.all": "播放全部",
			"row.play": "播放",
			"queue.add": "加入队列",
			"queue.clear": "清空",
			"queue.remove": "移除",
			"queue.empty": "队列为空——去浏览或搜索里加点歌。",
			"list.empty": "这里什么都没有。",
			"search.placeholder": "搜索歌曲、艺人…",
			"search.go": "搜索",
			"search.hint": "输入关键词后回车。",
			"search.empty": "没有找到结果。",
			"starred.empty": "还没有收藏歌曲——可以在任意 Subsonic 客户端里加星。",
			"playlists.empty": "服务器上还没有歌单。",
			"player.empty": "还没有在播的歌——去挑一首。",
			"player.play": "播放",
			"player.pause": "暂停",
			"player.prev": "上一首",
			"player.next": "下一首",
			"player.repeat": "循环",
			"player.shuffle": "随机",
			"player.volume": "音量",
			"player.error": "播放失败",
			"repeat.off": "关",
			"repeat.all": "全部",
			"repeat.one": "单曲",
			"loading": "加载中…",
			"retry": "重试",
			"refresh": "刷新",
			"back": "返回",
			"openPlayer": "打开播放器",
			"err.network": "网络请求失败",
			"form.baseUrl": "服务器地址",
			"form.username": "用户名",
			"form.password": "密码",
			"form.save": "保存并测试",
			"form.saved": "已保存——服务器 ping 通。",
			"form.failed": "连接失败",
			"form.incomplete": "已保存，但地址、用户名、密码都需要填写。",
			"form.need": "先配置你的 Gonic 服务器。",
			"form.note": "凭据保存在本机 ~/.dsh/dsh-gonic.json（权限 0600），浏览器只在内存中持有；agent 工具与本播放器共用这份配置。",
		};
		//#endregion

		// Module-level seats filled by apply: translate + layout navigation.
		var t = function (key) { return key; };
		var layoutRef = null;

		/**
		 * Register locales, the player lifecycle effect, and every slot.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.locale.register("dsh-gonic", "en", DICT_EN);
			ctx.locale.register("dsh-gonic", "zh", DICT_ZH);
			ctx.locale.register("dsh-gonic", "zh-CN", DICT_ZH);
			t = ctx.locale.bind("dsh-gonic");
			layoutRef = ctx.layout || null;
			loadConfig();

			// Player lifecycle: heartbeat persistence; release the element on unload.
			ctx.effect(function () {
				var iv = setInterval(function () {
					if (player.get().status === "playing") persistPlayback();
				}, 5000);
				return function () {
					clearInterval(iv);
					persistPlayback();
					audio.pause();
					audio.removeAttribute("src");
					try { audio.load(); } catch (_) { /* element already gone */ }
				};
			}, "dsh-gonic: player");

			var registrations = [
				function () {
					ctx.slots.inject("main", function () {
						return ctx.slots.register({ name: "main", key: "dsh-gonic" }, MainPage);
					});
				},
				function () {
					ctx.slots.inject("sidebar.panellist", function () {
						return ctx.slots.register({ name: "sidebar.panellist", id: "dsh-gonic", order: 30, label: function () { return t("nav"); } }, PanelIcon);
					});
				},
				function () {
					ctx.slots.inject("settings.section", function () {
						return ctx.slots.register({ name: "settings.section", id: "dsh-gonic", order: 302, label: function () { return t("settings"); } }, SettingsSection);
					});
				},
				function () {
					ctx.slots.inject("conversation.composer.dock", function () {
						return ctx.slots.register({ name: "conversation.composer.dock", id: "dsh-gonic", order: 5 }, DockBar);
					});
				},
			];
			registrations.forEach(function (register) {
				try {
					register();
				} catch (error) {
					console.warn("[dsh-gonic] slot registration failed:", error);
				}
			});
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale", "layout"];
		return module.exports;
	},
});
