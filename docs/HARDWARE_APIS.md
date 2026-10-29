# Chromium Linux：硬件与显示 API 调查

日期：2026-10-29。源码基线为 Linux stable **156.0.8078.73**，提交 **2f9a11097447f226133bc1a31c787291a5eeab98**；V8、ANGLE、Dawn、Skia 和 WebRTC 按该版 DEPS 固定。详细实现和行号见各专题报告。

## 调查结果

硬件关联信息分成三组：直接身份和容量声明、真实显示/设备状态、计算与渲染的实际输出。首版适合减少第一组细节，第二组由真实 Linux 运行环境保持一致，第三组保留正常执行。

| 类别 | 网页可用入口 | 当前实现与数据关联 | 首版处理 |
| --- | --- | --- | --- |
| CPU 并发 | `navigator.hardwareConcurrency`，包括各类 Worker | 直接读系统逻辑处理器数量，默认不分档 | 公共 native 数据源返回配置值 |
| CPU 性能分类 | `navigator.cpuPerformance` | SecureContext、Window-only、stable；Browser 用处理器数与 CPU 型号计算 0–4 档 | 与声明线程数一起配置 |
| 物理内存档 | `navigator.deviceMemory` | SecureContext，Window/Worker；Linux 已分为 2/4/8/16/32 GiB | 统一配置到常见内存档 |
| HTTP 内存声明 | `Sec-CH-Device-Memory`、旧 `Device-Memory` | 导航与子资源各有数据路径，按 Client Hints 规则发送 | 与 JS 内存声明同步 |
| JS 内存 | `performance.memory`、`measureUserAgentSpecificMemory()` | 实际 V8/DOM/Canvas 占用；heap limit 与实际 RAM 初始化有关；site-locked Renderer 的 memory 并非总是粗桶 | 保留动态占用，核对配置对应的真实 heap limit |
| CPU 负载与执行 | `PressureObserver`、JS/Wasm/Worker 计算、计时 | Linux 压力接口已 stable，读取系统负载并做分类与隐私处理；计算吞吐来自实际执行 | 首版保留；压力权限另按运行配置管理 |
| 磁盘与存储 | Storage / StorageBucket estimate、旧 quota API | 156 默认已报告 usage + 10 GiB；内部磁盘配额另有逻辑 | 沿用原版报告与实际存储行为 |
| 网络状态 | `navigator.connection`、相关事件/请求头 | 实际 NQE 网络状态，RTT/downlink 已量化和随机化；type/downlinkMax 非普通 Linux 默认开放集合 | 保留正常网络状态 |
| 电池 | `getBattery()`、BatteryManager 事件 | Linux UPower 的电量/充放电/时间；无需设备 chooser | 首版保留正常桌面状态，可独立配置桌面接电视图 |
| 屏幕与窗口 | `screen.*`、outer/inner size、screenX/Y、DPR、VisualViewport、orientation | XRandR/Wayland → Display/ScreenInfo → widget/renderer；与实际布局、缩放和窗口行为关联 | 配置实际桌面与窗口，保留这套原生数据链 |
| CSS 显示能力 | device dimensions、resolution、color、color-gamut、dynamic-range、viewport units | 与 ScreenInfo、DPR、viewport、compositor 和桌面偏好关联 | 与真实显示和渲染配置一致 |
| 多屏 | `screen.isExtended`、`getScreenDetails()` | isExtended 受 policy 控制但读取本身不弹授权；完整列表、型号标签需 window-management 许可 | 复用原有权限；单屏环境从运行器实际建立 |
| 刷新与输入时序 | document rAF、具备有效 BeginFrameProvider 的 DedicatedWorker rAF、输入事件、performance timestamps | 实际 BeginFrame、系统/浏览器调度；CSS update 只是分类，并非 Hz getter | 保留调度，记录实际显示环境 |
| 鼠标/触屏 | maxTouchPoints、pointer/hover CSS、PointerEvent 压力/倾斜等 | 设备枚举与输入事件；persistentDeviceId 为 Blink 重映射编号 | 保留普通 Linux 桌面设备能力和输入链 |
| GPU 标识 | WebGL debug renderer info；WebGPU adapter/device info | WebGL unmasked 字符串可含 GPU/ANGLE/驱动；WebGPU 精确 device/description 默认已为空 | 下一组处理 WebGL 精确 identity；WebGPU 复用已有裁减 |
| GPU 能力 | WebGL limits/extensions/precision、WebGPU features/limits/subgroups | 与实际 GPU/backend 能力关联；WebGPU limits 默认已 tiering，timestamp 已量化 | 首版保留实际能力 |
| 图形与文本输出 | Canvas/OffscreenCanvas/readPixels、measureText、DOM/Range 几何、字体匹配 | Linux 字体、fontconfig、HarfBuzz、Skia、ANGLE/Dawn、颜色空间共同决定 | 保留真实输出；需要统一环境时固定实际字体和配置 |
| 字体枚举 | `queryLocalFonts()`，以及无需此许可的普通字体匹配 | 前者有 secure/policy/permission/activation 等条件；字体存在性与度量是独立入口 | 保留正常授权与 Linux 字体环境 |
| 音频 | AudioContext 采样率/通道/latency、OfflineAudioContext/Analyser/Worklet | 实时音频关联 sink；离线输出关联 DSP/CPU 路径和调用者采样率 | 保留实际音频运行；统一环境时配置实际 sink |
| 媒体能力 | canPlayType、MediaCapabilities、WebCodecs、RTC codecs/stats | codec 构建选项、软/硬件加速能力、性能记录和实际媒体执行 | 保留真实编解码；RTC 硬件名称已有 capture 门控 |
| 摄像头/麦克风/屏幕捕获 | enumerateDevices、track settings/capabilities、getDisplayMedia | 未授权设备信息已裁减；授权 ID 已 HMAC；捕获属性来自真实 source | 沿用授权、枚举、选择和实际 capture |
| 语音 | speechSynthesis voices | 本机/扩展/远端 TTS 服务及语言包 | 保留实际 Linux 语音环境 |
| 输入布局 | keyboard.getLayoutMap | 桌面键盘布局，检查 keyboard-map policy，无设备 chooser | 与实际输入和语言环境一致 |
| USB/HID/Serial/MIDI | getDevices/getPorts/requestMIDIAccess | 已授权列表或许可后会话；包含实际外设属性 | 沿用正常权限流程 |
| 传感器 | Generic Sensor、deviceorientation/devicemotion | 实际 Linux 传感器；基本 sensors 内容设置默认 ALLOW，额外类有 feature gate | 按正常权限与设备缺失语义运行 |
| 手柄 | getGamepads/events/haptics | 实际设备 ID、轴、按钮、反馈能力，有交互和可见性门槛 | 沿用正常设备行为 |
| 架构信息 | UA-CH architecture/bitness/model 等 | 浏览器平台/ABI 元数据，不是裸 CPU 型号；无需设备 chooser | 保留真实 Linux x86_64 等平台信息 |
| XR | isSessionSupported、XR session/display 参数 | stable；immersive 支持查询关联 XR runtime/设备；inline 直接支持 | 沿用正常 Linux 硬件支持结果 |
| ML 加速 | WebNN createContext/deviceType/opSupportLimits | 此版源码默认未启用；开启后关联 CPU/GPU/NPU 后端 | 保留默认 feature 集合 |
| 折叠/区段/屏幕键盘 | devicePosture、viewport.segments、virtualKeyboard.boundingRect | Linux posture 默认 continuous；其余来自 widget 区段和键盘 overlay | 保留普通桌面默认状态 |

## 关键交叉路径

1. **CPU 是两项身份。**hardwareConcurrency 和 cpuPerformance 分别有网页 getter 与 Browser 分类数据源；只改逻辑处理器数仍会保留宿主的性能档位。Window-only 的 cpuPerformance 与 Worker 不同，测试按各自暴露范围执行。
2. **内存是 JS 与 HTTP 的共同声明。**Browser 导航请求、Renderer 子资源请求和 Navigator getter 都使用 approximated memory；配置须在各进程初始化前到达。V8 heap limit 则要单独核对，实际 used/total 保留动态分配。
3. **显示是整条坐标链。**screen、CSS、DPR、window/viewport、截图和点击不能各自写一套值。首版通过真实 Linux 桌面与 widget 配置得到一致结果。
4. **GPU identity 和实际能力分别处理。**WebGL 字符串可以减少细节；limits、shader、codec、像素和 WebGPU 执行仍使用实际硬件能力。
5. **默认暴露与授权/实验接口分别记录。**传感器、keyboard map、多屏布尔状态等与完整设备 chooser 不同；WebNN、HDR 扩展、Linux Bluetooth 等按固定 tag 的实际 feature 状态记录。

## 与 Firefox 实际改动对照后的补充

对照从原始 Firefox 改动账本和当前 Firefox 159 实现出发。原账本包含 440 文件、642 个 hunk；三篇专题显式引用其中 150 个不同 hunk，另列 Chromium 自身新增的入口。完整索引见 [firefox-crosswalk-index.json](../evidence/firefox-crosswalk-index.json)。

| 此前遗漏或未展开的组 | 具体入口与关系 | 实施归属 |
| --- | --- | --- |
| 语言与时区全链 | Accept-Language、Navigator、Intl、Date、lastModified、原生表单、字体 fallback，以及 Worker/Worklet 初始状态 | 启动前设实际 locale、TZ 和 profile；一身份一 browser process |
| native 日期路径 | `document.lastModified` 在 Linux 使用 libc `localtime_r`，CDP 时区覆盖修改的是 ICU/V8 | 进程 TZ 与浏览器时区统一；以后支持同进程多时区时才需接 native |
| 完整桌面状态 | GTK 颜色/主题/系统字体、文字缩放、控件、XInput、窗口管理、focus/visibility/occlusion | 容器提供桌面；Python 后端负责实际窗口激活和坐标转换 |
| 图形的独立出口 | translated shader、GPU timer queries、context 创建及 fallback、PBO、ImageBitmap/Offscreen/WebGPU 读回 | 实际 GPU/软件 backend；保留原生执行与输出 |
| 媒体和语音生命周期 | 枚举首次/缓存/并发调用、devicechange、真实 sink/capture、voiceschanged、实际语音引擎 | 容器运行音频和 TTS 服务；后端接原生事件 |
| 浏览器功能组合 | EME/CDM、PDF/plugins、codec、storage partition/persistence/OPFS | 浏览器构建和实际 profile/volume；与 Linux 构建的功能一致 |
| 网络独立路径 | RTC ICE/SDP/stats、STUN/TURN DNS、QUIC、系统 NetworkContext、退出子进程 | 容器路由与 DNS；需要代理时分别处理 HTTP auth 和 SOCKS auth |
| 自动化执行语义 | CDP domain、isolated world、Error/console 序列化、user activation、输入 timestamp/ACK | Python CDP 后端对接 Chromium 已有能力 |

几个影响架构的具体结论：

- Chromium 的 headed + 非零 CDP 端口启动路径不设置 `AutomationControlled`。`headless`、pipe 和 port=0 有不同源码分支。
- 原版 SOCKS5 greeting 只有 NO_AUTH；Fetch 域的 HTTP proxy auth 不会增加 SOCKS5 认证支持。
- Firefox 的 Windows 字体/度量、DWrite、DirectX shader、任务栏和平台声明不迁入 Linux 方案；使用真实 Linux 的字体、窗口和图形链。
- 输入、文件选择器、CSP 和网络拦截已有 CDP 能力，新增工作主要在 Python 后端；humanize 继续属于共享 Python 动作层。

逐项实现与源码位置见 [身份/区域/显示/输入](firefox-comparison-identity.md)、[图形/字体/媒体](firefox-comparison-render.md)、[自动化/网络](firefox-comparison-automation-network.md)。

## 本机原版运行记录

使用本机已有 Chrome for Testing **156.0.8078.4**，Linux x86_64、X11/Xvfb 1920×1080×24、1280×800 浏览器窗口。浏览器未使用 getter 覆写。该机器的 AppArmor/user namespace 配置使原始启动报 No usable sandbox，本轮观测启动显式记录了 `--no-sandbox`。运行快照不是 `.73` 原生构建结果。

| 观测 | 值 |
| --- | --- |
| Window hardwareConcurrency / deviceMemory / cpuPerformance | 48 / 32 / 4 |
| DedicatedWorker、ServiceWorker | hardwareConcurrency=48、deviceMemory=32；无 cpuPerformance 属性 |
| screen | 1920×1080、24 bit、单屏 |
| outer / inner / DPR | 1280×800 / 1280×657 / 1 |
| storage estimate | 10 GiB，usage=0 |
| JS heap limit | 4,395,630,592 bytes |
| rAF | 30 个间隔，中位约 16.7 ms |
| sensors permission query | accelerometer / gyroscope / magnetometer 为 granted；不等于机器实际有这些传感器 |
| window-management / local-fonts / camera / microphone | prompt |
| WebGL / WebGPU | 该虚拟显示环境未取得 context / adapter；GPU 功能结论来自固定源码 |

完整结果含浏览器 revision、启动参数和宿主资源信息，见 [JSON](../evidence/stock-cft-156.0.8078.4.json)。

## Docker 桌面实际运行

已使用现有 Docker 构建 Ubuntu 24.04 + Xvfb + Openbox + Mesa + PulseAudio + speech-dispatcher 镜像并运行上述原版浏览器。容器限额为 8 CPU、8 GiB，使用独立显示、profile 和进程；镜像用 `ubuntu:24.04` 标签。安装和运行命令见 [容器文档](CONTAINER.md)。

| 观测 | 实际结果 |
| --- | --- |
| 容器限额 / 网页硬件声明 | 8 CPU、8 GiB / HC=48、deviceMemory=32、cpuPerformance=4；Worker/SW 同样为 48/32 |
| UA / 平台 / webdriver | 原版 Linux UA、Linux x86_64、false；headed + 非零本地 CDP 端口 |
| 显示 / 窗口 / 输入能力 | screen 1920×1080×24、outer 1280×800、inner 1272×653、DPR 1；pointer fine / hover、touch=0 |
| focus / visibility / rAF | true / visible / 中位约 16.7 ms |
| WebGL1/2 | Mesa llvmpipe，经 ANGLE OpenGL；真实 shader 编译成功；maxTextureSize=16384 |
| WebGPU | 此软件桌面配置无 adapter |
| 音频 | 实际 PulseAudio 48 kHz、双声道；采样时 context 为 suspended |
| 区域与时区 | en-US / America/New_York；Date 与 Last-Modified 均把 UTC 12:00 转为当地 07:00 |

CPU/RAM 的实际观测与源码一致：Docker cgroup 限额没有改变这些网页 getter 的宿主数据源。图形则已从上一轮单独 Xvfb 的 null context 改为可运行的实际 Mesa 软件 GL。详细快照见 [Docker 运行记录](../evidence/container-desktop-cft-156.0.8078.4.json)。

## 首版 native 开发切口

第一组补丁已实现 **CPU/RAM 声明**：共同网页可见 HC、Browser CPU tier、公共 approximated memory，以及导航/子资源 Client Hints。用每 browser process 的不可变配置作为数据源，renderer 与各类 Worker 在第一段网页脚本之前得到配置。普通 Linux 桌面样例可从 8 线程、8 GiB、high CPU tier 开始，具体档位为显式配置。

实现仅调整网页声明入口；系统 CPU/内存查询仍供线程池、调度和真实资源管理使用。8 GiB 以上的 Linux 64-bit V8 默认已处于同一 old-generation 上限档，先用实际 heap limit 核对这组选择。

第二组补丁选择 **GPU identity**：WebGL1/2 与 Worker Offscreen 的 unmasked vendor/renderer 统一处理，保留真实厂商/backend 与执行能力，减少精确型号/驱动文本；与 WebGPU 默认 metadata 一起对照。

显示、字体和音频先由真实运行环境决定。窗口与显示参数从 native 读回成为会话状态。CDP 输入 x/y 使用 viewport CSS px；截图 Page.Viewport clip 为 DIP，后端按实际页面 zoom 与输出缩放转换。

## 验证状态与后续工作

- 已完成同版本自构建浏览器在配置关闭、默认开启、自定义值三种状态下的对照，覆盖 Window、同源 iframe、真实 OOPIF、Dedicated/Nested/Shared/ServiceWorker 首段读取，以及跨站导航与返回。
- 已完成 JS 内存与导航/子资源两种 Client Hints 的 opt-in 对照；三组实际 heap limit 均为 4,395,630,592 bytes。
- 已取得自构建浏览器的 Linux UA/UA-CH、真实桌面、WebGL 和音频快照。CPU/RAM 声明按配置生效，完整结果见 [原生实现与验证](NATIVE.md)。
- 后续补充持久 profile 重启、内存 CH policy delegation，以及页面缩放、截图尺寸与点击位置联动。
- 下一组原生修改处理 WebGL1/2、OffscreenCanvas 与 WebGPU metadata/能力/简单渲染对照。
- Python CDP 后端和 GitHub Release 安装按各自仓库继续实现，浏览器原生层独立构建、发版。

## 专题实现依据

- [CPU、内存、存储、网络、电池、传感器与外设](cpu-devices.md)
- [显示、窗口、CSS、DPR、多屏与输入](display.md)
- [GPU、字体、音频、媒体、RTC](render-media.md)
- [WebNN、WebXR、DevicePosture、区段与屏幕键盘](additional.md)

源码盘点、Firefox 实际改动对照和 Docker 桌面运行已完成。CPU/RAM 原生补丁已完成完整浏览器构建、5 项单元测试和三组 Docker 功能验证；配置、构建与运行记录见 [NATIVE.md](NATIVE.md)。
