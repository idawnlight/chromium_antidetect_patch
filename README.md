# Chromium Linux 定制

本仓管理 Chromium 稳定版来源、依赖版本、原生补丁和构建发行。当前维护分支为 `release/156`，基线见 [baseline.json](baseline.json)。

目标是保留正常 Linux 桌面、真实渲染与媒体行为，减少网页直接取得的 CPU、内存、GPU 等硬件细节。

本轮完成了稳定版源码调查、Firefox 实际改动对照，以及 Docker 中的原版 Linux 桌面运行。原生补丁及构建尚未开始。

- [硬件与显示 API 总报告、首版改动范围](docs/HARDWARE_APIS.md)
- [CPU、内存、存储、网络与外设](docs/cpu-devices.md)
- [显示、窗口、缩放、CSS 与输入](docs/display.md)
- [GPU、图形、字体、音频与媒体](docs/render-media.md)
- [WebNN、WebXR、折叠与屏幕键盘](docs/additional.md)
- [Firefox 对照：身份、区域、显示与输入](docs/firefox-comparison-identity.md)
- [Firefox 对照：图形、字体与媒体](docs/firefox-comparison-render.md)
- [Firefox 对照：自动化与网络](docs/firefox-comparison-automation-network.md)
- [Docker 桌面安装、运行与结果](docs/CONTAINER.md)
- [原版运行记录](evidence/stock-cft-156.0.8078.4.json)
- [Docker 运行记录](evidence/container-desktop-cft-156.0.8078.4.json)

源码结论固定为 Chromium `156.0.8078.73`。运行记录来自本机已有 Chrome for Testing `156.0.8078.4`，两者版本分别记录。报告中的源码链接固定到提交，不跟随 main。

浏览器二进制、Python runtime 和 Playwright Python 兼容入口各自维护版本，沿用已有 core/wrapper 的职责边界。
