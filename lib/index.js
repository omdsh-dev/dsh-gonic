/**
 * dsh-gonic — Gonic/Subsonic player integration for DeepSeek Harness. Host half.
 *
 * Owns the server credentials (~/.dsh/dsh-gonic.json, mode 0600), mounts the
 * agent tools (gonic_status / gonic_search / gonic_browse / gonic_starred /
 * gonic_playlists / gonic_playlist / gonic_create_playlist), serves the
 * /api/dsh-gonic routes the settings panel talks to, and announces the
 * capability to the agent through a system-prompt section.
 *
 * The Gonic server itself is never modified: this plugin is a plain Subsonic
 * API client. Playback stays in the browser (Client half); the queue lives in
 * the browser too, so tools operate on the server catalogue only — they
 * cannot control what is currently playing.
 *
 * Pure ESM, no runtime dependencies beyond @deepseek-ai/dsh-tools (provided
 * by the Host). No build step.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Stable cordis plugin name. */
const name = "gonic";
/** Services required before the gonic surfaces can mount. */
const inject = ["tools", "systemPrompt", "webServer"];
/** Config file location (machine-wide, mode 0600). */
const CONFIG_FILE = path.join(homedir(), ".dsh", "dsh-gonic.json");
/** Request timeout for a Subsonic API call. */
const REQUEST_TIMEOUT_MS = 15e3;
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 152;
/** Route family the Client half talks to. */
const GONIC_API = {
	config: "/api/dsh-gonic/config",
	test: "/api/dsh-gonic/test"
};
/** Cap on JSON request bodies to the config route. */
const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GONIC_GUIDANCE = "本机已安装 dsh-gonic 插件（Gonic/Subsonic 音乐库集成）：配置好服务器后，可用 gonic_search 按关键词搜歌，gonic_browse 浏览曲库（空路径给出根菜单：艺人/专辑/风格/最近添加/随机；用 artist:<id>、album:<id>、genre:<名> 逐层下钻），gonic_starred 查看已加星的歌曲，gonic_playlists / gonic_playlist 查看歌单列表与详情，gonic_create_playlist 用曲目 id 列表创建新歌单（先用 gonic_search 凑齐 id）。gonic_status 查看连接与配置状态；也可以在 Web 设置页「Gonic 播放器」面板中配置。用户提到「我的曲库 / 音乐 / 歌单」并想查找或整理时即指本插件。注意：播放队列在用户的浏览器里，本插件的工具只操作服务器上的曲库与歌单，无法控制当前正在播放的内容；写操作仅限创建歌单（不提供修改、删除、加星）。";

/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{ type: "text", text: value }];
}

/** Normalize a server base URL: trim, default to http, drop trailing slashes. */
function normalizeBaseUrl(value) {
	let url = String(value || "").trim();
	if (!url) return "";
	if (!/^https?:\/\//i.test(url)) url = "http://" + url;
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("服务器地址不是合法 URL: " + url);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("服务器地址仅支持 http/https: " + url);
	}
	if (!parsed.hostname) throw new Error("服务器地址缺少主机名: " + url);
	return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
}

/** Clamp an integer list-size argument. */
function clampLimit(value, fallback, max) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), max);
}

/** Format seconds as m:ss. */
function fmt(sec) {
	sec = Math.max(0, Math.floor(Number(sec) || 0));
	return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}

//#region config store — ~/.dsh/dsh-gonic.json, mode 0600
class GonicStore {
	constructor(file = CONFIG_FILE) {
		this.file = file;
		this.cache = void 0;
	}
	async load() {
		try {
			const raw = await readFile(this.file, "utf8");
			const parsed = JSON.parse(raw);
			this.cache = {
				baseUrl: typeof parsed?.baseUrl === "string" ? parsed.baseUrl : "",
				username: typeof parsed?.username === "string" ? parsed.username : "",
				password: typeof parsed?.password === "string" ? parsed.password : ""
			};
		} catch {
			this.cache = { baseUrl: "", username: "", password: "" };
		}
		return this.cache;
	}
	async get() {
		return this.cache ?? this.load();
	}
	async save(input) {
		const next = {
			baseUrl: normalizeBaseUrl(input?.baseUrl),
			username: String(input?.username ?? "").trim(),
			password: typeof input?.password === "string" ? input.password : ""
		};
		await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		await writeFile(this.file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
		this.cache = next;
		return next;
	}
}
function configured(cfg) {
	return Boolean(cfg && cfg.baseUrl && cfg.username && cfg.password);
}
/** Full view incl. password: the browser client signs its own direct API/stream calls. */
function viewOf(cfg) {
	return {
		configured: configured(cfg),
		baseUrl: cfg.baseUrl || "",
		username: cfg.username || "",
		password: cfg.password || ""
	};
}
//#endregion

//#region subsonic client (Host side)
function endpoint(cfg, view, params) {
	const salt = randomBytes(8).toString("hex");
	const q = new URLSearchParams();
	q.set("u", cfg.username);
	q.set("s", salt);
	q.set("t", createHash("md5").update(cfg.password + salt).digest("hex"));
	q.set("v", "1.15.0");
	q.set("c", "dsh-gonic");
	q.set("f", "json");
	for (const [key, value] of Object.entries(params ?? {})) {
		if (Array.isArray(value)) for (const item of value) q.append(key, String(item));
		else q.set(key, String(value));
	}
	return cfg.baseUrl.replace(/\/+$/, "") + "/rest/" + view + "?" + q.toString();
}
async function api(cfg, view, params) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(endpoint(cfg, view, params), { signal: controller.signal });
	} catch (error) {
		throw new Error("网络请求失败: " + (error instanceof Error && error.name === "AbortError" ? "请求超时" : String(error instanceof Error ? error.message : error)));
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) throw new Error("HTTP " + res.status);
	const body = (await res.json())?.["subsonic-response"];
	if (!body || body.status !== "ok") {
		throw new Error(body?.error?.message ? `服务器拒绝: ${body.error.message}` : "subsonic: bad response");
	}
	return body;
}
function toTrack(song) {
	return {
		id: String(song?.id ?? ""),
		title: song?.title || "?",
		artist: song?.artist || "",
		album: song?.album || "",
		duration: Math.max(0, Math.floor(song?.duration || 0))
	};
}
const toTracks = (list) => (Array.isArray(list) ? list : []).filter((s) => s && s.id != null).map(toTrack);
function albumNodes(albums) {
	return (Array.isArray(albums) ? albums : []).filter((al) => al && al.id).map((al) => {
		const label0 = (al.name || al.title || "").trim() || String(al.id);
		return {
			path: "album:" + al.id,
			label: (al.artist || "").trim() ? label0 + " · " + al.artist.trim() : label0,
			detail: al.songCount ? al.songCount + " 首" : ""
		};
	});
}
/** Same walk as the browser client's browse(): root menu, then <kind>:<id>. */
async function browse(cfg, path0) {
	if (!path0) {
		return {
			nodes: [
				{ path: "artists", label: "艺人" },
				{ path: "albums", label: "专辑" },
				{ path: "genres", label: "风格" },
				{ path: "recent", label: "最近添加" },
				{ path: "random", label: "随机" }
			],
			tracks: []
		};
	}
	const sep = path0.indexOf(":");
	const kind = sep === -1 ? path0 : path0.slice(0, sep);
	const id = sep === -1 ? "" : path0.slice(sep + 1);
	switch (kind) {
		case "artists": {
			const body = await api(cfg, "getArtists.view");
			const artists = (body.artists?.index ?? []).flatMap((entry) => entry.artist ?? []);
			return {
				nodes: artists.filter((a) => a && a.id).map((a) => ({
					path: "artist:" + a.id,
					label: (a.name || "").trim() || String(a.id),
					detail: a.albumCount ? a.albumCount + " 张" : ""
				})),
				tracks: []
			};
		}
		case "artist": {
			const body = await api(cfg, "getArtist.view", { id });
			return { nodes: albumNodes(body.artist?.album), tracks: [] };
		}
		case "album": {
			const body = await api(cfg, "getAlbum.view", { id });
			return { nodes: [], tracks: toTracks(body.album?.song) };
		}
		case "albums": {
			const body = await api(cfg, "getAlbumList2.view", { type: "alphabeticalByName", size: "500" });
			return { nodes: albumNodes(body.albumList2?.album), tracks: [] };
		}
		case "recent": {
			const body = await api(cfg, "getAlbumList2.view", { type: "newest", size: "50" });
			return { nodes: albumNodes(body.albumList2?.album), tracks: [] };
		}
		case "genres": {
			const body = await api(cfg, "getGenres.view");
			const genres = (body.genres?.genre ?? [])
				.filter((g) => g && (g.value || "").trim() !== "")
				.sort((a, b) => (b.songCount || 0) - (a.songCount || 0));
			return {
				nodes: genres.map((g) => ({ path: "genre:" + g.value, label: g.value, detail: g.songCount ? g.songCount + " 首" : "" })),
				tracks: []
			};
		}
		case "genre": {
			const body = await api(cfg, "getSongsByGenre.view", { genre: id, count: "500" });
			return { nodes: [], tracks: toTracks(body.songsByGenre?.song) };
		}
		case "random": {
			const body = await api(cfg, "getRandomSongs.view", { size: "50" });
			return { nodes: [], tracks: toTracks(body.randomSongs?.song) };
		}
		default:
			throw new Error('未知浏览路径 "' + path0 + '"（可用：artists / albums / genres / recent / random / artist:<id> / album:<id> / genre:<名>）');
	}
}
//#endregion

//#region render helpers
function renderTrackList(title, tracks, withIds) {
	if (!tracks.length) return title + "：无曲目";
	const lines = tracks.map((track, i) => {
		const base = `${i + 1}. ${track.title} — ${track.artist || "—"}${track.album ? " · " + track.album : ""} (${fmt(track.duration)})`;
		return withIds ? base + ` [id: ${track.id}]` : base;
	});
	return title + "（共 " + tracks.length + " 首）\n" + lines.join("\n");
}
function renderNodes(nodes) {
	return nodes.map((n) => `- ${n.label}${n.detail ? "（" + n.detail + "）" : ""} → ${n.path}`).join("\n");
}
//#endregion

//#region tools
function gonicStatusTool(store) {
	return defineTool({
		name: "gonic_status",
		description: "查看 dsh-gonic（Gonic/Subsonic 音乐库）插件的连接与配置状态：是否已配置、服务器地址、用户名，以及服务器是否可达（ping）。不会回显密码。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					configured: { type: "boolean" },
					baseUrl: { type: "string" },
					username: { type: "string" }
				}
			},
			render: (_args, value) => text((value.ok ? "[ok] " : "[failed] ") + value.message)
		},
		async execute() {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, configured: false, message: "尚未配置：请在 Web 设置页「Gonic 播放器」填写服务器地址、用户名、密码。" };
			try {
				await api(cfg, "ping.view");
				return { ok: true, configured: true, baseUrl: cfg.baseUrl, username: cfg.username, message: `已配置且连通：${cfg.baseUrl}（用户 ${cfg.username}）` };
			} catch (error) {
				return { ok: false, configured: true, baseUrl: cfg.baseUrl, username: cfg.username, message: "已配置但连接失败: " + String(error instanceof Error ? error.message : error) };
			}
		}
	});
}

function gonicSearchTool(store) {
	return defineTool({
		name: "gonic_search",
		description: "在用户的 Gonic/Subsonic 音乐库里按关键词搜索歌曲。返回曲目列表（标题、艺人、专辑、时长、id）；创建歌单需要曲目 id 时先调本工具凑齐。",
		parameters: {
			query: { type: "string", required: true, description: "搜索关键词（匹配标题/艺人/专辑）" },
			limit: { type: "number", description: "返回条数，默认 20，最大 50" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					count: { type: "number" },
					tracks: { type: "array" }
				}
			},
			render: (args, value) => {
				if (!value.ok) return text("[failed] " + value.message);
				return text(renderTrackList(`搜索 ${JSON.stringify(args.query ?? "")}`, Array.isArray(value.tracks) ? value.tracks : [], true));
			}
		},
		async execute(args) {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, message: "尚未配置 Gonic 服务器" };
			const query = typeof args.query === "string" ? args.query.trim() : "";
			if (!query) return { ok: false, message: "query 不能为空" };
			try {
				const body = await api(cfg, "search3.view", { query, songCount: String(clampLimit(args.limit, 20, 50)), artistCount: "0", albumCount: "0" });
				const tracks = toTracks(body.searchResult3?.song);
				return { ok: true, message: "找到 " + tracks.length + " 首", count: tracks.length, tracks };
			} catch (error) {
				return { ok: false, message: String(error instanceof Error ? error.message : error) };
			}
		}
	});
}

function gonicBrowseTool(store) {
	return defineTool({
		name: "gonic_browse",
		description: "浏览用户的 Gonic/Subsonic 曲库。空路径返回根菜单（artists 艺人 / albums 专辑 / genres 风格 / recent 最近添加 / random 随机）；随后用返回的 path 逐层下钻：artist:<id> 列出该艺人专辑，album:<id> 列出专辑曲目，genre:<名称> 列出该风格歌曲。",
		parameters: {
			path: { type: "string", description: "浏览路径：留空为根菜单；或 artists / albums / genres / recent / random / artist:<id> / album:<id> / genre:<名称>" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					path: { type: "string" },
					nodes: { type: "array" },
					tracks: { type: "array" }
				}
			},
			render: (args, value) => {
				if (!value.ok) return text("[failed] " + value.message);
				const title = "浏览 " + (typeof args.path === "string" && args.path ? args.path : "根菜单");
				const parts = [];
				if (Array.isArray(value.nodes) && value.nodes.length) parts.push(renderNodes(value.nodes));
				if (Array.isArray(value.tracks) && value.tracks.length) parts.push(renderTrackList(title, value.tracks, true));
				return text(parts.length ? title + "\n" + parts.join("\n") : title + "：空");
			}
		},
		async execute(args) {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, message: "尚未配置 Gonic 服务器" };
			const path0 = typeof args.path === "string" ? args.path.trim() : "";
			try {
				const result = await browse(cfg, path0);
				return { ok: true, message: `节点 ${result.nodes.length} 个，曲目 ${result.tracks.length} 首`, path: path0, nodes: result.nodes, tracks: result.tracks };
			} catch (error) {
				return { ok: false, message: String(error instanceof Error ? error.message : error) };
			}
		}
	});
}

function gonicStarredTool(store) {
	return defineTool({
		name: "gonic_starred",
		description: "列出用户在 Gonic/Subsonic 音乐库里加星的歌曲。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					count: { type: "number" },
					tracks: { type: "array" }
				}
			},
			render: (_args, value) => {
				if (!value.ok) return text("[failed] " + value.message);
				return text(renderTrackList("已加星的歌曲", Array.isArray(value.tracks) ? value.tracks : [], true));
			}
		},
		async execute() {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, message: "尚未配置 Gonic 服务器" };
			try {
				const body = await api(cfg, "getStarred2.view");
				const tracks = toTracks(body.starred2?.song);
				return { ok: true, message: "共 " + tracks.length + " 首", count: tracks.length, tracks };
			} catch (error) {
				return { ok: false, message: String(error instanceof Error ? error.message : error) };
			}
		}
	});
}

function gonicPlaylistsTool(store) {
	return defineTool({
		name: "gonic_playlists",
		description: "列出用户 Gonic/Subsonic 服务器上的全部歌单（名称、曲目数、id）；查看某个歌单内容用 gonic_playlist。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					count: { type: "number" },
					playlists: { type: "array" }
				}
			},
			render: (_args, value) => {
				if (!value.ok) return text("[failed] " + value.message);
				const playlists = Array.isArray(value.playlists) ? value.playlists : [];
				if (!playlists.length) return text("服务器上没有歌单");
				return text("歌单（共 " + playlists.length + " 个）\n" + playlists.map((p) => `- ${p.name}（${p.songCount} 首）[id: ${p.id}]`).join("\n"));
			}
		},
		async execute() {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, message: "尚未配置 Gonic 服务器" };
			try {
				const body = await api(cfg, "getPlaylists.view");
				const playlists = (body.playlists?.playlist ?? []).map((p) => ({
					id: String(p?.id ?? ""),
					name: p?.name || String(p?.id ?? ""),
					songCount: p?.songCount || 0
				}));
				return { ok: true, message: "共 " + playlists.length + " 个", count: playlists.length, playlists };
			} catch (error) {
				return { ok: false, message: String(error instanceof Error ? error.message : error) };
			}
		}
	});
}

function gonicPlaylistTool(store) {
	return defineTool({
		name: "gonic_playlist",
		description: "查看一个 Gonic/Subsonic 歌单的完整曲目列表。id 从 gonic_playlists 获取。",
		parameters: {
			id: { type: "string", required: true, description: "歌单 id" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					name: { type: "string" },
					count: { type: "number" },
					tracks: { type: "array" }
				}
			},
			render: (_args, value) => {
				if (!value.ok) return text("[failed] " + value.message);
				return text(renderTrackList("歌单 " + (value.name || ""), Array.isArray(value.tracks) ? value.tracks : [], true));
			}
		},
		async execute(args) {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, message: "尚未配置 Gonic 服务器" };
			const id = typeof args.id === "string" ? args.id.trim() : "";
			if (!id) return { ok: false, message: "id 不能为空" };
			try {
				const body = await api(cfg, "getPlaylist.view", { id });
				const tracks = toTracks(body.playlist?.entry);
				return { ok: true, message: "共 " + tracks.length + " 首", name: body.playlist?.name || id, count: tracks.length, tracks };
			} catch (error) {
				return { ok: false, message: String(error instanceof Error ? error.message : error) };
			}
		}
	});
}

function gonicCreatePlaylistTool(store) {
	return defineTool({
		name: "gonic_create_playlist",
		description: "在用户的 Gonic/Subsonic 服务器上创建新歌单（写操作）。name 为歌单名；trackIds 为曲目 id 列表（先用 gonic_search / gonic_browse / gonic_playlist 等拿到 id），可省略创建空歌单。创建结果立即可在用户的播放器「歌单」页看到。",
		parameters: {
			name: { type: "string", required: true, description: "新歌单的名称" },
			trackIds: { type: "array", items: { type: "string" }, description: "可选：初始曲目 id 列表，按给定顺序加入" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					playlistId: { type: "string" },
					name: { type: "string" },
					songCount: { type: "number" }
				}
			},
			render: (_args, value) => text((value.ok ? "[ok] " : "[failed] ") + value.message)
		},
		async execute(args) {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, message: "尚未配置 Gonic 服务器" };
			const name0 = typeof args.name === "string" ? args.name.trim() : "";
			if (!name0) return { ok: false, message: "歌单名不能为空" };
			const trackIds = Array.isArray(args.trackIds) ? args.trackIds.map((v) => String(v)).filter(Boolean) : [];
			try {
				const body = await api(cfg, "createPlaylist.view", trackIds.length ? { name: name0, songId: trackIds } : { name: name0 });
				const playlist = body.playlist;
				return {
					ok: true,
					message: `已创建歌单「${playlist?.name || name0}」（${playlist?.songCount ?? trackIds.length} 首）`,
					playlistId: String(playlist?.id ?? ""),
					name: playlist?.name || name0,
					songCount: playlist?.songCount ?? trackIds.length
				};
			} catch (error) {
				return { ok: false, message: String(error instanceof Error ? error.message : error) };
			}
		}
	});
}
//#endregion

//#region http routes for the settings panel
function writeJson(res, status, value) {
	const payload = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > MAX_JSON_BODY_BYTES) {
				req.destroy();
				reject(new Error("request body too large"));
			}
		});
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", () => reject(new Error("request body could not be read")));
	});
}
function makeRoutes(store) {
	return [
		{
			kind: "exact",
			path: GONIC_API.config,
			handler: async (req, res) => {
				try {
					if (req.method === "GET") {
						writeJson(res, 200, { ok: true, ...viewOf(await store.get()) });
						return;
					}
					if (req.method === "POST") {
						const body = await readJsonBody(req);
						const saved = await store.save(body);
						writeJson(res, 200, { ok: true, ...viewOf(saved) });
						return;
					}
					res.writeHead(405, { allow: "GET, POST" });
					res.end();
				} catch (error) {
					writeJson(res, 200, { ok: false, message: String(error instanceof Error ? error.message : error) });
				}
			}
		},
		{
			kind: "exact",
			path: GONIC_API.test,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					res.writeHead(405, { allow: "POST" });
					res.end();
					return;
				}
				try {
					const cfg = await store.get();
					if (!configured(cfg)) {
						writeJson(res, 200, { ok: false, message: "尚未配置：服务器地址、用户名、密码都需要。" });
						return;
					}
					await api(cfg, "ping.view");
					writeJson(res, 200, { ok: true, message: `连接成功：${cfg.baseUrl}（用户 ${cfg.username}）` });
				} catch (error) {
					writeJson(res, 200, { ok: false, message: String(error instanceof Error ? error.message : error) });
				}
			}
		}
	];
}
//#endregion

/**
 * Mount the gonic tools, routes, and announcement.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	if (!enabled) return;
	const store = new GonicStore();
	const tools = [
		gonicStatusTool(store),
		gonicSearchTool(store),
		gonicBrowseTool(store),
		gonicStarredTool(store),
		gonicPlaylistsTool(store),
		gonicPlaylistTool(store),
		gonicCreatePlaylistTool(store)
	];
	ctx.effect(() => {
		const disposers = tools.map((tool) => ctx.tools.register(tool));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-gonic: tools");
	ctx.effect(() => {
		const disposers = makeRoutes(store).map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-gonic: routes");
	if (announceToAgent) {
		ctx.systemPrompt.section({
			name: "plugin:dsh-gonic",
			order: SECTION_ORDER,
			text: GONIC_GUIDANCE
		});
	}
}

export { GONIC_API, GONIC_GUIDANCE, GonicStore, apply, browse, inject, makeRoutes, name, normalizeBaseUrl, toTrack, toTracks };
