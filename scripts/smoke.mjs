/**
 * Smoke test for dsh-gonic — strictly read-only against any live server:
 * search/browse/starred/playlists are queries, and the one write tool
 * (gonic_create_playlist) is only exercised on validation paths that reject
 * before any network traffic. Never writes to ~/.dsh/dsh-gonic.json either;
 * stores under test point at temp files.
 *
 * Usage: node scripts/smoke.mjs
 *   With a configured ~/.dsh/dsh-gonic.json the live read-only checks run
 *   against that server; otherwise they are skipped.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	GONIC_API,
	GonicStore,
	PlayCommandStore,
	browse,
	gonicBrowseTool,
	gonicCreatePlaylistTool,
	gonicPlayTool,
	gonicPlaylistTool,
	gonicPlaylistsTool,
	gonicSearchTool,
	gonicStarredTool,
	gonicStatusTool,
	isLoopbackRequest,
	makeRoutes,
	normalizeBaseUrl
} from "../lib/index.js";

let failures = 0;
const check = (label, cond, extra) => {
	console.log((cond ? "PASS" : "FAIL") + "  " + label + (extra !== undefined ? "  →  " + extra : ""));
	if (!cond) failures++;
};
const tmpDirs = [];
function tempStore() {
	const dir = mkdtempSync(path.join(tmpdir(), "dsh-gonic-smoke-"));
	tmpDirs.push(dir);
	return new GonicStore(path.join(dir, "config.json"));
}

// 1. URL normalization
check("normalize bare host", normalizeBaseUrl("gonic.example.com/") === "http://gonic.example.com", normalizeBaseUrl("gonic.example.com/"));
check("normalize keeps https + path", normalizeBaseUrl("https://example.com/gonic/") === "https://example.com/gonic", normalizeBaseUrl("https://example.com/gonic/"));
check("normalize rejects junk", (() => { try { normalizeBaseUrl("http://"); return false; } catch { return true; } })());
check("normalize rejects non-http scheme", (() => { try { normalizeBaseUrl("ftp://example.com"); return false; } catch { return true; } })());

// 2. browse() root menu is static — no network, works with an empty config
const root = await browse({}, "");
check("browse root menu", Array.isArray(root.nodes) && root.nodes.length === 5 && root.tracks.length === 0, root.nodes.map((n) => n.path).join(","));

// 3. Unconfigured paths (isolated temp store, missing file → empty config)
const emptyStore = tempStore();
const statusEmpty = await gonicStatusTool(emptyStore).execute({});
check("status unconfigured", statusEmpty.ok === false && statusEmpty.configured === false, statusEmpty.message);
const searchEmpty = await gonicSearchTool(emptyStore).execute({ query: "x" });
check("search unconfigured", searchEmpty.ok === false && /尚未配置/.test(searchEmpty.message), searchEmpty.message);

// 4. Validation short-circuits before any network I/O — the store is
// "configured" but points at a black hole; blank input must fail fast with
// the validation message, not a network error.
const holeStore = tempStore();
await holeStore.save({ baseUrl: "http://127.0.0.1:9", username: "smoke", password: "smoke" });
const noQuery = await gonicSearchTool(holeStore).execute({ query: "   " });
check("search rejects blank query", noQuery.ok === false && /不能为空/.test(noQuery.message), noQuery.message);
const noId = await gonicPlaylistTool(holeStore).execute({ id: "" });
check("playlist rejects blank id", noId.ok === false && /不能为空/.test(noId.message), noId.message);
const noName = await gonicCreatePlaylistTool(holeStore).execute({ name: "  " });
check("create_playlist rejects blank name", noName.ok === false && /不能为空/.test(noName.message), noName.message);
const badPath = await gonicBrowseTool(holeStore).execute({ path: "bogus:1" });
check("browse rejects unknown path", badPath.ok === false && /未知浏览路径/.test(badPath.message), badPath.message);
const unreachable = await gonicSearchTool(holeStore).execute({ query: "x" });
check("unreachable server translated", unreachable.ok === false && /网络请求失败|HTTP/.test(unreachable.message), unreachable.message);
const playNone = await gonicPlayTool(holeStore, new PlayCommandStore()).execute({});
check("play requires a source", playNone.ok === false && /playlistId/.test(playNone.message), playNone.message);
const playTwo = await gonicPlayTool(holeStore, new PlayCommandStore()).execute({ playlistId: "x", query: "y" });
check("play rejects multiple sources", playTwo.ok === false && /只能提供一个/.test(playTwo.message), playTwo.message);
const playUnconfigured = await gonicPlayTool(tempStore(), new PlayCommandStore()).execute({ query: "x" });
check("play unconfigured", playUnconfigured.ok === false && /尚未配置/.test(playUnconfigured.message), playUnconfigured.message);

// 5. Route fence: the /api/dsh-gonic routes hand out the Subsonic credentials
// and trigger playback, so they must answer loopback same-origin requests
// only. Unit checks on the predicate, then route-level behavior with mock
// req/res — no network, no real config file touched.
const asReq = (remoteAddress, headers = {}) => ({ method: "GET", socket: { remoteAddress }, headers: { host: "127.0.0.1:8080", ...headers } });
check("fence allows 127.0.0.1", isLoopbackRequest(asReq("127.0.0.1")) === true);
check("fence allows ::1", isLoopbackRequest(asReq("::1")) === true);
check("fence allows ::ffff:127.0.0.1", isLoopbackRequest(asReq("::ffff:127.0.0.1")) === true);
check("fence rejects LAN peer", isLoopbackRequest(asReq("192.168.168.3", { host: "192.168.168.3:8080" })) === false);
check("fence rejects foreign host header", isLoopbackRequest(asReq("127.0.0.1", { host: "evil.example" })) === false);
check("fence rejects cross-site fetch", isLoopbackRequest(asReq("127.0.0.1", { "sec-fetch-site": "cross-site" })) === false);
check("fence allows same-origin fetch", isLoopbackRequest(asReq("127.0.0.1", { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:8080" })) === true);
check("fence rejects foreign origin", isLoopbackRequest(asReq("127.0.0.1", { origin: "http://evil.example" })) === false);
const mockRes = () => ({
	status: 0,
	headers: {},
	body: "",
	writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
	end(body) { this.body = typeof body === "string" ? body : ""; }
});
const fenceRoutes = makeRoutes(tempStore(), new PlayCommandStore());
const configRoute = fenceRoutes.find((route) => route.path === GONIC_API.config);
const commandRoute = fenceRoutes.find((route) => route.path === GONIC_API.playCommand);
const deniedRes = mockRes();
await configRoute.handler(asReq("192.168.168.3", { host: "192.168.168.3:8080" }), deniedRes);
check("config route fences LAN peer", deniedRes.status === 403 && JSON.parse(deniedRes.body).error === "forbidden: loopback-only", String(deniedRes.status));
const okRes = mockRes();
await configRoute.handler(asReq("127.0.0.1"), okRes);
check("config route serves loopback", okRes.status === 200 && okRes.headers["referrer-policy"] === "no-referrer", String(okRes.status));
const commandDenied = mockRes();
await commandRoute.handler(asReq("192.168.168.3", { host: "192.168.168.3:8080" }), commandDenied);
check("play-command fences LAN peer", commandDenied.status === 403, String(commandDenied.status));
const commandRes = mockRes();
await commandRoute.handler(asReq("127.0.0.1"), commandRes);
check("play-command serves loopback", commandRes.status === 200 && typeof JSON.parse(commandRes.body).ts === "number", String(commandRes.status));

// 6. Live read-only checks against the real config, when present.
const realStore = new GonicStore();
const realCfg = await realStore.get();
if (realCfg.baseUrl && realCfg.username && realCfg.password) {
	console.log("— live checks against " + realCfg.baseUrl + " (user " + realCfg.username + ") —");
	const status = await gonicStatusTool(realStore).execute({});
	check("status live", status.ok === true, status.message);
	const search = await gonicSearchTool(realStore).execute({ query: "a", limit: 1 });
	check("search live", search.ok === true && search.count <= 1, search.message);
	const lists = await gonicPlaylistsTool(realStore).execute({});
	check("playlists live", lists.ok === true && Array.isArray(lists.playlists), lists.message);
	const starred = await gonicStarredTool(realStore).execute({});
	check("starred live", starred.ok === true, starred.message);
	const recent = await gonicBrowseTool(realStore).execute({ path: "recent" });
	check("browse recent live", recent.ok === true && recent.nodes.length > 0, recent.message);

	// gonic_play publishes into the slot handed to it — here a smoke-local
	// one, NOT the running Harness's — so the user's player stays silent.
	const slot = new PlayCommandStore();
	if (lists.ok && Array.isArray(lists.playlists) && lists.playlists.length) {
		const played = await gonicPlayTool(realStore, slot).execute({ playlistId: lists.playlists[0].id });
		check("play playlist resolves", played.ok === true && played.count > 0 && slot.get().tracks.length === played.count && slot.get().ts > 0, played.message);
	} else {
		console.log("SKIP play-playlist check — 服务器上没有歌单");
	}
	const playQuery = await gonicPlayTool(realStore, slot).execute({ query: "a", limit: 1 });
	check("play query resolves", playQuery.ok === true && playQuery.count <= 1 && slot.get().tracks.length === playQuery.count, playQuery.message);

	// Wrong password → the Subsonic error envelope must surface as a
	// translated failure, not a crash or a silent ok.
	const deniedStore = tempStore();
	await deniedStore.save({ baseUrl: realCfg.baseUrl, username: realCfg.username, password: "wrong-password-for-smoke" });
	const denied = await gonicSearchTool(deniedStore).execute({ query: "x" });
	check("wrong password translated", denied.ok === false && /服务器拒绝|HTTP/.test(denied.message), denied.message);
} else {
	console.log("SKIP live checks — ~/.dsh/dsh-gonic.json 未配置");
}

for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
