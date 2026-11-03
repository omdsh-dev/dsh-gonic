# dsh-gonic

DeepSeek Harness Web GUI 里的 Gonic/Subsonic 音乐播放器。

- **播放器（Client 半）**：浏览器直连你的 Gonic 服务器（实测其 API 带 CORS
  头；`stream.view` 的 URL 凭据在 query 里且不过期，`<audio>` 播放不需要
  CORS）。浏览（艺人 / 专辑 / 风格 / 最近添加 / 随机）、搜索、收藏、歌单、
  播放队列（循环/随机）、音量、上次进度续播、输入框下方的迷你播放条。
- **Agent 工具（Host 半）**：`gonic_status`、`gonic_search`、`gonic_browse`、
  `gonic_starred`、`gonic_playlists`、`gonic_playlist`、写操作
  `gonic_create_playlist`，以及 `gonic_play`——通过 Host→浏览器指令通道
  让播放器开播（`playlistId` 播整个歌单 / `trackIds` 播指定曲目 / `query`
  搜索并播放前 N 首）。工具把曲目写进 Host 内存指令槽，浏览器每 3 秒轮询
  `/api/dsh-gonic/play-command`，只执行页面打开之后下发的指令（基线），多
  标签页用 localStorage 认领防止重复播放。前提：浏览器开着 GUI 且页面有过
  点击（浏览器自动播放策略）；暂停/切歌/音量仍在播放器 UI 上控制。
- **配置**：设置 → Gonic 播放器（或播放器页面内）→ 填服务器地址、用户名、
  密码 → 保存并测试。

凭据保存在 Host 侧 `~/.dsh/dsh-gonic.json`（权限 0600），工具与播放器共用；
浏览器只在内存中持有。队列和播放位置留在浏览器的 `localStorage`（不含敏感
信息）。

## 结构

- `lib/index.js` — Host 半：配置存储、Subsonic 客户端、agent 工具、
  `/api/dsh-gonic/*` 路由（含播放指令槽）、系统提示公告。纯 ESM。
- `lib/client.js` — 播放器全部实现：MD5 签名、Subsonic 微客户端、队列
  store、Audio 单例、主页面 / 迷你条 / 设置页 UI、播放指令轮询。手写
  ModuleLoader 模块、纯 React、无构建步骤。
- `scripts/smoke.mjs` — 只读冒烟测试：`node scripts/smoke.mjs`，覆盖 URL
  规范化、入参校验、错误翻译与（配置了 `~/.dsh/dsh-gonic.json` 时的）真实
  服务器只读查询；绝不触发写操作或真实播放。

## 许可

MIT
