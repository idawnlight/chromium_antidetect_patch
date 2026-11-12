# Docker Linux 桌面容器环境（`chromium-linux-desktop:157`）

容器镜像提供与真实 Ubuntu 24.04 桌面一致的基础设施，且**不依赖宿主机物理 GPU**：

- **显示与窗口管理**：`Xvfb` (`1920x1080x24`, 96 DPI) + `Openbox`（预设底部 `36px` 面板工作区边距，使 X11 `_NET_WORKAREA` 为 `1920x1044`，`screen.availHeight < screen.height`）+ `Xft` 标准抗锯齿/微调配置。
- **图形栈**：内置 Mesa OpenGL / EGL / Vulkan 驱动。当容器未挂载 `/dev/dri/renderD128` 时，入口脚本自动设置 `LIBGL_ALWAYS_SOFTWARE=1`，配合浏览器内置补丁（无需 `--ignore-gpu-blocklist`）呈现完整的 Linux Desktop WebGL1/2 环境；若挂载物理 GPU 渲染节点则自动使用硬件渲染。
- **音频与媒体设备**：`PulseAudio` 固定 `48000 Hz` 双声道输出 sink（`Built-in_Audio_Analog_Stereo`）+ `module-remap-source` 虚拟麦克风输入源（`Built-in_Microphone`），使 `enumerateDevices()` 正常返回 `audioinput` 与 `audiooutput`。
- **语音合成**：不启动 `speech-dispatcher`，不传 `--enable-speech-dispatcher`，与原版 Linux Desktop Chromium 默认行为（`speechSynthesis.getVoices() === []`，无 `kBadFlags` 警告栏）严格一致。
- **桌面字体栈**：安装 `fonts-ubuntu`、`fonts-noto-core`、`fonts-noto-cjk`、`fonts-noto-color-emoji`、`fonts-dejavu-core`、`fonts-liberation2`，并通过 `/etc/fonts/local.conf` 设定标准 `sans-serif` / `serif` / `monospace` / `system-ui` 优先序。

---

## 1. 构建镜像

在 `chromium_patch` 根目录执行：

```bash
sudo docker build -f container/Dockerfile -t chromium-linux-desktop:157 .
```

---

## 2. 运行端到端桌面与反检测验收

将编译好的 `out/Release` 目录只读挂载到容器 `/opt/chrome`：

```bash
CHROMIUM_RELEASE_DIR="$HOME/.cache/chromium-build/src/out/Release"
NODE_BIN="$(command -v node)"

sudo docker run --rm \
  --cpus=8 --memory=8g --shm-size=1g \
  -e TZ=America/New_York \
  -e PROBE_NO_SANDBOX=1 \
  --mount "type=bind,src=$CHROMIUM_RELEASE_DIR,dst=/opt/chrome,readonly" \
  --mount "type=bind,src=$NODE_BIN,dst=/usr/local/bin/node,readonly" \
  --mount "type=bind,src=$PWD/scripts,dst=/opt/probe,readonly" \
  chromium-linux-desktop:157 \
  node /opt/probe/verify-desktop.mjs /opt/chrome/chrome /tmp/desktop-verification.json
```

采集单次默认桌面画像快照：

```bash
sudo docker run --rm \
  --cpus=8 --memory=8g --shm-size=1g \
  -e TZ=America/New_York \
  -e INVISIBLE_CHROMIUM_PROFILE='{}' \
  -e PROBE_NO_SANDBOX=1 \
  -e 'PROBE_BROWSER_ARGS=["--use-gl=angle","--use-angle=gl"]' \
  --mount "type=bind,src=$CHROMIUM_RELEASE_DIR,dst=/opt/chrome,readonly" \
  --mount "type=bind,src=$NODE_BIN,dst=/usr/local/bin/node,readonly" \
  --mount "type=bind,src=$PWD/scripts,dst=/opt/probe,readonly" \
  chromium-linux-desktop:157 \
  node /opt/probe/probe.mjs /opt/chrome/chrome /tmp/desktop-snapshot.json
```
