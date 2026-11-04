/**
 * dsh-gonic — Gonic/Subsonic player integration for DeepSeek Harness. Host half.
 *
 * Owns the server credentials (~/.dsh/dsh-gonic.json, mode 0600), mounts the
 * agent tools (gonic_status / gonic_search / gonic_browse / gonic_starred /
 * gonic_playlists / gonic_playlist / gonic_create_playlist / gonic_play),
 * serves the /api/dsh-gonic routes the Client half talks to (loopback-only —
 * the config route hands out the Subsonic credentials), and announces the
 * capability to the agent through a system-prompt section.
 *
 * The Gonic server itself is never modified: this plugin is a plain Subsonic
 * API client. Playback stays in the browser (Client half); the queue lives in
 * the browser too, so tools operate on the server catalogue only — they
 * cannot control what is currently playing.
 *
 * Pure ESM, no runtime dependencies beyond @deepseek-ai/dsh-tools (provided
 * by the Host). Source is TypeScript (src/); lib/ is tsc output.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
// Type-only import: pulls in the `Context.systemPrompt` service augmentation.
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

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
	test: "/api/dsh-gonic/test",
	playCommand: "/api/dsh-gonic/play-command"
};
/** Cap on JSON request bodies to the config route. */
const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GONIC_GUIDANCE = "本机已安装 dsh-gonic 插件（Gonic/Subsonic 音乐库集成）：配置好服务器后，可用 gonic_search 按关键词搜歌，gonic_browse 浏览曲库（空路径给出根菜单：艺人/专辑/风格/最近添加/随机；用 artist:<id>、album:<id>、genre:<名> 逐层下钻），gonic_starred 查看已加星的歌曲，gonic_playlists / gonic_playlist 查看歌单列表与详情，gonic_create_playlist 用曲目 id 列表创建新歌单（先用 gonic_search 凑齐 id），gonic_play 让用户浏览器里的播放器开播（playlistId 播整个歌单 / trackIds 播指定曲目 / query 搜索并播放前 N 首，可用 limit 控制）。gonic_status 查看连接与配置状态；也可以在 Web 设置页「Gonic 播放器」面板中配置。用户提到「我的曲库 / 音乐 / 歌单」并想查找或整理时即指本插件；用户说「播放 / 放歌 / 我想听…」时用 gonic_play。注意：gonic_play 通过 Host→浏览器指令通道驱动用户浏览器里的播放器（替换其播放队列并开播），需要用户的浏览器开着 DSH GUI 且页面有过点击（浏览器自动播放策略），指令几秒内生效；暂停、切歌、音量仍由用户在播放器 UI 上控制，工具不提供。曲库写操作仅限创建歌单（不提供修改、删除、加星）。";

/** Persisted credential record (~/.dsh/dsh-gonic.json). */
interface GonicConfigRecord {
	baseUrl: string;
	username: string;
	password: string;
}

/** Config write input (a JSON boundary — every field is coerced before use). */
interface ConfigInput {
	baseUrl?: unknown;
	username?: unknown;
	password?: unknown;
}

/** Public config view: configured flag, base URL, username, and the password. */
interface ConfigView {
	configured: boolean;
	baseUrl: string;
	username: string;
	password: string;
}

/** One track row in tool outputs (the shape toTrack() emits). */
type Track = {
	id: string;
	title: string;
	artist: string;
	album: string;
	duration: number;
};

/** One browse node (folder-like catalogue entry) in tool outputs. */
type BrowseNode = {
	path: string;
	label: string;
	detail?: string;
};

/** One browse() result: folder nodes plus (at leaf levels) tracks. */
type BrowseResult = {
	nodes: BrowseNode[];
	tracks: Track[];
};

/** One playlist summary row in the gonic_playlists output. */
type PlaylistSummary = {
	id: string;
	name: string;
	songCount: number;
};

/** One queued play command handed to the browser via the play-command slot. */
type PlayCommand = {
	ts: number;
	title: string;
	tracks: Track[];
};

/** Parsed subsonic-response payload: raw JSON whose fields are re-validated at each use site. */
type LoosePayload = Record<string, any>;

/** One text content block (the only render shape these tools emit). */
function text(value: string): { type: "text"; text: string }[] {
	return [{ type: "text", text: value }];
}

/** Normalize a server base URL: trim, default to http, drop trailing slashes. */
function normalizeBaseUrl(value: unknown): string {
	let url = String(value || "").trim();
	if (!url) return "";
	// Prepend http:// only when there is no scheme at all — otherwise a
	// non-http scheme (ftp://, gonic://…) would be swallowed into a bogus
	// http:// host instead of hitting the protocol check below.
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "http://" + url;
	let parsed: URL;
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
function clampLimit(value: unknown, fallback: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), max);
}

/** Format seconds as m:ss. */
function fmt(sec: number): string {
	sec = Math.max(0, Math.floor(Number(sec) || 0));
	return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}

//#region config store — ~/.dsh/dsh-gonic.json, mode 0600
/**
 * Small credential store backed by ~/.dsh/dsh-gonic.json (dsh-memos
 * MemosStore template). Reads are lazy and cached; writes create the
 * directory with mode 0700 and rewrite the file with mode 0600.
 */
class GonicStore {
	declare file: string;
	declare config: GonicConfigRecord | null;
	constructor(file = CONFIG_FILE) {
		this.file = file;
		this.config = null;
	}
	async load(): Promise<GonicConfigRecord> {
		if (this.config !== null) return this.config;
		try {
			const raw = await readFile(this.file, "utf8");
			const parsed = JSON.parse(raw);
			this.config = {
				baseUrl: typeof parsed?.baseUrl === "string" ? parsed.baseUrl : "",
				username: typeof parsed?.username === "string" ? parsed.username : "",
				password: typeof parsed?.password === "string" ? parsed.password : ""
			};
		} catch {
			this.config = { baseUrl: "", username: "", password: "" };
		}
		return this.config;
	}
	async get(): Promise<GonicConfigRecord> {
		return this.config ?? this.load();
	}
	async save(input: ConfigInput): Promise<GonicConfigRecord> {
		const next = {
			baseUrl: normalizeBaseUrl(input?.baseUrl),
			username: String(input?.username ?? "").trim(),
			password: typeof input?.password === "string" ? input.password : ""
		};
		await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		await writeFile(this.file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
		this.config = next;
		return next;
	}
	/** Full view incl. password: the browser client signs its own direct API/stream calls. */
	view(): ConfigView {
		const cfg = this.config ?? { baseUrl: "", username: "", password: "" };
		return {
			configured: configured(cfg),
			baseUrl: cfg.baseUrl || "",
			username: cfg.username || "",
			password: cfg.password || ""
		};
	}
}
function configured(cfg: GonicConfigRecord | null | undefined): boolean {
	return Boolean(cfg && cfg.baseUrl && cfg.username && cfg.password);
}
//#endregion

//#region play command slot — in-memory, polled by the browser client
/**
 * One-slot mailbox for "play this now" orders. gonic_play publishes; the
 * browser polls /api/dsh-gonic/play-command every few seconds and compares
 * `ts` so each command executes exactly once per tab. In-memory only: a Host
 * restart clears pending commands, and the client never executes commands
 * older than its own page load (baseline), so nothing stale can fire.
 */
class PlayCommandStore {
	declare command: PlayCommand;
	constructor() {
		this.command = { ts: 0, title: "", tracks: [] };
	}
	publish(title: string, tracks: Track[]): PlayCommand {
		this.command = { ts: Date.now(), title: String(title || ""), tracks: Array.isArray(tracks) ? tracks : [] };
		return this.command;
	}
	get(): PlayCommand {
		return this.command;
	}
}
//#endregion

//#region subsonic client (Host side)
function endpoint(cfg: GonicConfigRecord, view: string, params?: Record<string, string | string[]>): string {
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
async function api(cfg: GonicConfigRecord, view: string, params?: Record<string, string | string[]>): Promise<LoosePayload> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let res: Response;
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
function toTrack(song: LoosePayload): Track {
	return {
		id: String(song?.id ?? ""),
		title: song?.title || "?",
		artist: song?.artist || "",
		album: song?.album || "",
		duration: Math.max(0, Math.floor(song?.duration || 0))
	};
}
const toTracks = (list: unknown): Track[] => (Array.isArray(list) ? list : []).filter((s) => s && s.id != null).map(toTrack);
function albumNodes(albums: unknown): BrowseNode[] {
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
async function browse(cfg: GonicConfigRecord, path0: string): Promise<BrowseResult> {
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
			const artists = (body.artists?.index ?? []).flatMap((entry: LoosePayload) => entry.artist ?? []);
			return {
				nodes: artists.filter((a: LoosePayload) => a && a.id).map((a: LoosePayload) => ({
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
				.filter((g: LoosePayload) => g && (g.value || "").trim() !== "")
				.sort((a: LoosePayload, b: LoosePayload) => (b.songCount || 0) - (a.songCount || 0));
			return {
				nodes: genres.map((g: LoosePayload) => ({ path: "genre:" + g.value, label: g.value, detail: g.songCount ? g.songCount + " 首" : "" })),
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
function renderTrackList(title: string, tracks: Track[], withIds: boolean): string {
	if (!tracks.length) return title + "：无曲目";
	const lines = tracks.map((track, i) => {
		const base = `${i + 1}. ${track.title} — ${track.artist || "—"}${track.album ? " · " + track.album : ""} (${fmt(track.duration)})`;
		return withIds ? base + ` [id: ${track.id}]` : base;
	});
	return title + "（共 " + tracks.length + " 首）\n" + lines.join("\n");
}
function renderNodes(nodes: BrowseNode[]): string {
	return nodes.map((n) => `- ${n.label}${n.detail ? "（" + n.detail + "）" : ""} → ${n.path}`).join("\n");
}
//#endregion

//#region tools
function gonicStatusTool(store: GonicStore) {
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

function gonicSearchTool(store: GonicStore) {
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
				return text(renderTrackList(`搜索 ${JSON.stringify(args.query ?? "")}`, Array.isArray(value.tracks) ? value.tracks as Track[] : [], true));
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

function gonicBrowseTool(store: GonicStore) {
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
				const parts: string[] = [];
				if (Array.isArray(value.nodes) && value.nodes.length) parts.push(renderNodes(value.nodes as BrowseNode[]));
				if (Array.isArray(value.tracks) && value.tracks.length) parts.push(renderTrackList(title, value.tracks as Track[], true));
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

function gonicStarredTool(store: GonicStore) {
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
				return text(renderTrackList("已加星的歌曲", Array.isArray(value.tracks) ? value.tracks as Track[] : [], true));
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

function gonicPlaylistsTool(store: GonicStore) {
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
				const playlists = Array.isArray(value.playlists) ? value.playlists as PlaylistSummary[] : [];
				if (!playlists.length) return text("服务器上没有歌单");
				return text("歌单（共 " + playlists.length + " 个）\n" + playlists.map((p) => `- ${p.name}（${p.songCount} 首）[id: ${p.id}]`).join("\n"));
			}
		},
		async execute() {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, message: "尚未配置 Gonic 服务器" };
			try {
				const body = await api(cfg, "getPlaylists.view");
				const playlists = (body.playlists?.playlist ?? []).map((p: LoosePayload) => ({
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

function gonicPlaylistTool(store: GonicStore) {
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
				return text(renderTrackList("歌单 " + (value.name || ""), Array.isArray(value.tracks) ? value.tracks as Track[] : [], true));
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

function gonicCreatePlaylistTool(store: GonicStore) {
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

function gonicPlayTool(store: GonicStore, playStore: PlayCommandStore) {
	return defineTool({
		name: "gonic_play",
		description: "让用户的浏览器播放器播放音乐（替换其播放队列并开播）。三种选源方式必须且只能给一个：playlistId（播放整个歌单，id 从 gonic_playlists 获取）、trackIds（播放指定曲目，id 从 gonic_search / gonic_browse / gonic_playlist 等获取）、query（搜索并播放前 limit 首结果）。前提：用户的浏览器开着 DSH GUI 且页面有过点击（浏览器自动播放策略）；指令几秒内生效，暂停/切歌/音量在播放器 UI 上控制。",
		parameters: {
			playlistId: { type: "string", description: "播放整个歌单：歌单 id（从 gonic_playlists 获取）" },
			trackIds: { type: "array", items: { type: "string" }, description: "播放指定曲目 id 列表，按给定顺序" },
			query: { type: "string", description: "搜索关键词，播放前 limit 首结果" },
			limit: { type: "number", description: "配合 query：取前 N 首，默认 20，最大 50" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					title: { type: "string" },
					count: { type: "number" },
					tracks: { type: "array" }
				}
			},
			render: (_args, value) => {
				if (!value.ok) return text("[failed] " + value.message);
				return text("[ok] " + value.message + "\n" + renderTrackList(value.title || "播放队列", Array.isArray(value.tracks) ? value.tracks as Track[] : [], false));
			}
		},
		async execute(args) {
			const cfg = await store.get();
			if (!configured(cfg)) return { ok: false, message: "尚未配置 Gonic 服务器" };
			const playlistId = typeof args.playlistId === "string" ? args.playlistId.trim() : "";
			const trackIds = Array.isArray(args.trackIds) ? args.trackIds.map((v) => String(v)).filter(Boolean) : [];
			const query = typeof args.query === "string" ? args.query.trim() : "";
			const given = (playlistId ? 1 : 0) + (trackIds.length ? 1 : 0) + (query ? 1 : 0);
			if (given === 0) return { ok: false, message: "请提供 playlistId、trackIds 或 query 之一" };
			if (given > 1) return { ok: false, message: "playlistId、trackIds、query 三者只能提供一个" };
			try {
				let title: string;
				let tracks: Track[];
				if (playlistId) {
					const body = await api(cfg, "getPlaylist.view", { id: playlistId });
					tracks = toTracks(body.playlist?.entry);
					title = "歌单 " + (body.playlist?.name || playlistId);
					if (!tracks.length) return { ok: false, message: "歌单为空或不存在" };
				} else if (trackIds.length) {
					tracks = [];
					for (const id of trackIds) {
						const body = await api(cfg, "getSong.view", { id });
						if (body.song && body.song.id != null) tracks.push(toTrack(body.song));
					}
					title = "指定曲目";
					if (!tracks.length) return { ok: false, message: "没有可播放的曲目（id 均无效）" };
				} else {
					const body = await api(cfg, "search3.view", { query, songCount: String(clampLimit(args.limit, 20, 50)), artistCount: "0", albumCount: "0" });
					tracks = toTracks(body.searchResult3?.song);
					title = `搜索 ${JSON.stringify(query)}`;
					if (!tracks.length) return { ok: false, message: `没有搜到与 ${JSON.stringify(query)} 匹配的曲目` };
				}
				playStore.publish(title, tracks);
				return {
					ok: true,
					message: `已下发播放指令：${title}（${tracks.length} 首）。浏览器打开着 GUI 时几秒内替换队列并开播；若页面加载后还没有过点击，浏览器可能拦截自动播放，请用户在页面上点一下。`,
					title,
					count: tracks.length,
					tracks
				};
			} catch (error) {
				return { ok: false, message: String(error instanceof Error ? error.message : error) };
			}
		}
	});
}
//#endregion

//#region http routes for the settings panel
/**
 * Loopback-only fence plus browser same-origin markers (mirrors dsh-memos).
 * The config route hands the browser the Subsonic credentials and the
 * play-command route triggers playback, so every route in this family must
 * answer only requests from this machine that a cross-site web page could
 * not have produced.
 */
function isLoopbackRequest(request: IncomingMessage): boolean {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
function writeJson(res: ServerResponse, status: number, value: unknown): void {
	const payload = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Answer 403 and return false unless the request passes the loopback fence. */
function fence(req: IncomingMessage, res: ServerResponse): boolean {
	if (isLoopbackRequest(req)) return true;
	writeJson(res, 403, { error: "forbidden: loopback-only" });
	return false;
}
function readJsonBody(req: IncomingMessage): Promise<any> {
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
function makeRoutes(store: GonicStore, playStore?: PlayCommandStore): WebRoute[] {
	const commands = playStore || new PlayCommandStore();
	return [
		{
			kind: "exact",
			path: GONIC_API.config,
			handler: async (req, res) => {
				if (!fence(req, res)) return;
				try {
					if (req.method === "GET") {
						await store.get();
						writeJson(res, 200, { ok: true, ...store.view() });
						return;
					}
					if (req.method === "POST") {
						const body = await readJsonBody(req);
						await store.save(body);
						writeJson(res, 200, { ok: true, ...store.view() });
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
				if (!fence(req, res)) return;
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
		},
		{
			// Polled by the browser player every few seconds. Returns the
			// current command as-is (never cleared): clients compare `ts`
			// against their own baseline and execute only newer ones.
			kind: "exact",
			path: GONIC_API.playCommand,
			handler: async (req, res) => {
				if (!fence(req, res)) return;
				if (req.method !== "GET") {
					res.writeHead(405, { allow: "GET" });
					res.end();
					return;
				}
				writeJson(res, 200, commands.get());
			}
		}
	];
}
//#endregion

/**
 * Host plugin context, typed as the real cordis Context: `tools` and
 * `systemPrompt` resolve through the service augmentations shipped by
 * @deepseek-ai/dsh-tools and @deepseek-ai/dsh-system-prompt (the latter via a
 * type-only import above), and `effect` comes from cordis itself. The host
 * composition exposes the webserver service under the name "webServer"
 * (upstream augments it as `httpServer`), so that one member is declared
 * locally with exactly the used surface.
 */
type GonicContext = Context & {
	webServer: {
		register(route: WebRoute): () => void;
	};
};

/** Plugin config from the composition row. */
interface ApplyConfig {
	announceToAgent?: boolean;
	enabled?: boolean;
}

/**
 * Mount the gonic tools, routes, and announcement.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
function apply(ctx: GonicContext, config?: ApplyConfig): void {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	if (!enabled) return;
	const store = new GonicStore();
	const playStore = new PlayCommandStore();
	const tools = [
		gonicStatusTool(store),
		gonicSearchTool(store),
		gonicBrowseTool(store),
		gonicStarredTool(store),
		gonicPlaylistsTool(store),
		gonicPlaylistTool(store),
		gonicCreatePlaylistTool(store),
		gonicPlayTool(store, playStore)
	];
	ctx.effect(() => {
		const disposers = tools.map((tool) => ctx.tools.register(tool));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-gonic: tools");
	ctx.effect(() => {
		const disposers = makeRoutes(store, playStore).map((route) => ctx.webServer.register(route));
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

export {
	GONIC_API,
	GONIC_GUIDANCE,
	GonicStore,
	PlayCommandStore,
	apply,
	browse,
	gonicBrowseTool,
	gonicCreatePlaylistTool,
	gonicPlayTool,
	gonicPlaylistTool,
	gonicPlaylistsTool,
	gonicSearchTool,
	gonicStarredTool,
	gonicStatusTool,
	inject,
	isLoopbackRequest,
	makeRoutes,
	name,
	normalizeBaseUrl,
	toTrack,
	toTracks
};
