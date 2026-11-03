# dsh-gonic

DeepSeek Harness Web GUI 里的 Gonic/Subsonic 音乐播放器。

- **播放器（Client 半）**：浏览器直连你的 Gonic 服务器（实测其 API 带 CORS
  头；`stream.view` 的 URL 凭据在 query 里且不过期，`<audio>` 播放不需要
  CORS）。浏览（艺人 / 专辑 / 风格 / 最近添加 / 随机）、搜索、收藏、歌单、
  播放队列（循环/随机）、音量、上次进度续播、输入框下方的迷你播放条。
- **Agent 工具（Host 半）**：`gonic_status`、`gonic_search`、`gonic_browse`、
  `gonic_starred`、`gonic_playlists`、`gonic_playlist`，以及写操作
  `gonic_create_playlist`。它们只操作服务器上的曲库与歌单——播放队列在
  浏览器里，工具无法控制当前播放。
- **配置**：设置 → Gonic 播放器（或播放器页面内）→ 填服务器地址、用户名、
  密码 → 保存并测试。

凭据保存在 Host 侧 `~/.dsh/dsh-gonic.json`（权限 0600），工具与播放器共用；
浏览器只在内存中持有。队列和播放位置留在浏览器的 `localStorage`（不含敏感
信息）。

## 结构

- `lib/index.js` — Host 半：配置存储、Subsonic 客户端、agent 工具、
  `/api/dsh-gonic/*` 路由、系统提示公告。纯 ESM。
- `lib/client.js` — 播放器全部实现：MD5 签名、Subsonic 微客户端、队列
  store、Audio 单例、主页面 / 迷你条 / 设置页 UI。手写 ModuleLoader 模块、
  纯 React、无构建步骤。

## 许可

MIT
