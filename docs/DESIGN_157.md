# Chromium 157 从零源码审计与架构重设计

基线版本：Linux Stable **`157.0.8103.50`**（提交 `049750111b1e5c11565c792b2aeed5541f332bad`，V8 `440c1c463e2e528c309af5067952e7b11631507f`）。

本设计不沿用早期 `156` 阶段的假设，而是基于最新 `157` 源码与开发机双路物理 GPU（RTX 2080 Ti）对无卡软件渲染（Mesa `llvmpipe`）的实测差异从头推导。

---

## 1. 真实运行约束与威胁模型

1. **生产环境不一定有物理 GPU**：产物运行在任意云服务器或轻量容器中（通常无 `/dev/dri` 硬件渲染节点，底层依赖 Mesa `llvmpipe` 软件 OpenGL），但对外绝不能暴露 `llvmpipe`、软件光栅化极限参数或 `failIfMajorPerformanceCaveat` 失败。
2. **宿主机规格各异**：宿主机可能是 48/96 核、128 GiB 内存的服务器，也可能是受限容器（需 `--no-sandbox` 启动）。网页读取到的 CPU、RAM、V8 堆上限、窗口内高、屏幕工作区、媒体编解码器、音频设备与字体必须与一台普通 Linux Desktop 完全一致。
3. **零 CDP 与 V8 自动化痕迹**：自动化控制通道不能打开可被本地扫描的端口（支持 `--remote-debugging-pipe`），不能置位 `navigator.webdriver`，不能在开启 `Runtime.enable` 时触发网页埋设的 `Error.stack` 原型链 getter 或 `Proxy` trap，且合成鼠标点击必须符合 W3C `PointerEvent.pressure` 规范。

---

## 2. 从头源码审计发现的七处关键破绽（早期方案遗漏或误判）

| 编号 | 破绽现象 | 上游 C++ 源码根因 | 157 新方案根治方式 |
| --- | --- | --- | --- |
| **1** | **缺失 H.264 / AAC 视频播放能力** | 开源默认 `proprietary_codecs = false`，导致 `canPlayType('video/mp4; codecs="avc1.42E01E"')` 返回空串，与主流桌面发行版 Chromium 不符 | 在 [`build/linux-release.gn`](../build/linux-release.gn) 开启 `proprietary_codecs = true` 与 `ffmpeg_branding = "Chrome"`，保留真实 `Chromium` 品牌同时具备完整媒体解码 |
| **2** | **`--no-sandbox` 与 `--enable-speech-dispatcher` 触发顶部黄条警告并暴露 13,363 个语音** | `chrome/browser/ui/startup/bad_flags_prompt.cc` 的 `kBadFlags[]` 同时包含 `kNoSandbox` 与 `kEnableSpeechDispatcher`，弹出警告栏挤压 `window.innerHeight`；且原版 Linux Chromium 默认不开启 speech-dispatcher（`getVoices()` 为 `[]`） | 容器移除 `--enable-speech-dispatcher`；C++ 在 `WebHardwareProfile` 激活时直接跳过 `ShowBadFlagsPrompt` 与 `IsAutomationEnabled` 横幅，彻底保证 `outerHeight - innerHeight` 为原生工具栏高度 |
| **3** | **仅改 WebGL renderer 字符串仍被识别为 `llvmpipe` 软件渲染** | 实测对比物理 GPU 与 `llvmpipe`（见 [`gpu-reference-comparison.json`](../evidence/gpu-reference-comparison.json)）发现：`llvmpipe` 暴露出独有的 `ALIASED_LINE_WIDTH_RANGE=[1, 255]`、`MAX_ELEMENTS_INDICES=3000`、`MIN/MAX_PROGRAM_TEXEL_OFFSET=-32/31`、`UNIFORM_BUFFER_OFFSET_ALIGNMENT=16`、`MAX_SAMPLES=4` 及着色器 `LOW_INT=[15, 14, 0]` | 在 `WebGLRenderingContextBase` 与 `WebGL2RenderingContextBase`（覆盖主线程与 Worker `OffscreenCanvas`）同步将上述参数、整数精度与 MSAA 能力对齐到标准 Linux Mesa Intel Desktop（`UHD Graphics 630, OpenGL 4.6`），并在 `RenderbufferStorageHelper` 中对 `samples <= 8` 做底层硬件安全钳制；同时在 `gpu_util.cc` / `service_utils.cc` 自动放行 blocklist，免除 `--ignore-gpu-blocklist` 启动参数；确认 Linux 原版 `kWebGPUService` 默认即为关闭（`requestAdapter() === null` 与真机完全一致） |
| **4** | **`--remote-debugging-pipe` 置位 `navigator.webdriver = true`** | `content/child/runtime_features.cc:348` 将 `switches::kRemoteDebuggingPipe` 映射到 `EnableAutomationControlled(true)` | 在 `runtime_features.cc` 中当硬件 Profile 激活且非 `--headless` 时保持 `EnableAutomationControlled(false)`，解锁零 TCP 端口的匿名管道控制 |
| **5** | **CDP 鼠标点击 `pointerdown.pressure === 0`** | `content/browser/devtools/protocol/input_handler.cc:499` 写成 `mouse_event->force = force.value_or(0)`（`0.0f` 而非硬件鼠标的 `quiet_NaN()`），导致 `pointer_event_factory.cc:69` 在 `buttons=1` 时返回 `pressure=0` 而非规范要求的 `0.5` | 将缺省 `force` 修正为 `std::numeric_limits<float>::quiet_NaN()`，使按下左键时自动产出规范的 `pressure = 0.5`，释放时为 `0` |
| **6** | **V8 `Runtime.enable` 触发原型链 `Error.stack` getter、`Proxy` 与 DOM getter** | `v8/src/inspector/value-mirror.cc:279` 的 `getErrorProperty` 仅检查实例自身 `GetOwnPropertyDescriptor`，子类或原型上的 `get stack()` 仍被直接调用；且 `v8-console-message.cc` 对 `console.table`/`console.log(div)` 做预览包装会触发 `Proxy` 与 DOM 属性读取 | 在 `value-mirror.cc` 遍历完整原型链拦截非内置 getter 与 `Proxy`；在 `v8-console-message.cc` 对 `console.*` 中的对象参数使用零副作用摘要包装，并在 `v8-runtime-agent-impl.cc` 避免默认开启未捕获异常栈收集 |
| **7** | **桌面无面板（`availHeight === height`）、无麦克风输入与字体回退异常** | 裸 Openbox 未设置 `_NET_WORKAREA` 边距；PulseAudio 仅加载 null-sink 无非 monitor 输入源；缺少桌面 fontconfig 优先族导致 `body` 落回 `"Times New Roman"` | 容器 Openbox 配置底部 36px 面板边距（`availHeight = 1044 < 1080`）；PulseAudio 增加 `module-remap-source` 虚拟麦克风（枚举出 `audioinput` + `audiooutput`）；配置 Ubuntu + Noto + CJK + Emoji 标准桌面字体栈 |

---

## 3. WebGL 跨环境一致性设计细节

为什么默认桌面 GPU 画像选择 **Linux Mesa Intel (`Google Inc. (Intel)` / `ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)`)**？

1. **着色器翻译字节级同源**：无论是真机 Linux Intel/AMD Mesa 还是无卡容器内的 Mesa `llvmpipe`，在 X11 `--use-gl=angle --use-angle=gl` 下均走 ANGLE Desktop OpenGL 后端，`WEBGL_debug_shaders.getTranslatedShaderSource()` 原生输出完全相同的 `#version 450` GLSL（而非 Vulkan SPIR-V 十六进制转储或 Windows HLSL）。
2. **核心纹理上限天然吻合**：Intel Gen9/Gen12 Mesa 的真实硬件 `MAX_TEXTURE_SIZE`、`MAX_CUBE_MAP_TEXTURE_SIZE`、`MAX_RENDERBUFFER_SIZE` 均为 `16384`，`MAX_3D_TEXTURE_SIZE` 为 `2048`，与 `llvmpipe` 原生上限完全相等（若运行在 `32768` 上限的 NVIDIA 服务器上，C++ 初始化时自动向下钳制到 `16384` / `2048`，既不越界也不泄露服务器显卡规格）。
3. **软件渲染特征点精准消隐**：
   - `ALIASED_LINE_WIDTH_RANGE`: `[1, 255]` → `[1, 7.375]`
   - `ALIASED_POINT_SIZE_RANGE`: `[1, 256]` → `[1, 255]`
   - `MAX_VARYING_VECTORS` / `MAX_VARYING_COMPONENTS`: `32` / `128` → `31` / `124`
   - `MAX_ELEMENTS_VERTICES` / `MAX_ELEMENTS_INDICES`: `3000` → `1048576`
   - `MIN_PROGRAM_TEXEL_OFFSET` / `MAX_PROGRAM_TEXEL_OFFSET`: `-32` / `31` → `-8` / `7`（合法子集）
   - `MAX_TEXTURE_LOD_BIAS`: `16` → `15`
   - `UNIFORM_BUFFER_OFFSET_ALIGNMENT`: `16` → `max(actual, 64)`（64 的倍数天然满足底层 16 字节对齐要求）
   - `MAX_SAMPLES` & `getInternalformatParameter(GL_SAMPLES)`: `4` → `8` / `[8, 4]`（`RenderbufferStorageHelper` 内部自动钳制到底层最大采样数，调用 `renderbufferStorageMultisample(..., 8, ...)` 零 GL 错误）
   - `VERTEX_SHADER` / `FRAGMENT_SHADER` 的 `LOW_INT` 与 `MEDIUM_INT` 精度：`[15, 14, 0]` → `[31, 30, 0]`
