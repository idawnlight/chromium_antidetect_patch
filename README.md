# Chromium Linux Desktop Stealth (`release/157`)

本仓库维护基于最新稳定版 **Chromium `157.0.8103.50`**（[baseline.json](baseline.json)）的 Linux 原生补丁集、无泄露桌面容器环境与端到端自动化验收脚本。

核心设计目标：**保持真实 Linux Chromium 平台身份与完整原生渲染/媒体能力，彻底屏蔽底层服务器或容器的硬件规模、无物理 GPU 软件渲染痕迹以及 CDP/V8 自动化特征，使浏览器无论部署在任何云主机或无卡容器中都与一台标准 Linux Desktop 完全一致。**

- [157 源码审计与补丁架构设计](docs/DESIGN_157.md)
- [原生补丁配置、构建与单测指南](docs/NATIVE.md)
- [Docker Linux 桌面环境与运行指南](docs/CONTAINER.md)
- [开发期真 GPU (RTX 2080 Ti) 与 Mesa llvmpipe WebGL 对照数据](evidence/gpu-reference-comparison.json)

---

## 补丁集结构

由 [`scripts/apply-patches.sh`](scripts/apply-patches.sh) 按顺序应用到独立 Chromium 源码树（`src/` 与 `src/v8/`）：

| 补丁文件 | 作用仓库 | 解决的核心问题 |
| --- | --- | --- |
| [`patches/chromium/0001-web-hardware-profile.patch`](patches/chromium/0001-web-hardware-profile.patch) | `src` | 通过 `INVISIBLE_CHROMIUM_PROFILE` 统一声明 Window/Worker `hardwareConcurrency`、`deviceMemory`（支持 `2/4/8/16/32 GiB` 并同步对齐 V8 `jsHeapSizeLimit` 与导航/子资源内存 Client Hints）及 `cpuPerformance` 档位 |
| [`patches/chromium/0002-webgl-desktop-normalization.patch`](patches/chromium/0002-webgl-desktop-normalization.patch) | `src` | 无需 `--ignore-gpu-blocklist` 自动启用容器 OpenGL WebGL1/2；保证 `failIfMajorPerformanceCaveat: true` 成功；统一规范化主线程与 Worker `OffscreenCanvas` 的 WebGL vendor/renderer 及 `llvmpipe` 特征参数/着色器整数精度/MSAA 采样数 |
| [`patches/chromium/0003-automation-cdp-stealth.patch`](patches/chromium/0003-automation-cdp-stealth.patch) | `src` | 支持 `--remote-debugging-pipe` 匿名管道控制且保持 `navigator.webdriver === false`；消除 `--no-sandbox` 等 `kBadFlags` 顶部警告横幅对 `innerHeight` 的挤压；修复 CDP `Input.dispatchMouseEvent` 缺省 `force=0` 导致 `pointerdown.pressure === 0` 的协议破绽 |
| [`patches/v8/0001-inspector-console-stealth.patch`](patches/v8/0001-inspector-console-stealth.patch) | `src/v8` | 修复 V8 `value-mirror.cc` 原型链 getter 漏洞；隔离 `Runtime.enable` 下 `console.*` 参数包装副作用（零自定义 getter / `Proxy` trap / DOM 属性触发）与未捕获异常栈采集开关 |

---

## 构建配置亮点（[`build/linux-release.gn`](build/linux-release.gn)）

- 保持 `is_chrome_branded = false`（真实 Linux `Chromium` 品牌与 UA-CH）；
- 启用 `proprietary_codecs = true` 与 `ffmpeg_branding = "Chrome"`，补齐标准 Linux 桌面版必备的 **H.264 (`avc1`) / AAC (`mp4a`) / MP3 / MP4 / HLS** 原生编解码能力；
- 启用 `use_dummy_lastchange = false`，确保 `Browser.getVersion()` 精确记录上游发布提交 `@049750111b1e5c11565c792b2aeed5541f332bad`。

---

## 独立运行时产物打包与外部检测基准

- 使用 [`scripts/package-release.py`](scripts/package-release.py) 从 `out/Release` 提取并 `llvm-strip` 全部 249 个官方运行时文件，生成确定性 PAX 归档（`chromium-157.0.8103.50-stealth-linux-x86_64.tar.gz`，约 225 MiB）、`seal.json`、`provenance.json` 与 `SHA256SUMS`。
- 配套 Python 自动化与拟人轨迹控制库见 `idawnlight/invisible_chromium`（复用 `invisible_core` Humanize 引擎，通过 `--remote-debugging-pipe` + `Page.createIsolatedWorld` 驱动）。
- 在无物理 GPU 的 [`chromium-linux-desktop:157`](container/Dockerfile) 容器中实测外部反爬基准（详见 [`evidence/external-benchmark-157.0.8103.50.json`](evidence/external-benchmark-157.0.8103.50.json)）：
  - **Rebrowser Bot Detector**：`runtimeEnableLeak`、`sourceUrlLeak`、`mainWorldExecution`、`navigatorWebdriver`、`headless`、`workerConsistency`、`nativeTampering` 全部安全通过；
  - **Sannysoft**：45/45 项全部通过（0 failed）；
  - **CreepJS**：`0% headless`、`0% stealth`；
  - **Fingerprint Pro**：`Bot: Not detected`、`Browser Tampering: Not detected`、`Virtual Machine: Not detected`、`Developer Tools: Not detected`、`VPN: Not detected`、`Suspect Score: 0`；
  - **Google reCAPTCHA v3 (antcpt)**：`score = 0.9`；
  - **BrowserLeaks**：TLS 1.3 + X25519MLKEM768 + ECH、WebGL2 `Mesa Intel(R) UHD Graphics 630`（`Major Performance Caveat: false`）、WebRTC `No Leak`。
