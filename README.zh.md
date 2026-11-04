# dsh-gonic

> **中文** | [English](README.md)

在 DeepSeek Harness Web GUI 里播放你的 [Gonic](https://github.com/sentriz/gonic)/Subsonic 曲库——浏览、搜索、收藏、歌单、队列与播放；并为 agent 提供搜歌、浏览曲库、创建歌单、驱动浏览器开播的工具。

## 功能

- **播放器（Client 半）**——浏览器直连你的 Gonic 服务器（其 API 带 CORS 头；`stream.view` 的 URL 凭据在 query 里且不过期，`<audio>` 播放不需要 CORS）。浏览（艺人 / 专辑 / 风格 / 最近添加 / 随机）、搜索、收藏歌曲、歌单、播放队列（循环/随机）、音量控制、上次进度续播，以及对话输入框下方的迷你播放条。
- **Agent 工具（Host 半）**——`gonic_status`、`gonic_search`、`gonic_browse`、`gonic_starred`、`gonic_playlists`、`gonic_playlist`、唯一的写操作 `gonic_create_playlist`，以及 `gonic_play`：Host→浏览器指令通道，让播放器开播（`playlistId` 播整个歌单 / `trackIds` 播指定曲目 / `query` 搜索并播放前 N 首，可用 `limit` 控制 N）。工具把曲目写进 Host 内存指令槽，浏览器每 3 秒轮询 `/api/dsh-gonic/play-command`，只执行页面打开之后下发的指令（基线），多标签页用 localStorage 认领防止重复播放。前提：浏览器开着 GUI 且页面有过点击（自动播放策略）；暂停/切歌/音量仍在播放器 UI 上控制。
- **设置面板**——设置 → Gonic 播放器（section order 302）：服务器地址、用户名、密码，保存 + 连接测试；未配置时同一表单把关播放器页面。
- 凭据保存在 Host 侧 `~/.dsh/dsh-gonic.json`（权限 0600），工具与播放器共用；浏览器只在内存中持有。队列和播放位置留在浏览器的 `localStorage`（不含敏感信息）。
- 系统提示公告（`plugin:dsh-gonic`，order 152）：agent 知道何时该用这个插件。

## 适配版本

任何按 **Subsonic API 1.15.0** 返回 JSON 的服务器（salt+token 认证，`f=json`）——基于 [Gonic](https://github.com/sentriz/gonic) 开发。用到的端点：`ping`、`search3`、`getArtists`、`getArtist`、`getAlbum`、`getAlbumList2`、`getGenres`、`getSongsByGenre`、`getRandomSongs`、`getStarred2`、`getPlaylists`、`getPlaylist`、`createPlaylist`、`getSong`、`getCoverArt`、`stream`。

宿主：Node `^22.19.0 || >=24.0.0`，DSH `>=0.2.1-rc.2 <0.3.0`。

## 安装

已发布的版本自带编译好的 `lib/` 产物，直接装 tarball 即可：

```sh
# 从最新 release 安装（零运行时依赖，无需构建）
dsh plugin --profile web add "https://github.com/omdsh-dev/dsh-gonic/releases/latest/download/pkg.tgz"
```

本地开发用 link 方式：

```sh
npm install --legacy-peer-deps && npm run build   # 仅首次：src/*.ts → lib/
dsh plugin --profile web add link:/path/to/dsh-gonic
```

（加 `--legacy-peer-deps` 是因为 `@deepseek-ai/*` 开发闭包过不了严格 peer 解析。）

重启 `dsh web` 生效。源码是 TypeScript（`src/`）；`lib/` 是 `tsc` 输出——纯 ESM、零运行时依赖。

## 配置

1. 在 DSH Web 设置页打开「Gonic 播放器」（或直接打开播放器页面），填服务器地址、用户名、密码，点「保存并测试」；也可以直接让 agent 配置：「帮我配置 gonic，服务器是 http://192.168.1.10:4747，用户名 …，密码 …」。
2. 之后直接说：「搜一下我曲库里的 X」「用这些歌建一个叫 Y 的歌单」「播放我的歌单 Z」。

> 密码等同于你曲库的完整 Subsonic 凭据。agent 工具可以读库、建歌单，但不能修改、删除或加星任何已有内容。

## 开发

- `npm run build`——编译 `src/` 到 `lib/`；`npm run typecheck`——只检查不输出；`npm run dev`——watch 模式。
- `src/index.ts`——Host 半：配置存储、Subsonic 客户端、agent 工具、`/api/dsh-gonic/*` 路由（含播放指令槽）、系统提示公告。
- `src/client.ts`——播放器全部实现：MD5 签名、Subsonic 微客户端、队列 store、Audio 单例、主页面 / 迷你条 / 设置页 UI、播放指令轮询。ModuleLoader 经典脚本（纯 React `createElement`，无 JSX）；产出的 `lib/client.js` 必须不含 `import`/`export` 语句，且以 `window.__ModuleLoader__.load(` 开头。
- `scripts/smoke.mjs`——只读冒烟测试：`node scripts/smoke.mjs`，覆盖 URL 规范化、入参校验、错误翻译与（配置了 `~/.dsh/dsh-gonic.json` 时的）真实服务器只读查询；绝不触发写操作或真实播放。
- `locale/*.json`——插件元信息文案（en / zh）；`icon.svg`——面板图标。

## 许可

MIT
