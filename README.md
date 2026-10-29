# Chromium Linux 定制

本仓管理 Chromium 稳定版来源、依赖版本、原生补丁和构建发行。当前维护分支为 `release/156`，基线见 [baseline.json](baseline.json)。

目标是保留正常 Linux 桌面、真实渲染与媒体行为，减少网页直接取得的 CPU、内存、GPU 等硬件细节。

已完成稳定版源码调查、Firefox 实际改动对照和 Docker 桌面运行。第一组 CPU/RAM 原生补丁已完成完整浏览器构建，5 项单元测试和三组 Docker 功能验证全部通过。

- [CPU/RAM 原生实现、配置与构建](docs/NATIVE.md)
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
- [自构建 CPU/RAM 三组验证](evidence/hardware-verification-chromium-156.0.8078.73.json)
- [自构建 Linux 桌面记录](evidence/container-desktop-chromium-156.0.8078.73.json)
- [构建参数、工具链与验证汇总](evidence/native-build-156.0.8078.73.json)

源码与原生构建为 Chromium `156.0.8078.73`；此前的原版调查和容器记录使用本机已有 Chrome for Testing `156.0.8078.4`。各份记录分别注明实际版本。报告中的源码链接固定到提交，不跟随 main。

浏览器二进制、Python runtime 和 Playwright Python 兼容入口各自维护版本，沿用已有 core/wrapper 的职责边界。
