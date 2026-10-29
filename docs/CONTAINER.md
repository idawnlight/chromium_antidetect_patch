# Docker 中的 Linux 桌面

本目录的镜像提供浏览器实际使用的 Linux 桌面服务：Xvfb、Openbox、D-Bus session、Mesa、字体/fontconfig、PulseAudio 和 speech-dispatcher。基础镜像使用 `ubuntu:24.04` 标签。浏览器按独立版本提供，运行时挂载进去。

自构建 `156.0.8078.73` 的 CPU/RAM 配置、构建和三组验证见 [原生实现](NATIVE.md)。本文件保留早期 CfT `.4` 桌面实验；自构建桌面快照另存为 [Chromium `.73` 记录](../evidence/container-desktop-chromium-156.0.8078.73.json)。

## 构建

在仓库根目录执行：

```bash
sudo docker build -f container/Dockerfile -t chromium-linux-desktop:research .
```

入口会建立独立的 X11 显示和窗口管理器，再启动实际音频/语音服务，最后执行传入的命令。默认显示为 1920×1080×24、96 DPI；语言为 en_US.UTF-8；时区可通过 Docker 的 `-e TZ=...` 设置。

PulseAudio 的服务器默认采样率和实际双声道 sink 都配置成 48 kHz。Chromium 读取的是服务器默认采样规范，单改 sink 的 rate 参数不会同步改变 AudioContext 的默认采样率。

## 复现本次观察

需要已有的 Linux Chromium/Chrome 二进制目录，以及支持内置 WebSocket 的 Node；本次使用 Node 24。Node 只用于本地观察脚本，产品控制后端仍按 Python/CDP 架构实现。

```bash
CHROMIUM_PROBE_BROWSER=/absolute/path/to/chrome-linux64
CHROMIUM_PROBE_NODE="$(command -v node)"

sudo docker run --name chromium-desktop-probe \
  --cpus=8 --memory=8g --shm-size=1g \
  -e TZ=America/New_York \
  -e LIBGL_ALWAYS_SOFTWARE=1 \
  -e PROBE_NO_SANDBOX=1 \
  -e 'PROBE_BROWSER_ARGS=["--use-gl=angle","--use-angle=gl","--ignore-gpu-blocklist","--enable-speech-dispatcher"]' \
  --mount "type=bind,src=$CHROMIUM_PROBE_BROWSER,dst=/opt/chrome,readonly" \
  --mount "type=bind,src=$CHROMIUM_PROBE_NODE,dst=/usr/local/bin/node,readonly" \
  --mount "type=bind,src=$PWD/scripts,dst=/opt/probe,readonly" \
  chromium-linux-desktop:research \
  node /opt/probe/probe.mjs /opt/chrome/chrome /tmp/observation.json

sudo docker cp chromium-desktop-probe:/tmp/observation.json evidence/container-observation.json
sudo docker rm chromium-desktop-probe
```

这条命令选择真实 Mesa 软件渲染。`--ignore-gpu-blocklist` 使当前 Chromium 接受 llvmpipe 的 WebGL；ANGLE、shader 编译与像素执行仍由 Mesa 完成。Xvfb 负责显示，Mesa 负责图形。本机观察命令带 `--no-sandbox`，由 `PROBE_NO_SANDBOX=1` 传入；所有参数均记录在 JSON。

观察脚本使用 headed 浏览器和显式非零的本地 CDP 端口。通过真实 profile preferences 设置语言，使用进程 TZ 设置时区；页面脚本直接读取浏览器 API。`PROBE_LOG_STDERR=1` 可输出浏览器诊断日志。

## 本次结果

运行二进制为本机已有 Chrome for Testing **156.0.8078.4**；源码调查基线是 **156.0.8078.73**。完整记录见 [container-desktop-cft-156.0.8078.4.json](../evidence/container-desktop-cft-156.0.8078.4.json)。

| 项目 | 实际结果 |
| --- | --- |
| CPU/内存容器限额 | cgroup 为 8 CPU、8 GiB；网页仍为 HC=48、deviceMemory=32、cpuPerformance=4 |
| Worker / ServiceWorker | HC=48、deviceMemory=32 |
| 平台 | Linux x86_64，原版 Linux UA，webdriver=false |
| 显示与窗口 | 1920×1080×24；outer 1280×800、inner 1272×653、DPR 1 |
| 鼠标与页面状态 | pointer=fine、hover=true、touch=0；页面有焦点且 visible |
| rAF | 中位约 16.7 ms |
| WebGL1/2 | ANGLE → Mesa llvmpipe，shader 编译成功；最大纹理 16384 |
| WebGPU | 此软件配置下 adapter=null |
| 音频 | AudioContext 默认 48 kHz、双声道；读取时为 suspended |
| 字体匹配 | `fc-match sans-serif` 为 Noto Sans，monospace 为 DejaVu Sans Mono |
| 语言与时区 | en-US / America/New_York；Intl、Date、lastModified 使用同一时区 |

固定 HTTP Last-Modified 为 `2026-01-01T12:00:00Z`，网页 `document.lastModified` 返回当地 `01/01/2026 07:00:00`，Date 同样为 07:00 EST。这里使用启动前的实际 TZ，覆盖 libc 和 ICU/V8 两条路径。

当前 speech-dispatcher/espeak-ng 服务真实返回 13,363 个 voice，包含基础语言与全部 variant 组合。Chromium 按名称排序并将首项标成 default，因此第一项是 Afrikaans。这是此版本服务和 Chromium 的实际枚举行为。`--enable-speech-dispatcher` 是可选的 Linux TTS 开关；省略时原版 Chromium 不初始化该平台。

## 产品运行配置

软件渲染可作为无 GPU 环境的一种 Linux 桌面配置，保留 llvmpipe 的实际身份与能力。硬件渲染采用独立配置：提供对应 GPU render node、访问权限和匹配的用户态驱动，并移除软件渲染选择参数；实际 backend 由浏览器和驱动初始化结果决定。本次记录采用软件配置。

每个独立身份使用一个 browser process 和一套桌面会话；同一身份可有多个页面。桌面服务先于浏览器启动，语言、TZ、字体、显示和音频从进程初始化即生效。持久会话给 browser profile 提供可写 volume。容器路由/DNS统一承载导航、Worker、RTC 和浏览器后台网络。

Python 后端负责启动、CDP session、窗口激活、输入和截图。首批原生补丁集中在网页 CPU/RAM 声明及内存 Client Hints；本次实验已确认容器限额本身不会改变这些宿主数据源。
