# Chromium 156.0.8078.73 补充 API 清单

固定 SHA：`2f9a11097447f226133bc1a31c787291a5eeab98`。以下是源码开放条件与硬件关联，纳入 inventory；不扩展首版 patch 范围。

## WebNN

入口：`navigator.ml.createContext({deviceType:"cpu"|"gpu"|"npu"})`；随后 `context.opSupportLimits()`、graph/tensor 操作。

Linux 开放条件：SecureContext；Window 与 DedicatedWorker；runtime `MachineLearningNeuralNetwork` 本身无 stable status，由 `kWebMachineLearningNeuralNetwork` 开启，该 base feature 源码默认 false，所以普通 Linux 构建默认不开放。createContext 还检查 `webnn` Permissions Policy。

硬件关联：deviceType 是请求的执行设备类别，不是硬件型号枚举。启用后上下文创建成功/失败、支持的算子/类型/shape限制与运行结果关联后端及硬件。Linux 构建包含 TFLite / LiteRT 路径，可有 CPU 或 GPU 后端；此调查不把支持枚举值 npu 等同于 Linux 一定能创建 NPU context。

源码：[navigator_ml.idl:7](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/ml/navigator_ml.idl#7)、[ml_context_options.idl:9](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/ml/ml_context_options.idl#9)、[runtime_enabled_features.json5:4094](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/platform/runtime_enabled_features.json5#4094)、[features.mojom:10](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/services/webnn/public/mojom/features.mojom#10)、[runtime_features.cc:283](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/child/runtime_features.cc#283)、[ml.cc:241](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/ml/ml.cc#241)、[ml_context.idl:351](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/ml/ml_context.idl#351)、[features.gni:10](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/services/webnn/features.gni#10)、[webnn_context_provider_impl.cc:567](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/services/webnn/webnn_context_provider_impl.cc#567)。

## WebXR

入口：`navigator.xr.isSessionSupported("inline"|"immersive-vr"|"immersive-ar")`；获准会话后的视图、输入与空间数据。

Linux 开放条件：WebXR runtime stable；SecureContext、Window。支持查询本身没有用户 chooser；immersive 查询检查 `xr-spatial-tracking` 对应策略，requestSession 是后续独立步骤。

硬件关联：inline 直接 resolve true；immersive-ar 还检查 AR feature/settings；immersive 模式经 Browser XR service 的 SupportsSession 查询实际 runtime/硬件，有无头显/AR能力会影响布尔值。无 service 返回 false。接口存在与宿主拥有头显是两件不同的事。

源码：[navigator_xr.idl:10](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/xr/navigator_xr.idl#10)、[runtime_enabled_features.json5:7441](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/platform/runtime_enabled_features.json5#7441)、[xr_system.cc:932](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/xr/xr_system.cc#932)。

## Device Posture

入口：`navigator.devicePosture.type` / change。

Linux 开放条件：DevicePosture stable；SecureContext、Window，无硬件 chooser。

硬件关联：反映连续屏/折叠姿态。在 Linux，该源码选择 Default provider，其 current_posture 初始化为 continuous，start/stop listening 为空；并不默认读取 Linux 折叠铰链传感器。Windows/Android 有单独 provider。

源码：[runtime_enabled_features.json5:2349](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/platform/runtime_enabled_features.json5#2349)、[navigator_device_posture.idl:5](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/device_posture/navigator_device_posture.idl#5)、[device_posture_platform_provider.cc:19](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/browser/device_posture/device_posture_platform_provider.cc#19)、[device_posture_platform_provider.h:58](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/browser/device_posture/device_posture_platform_provider.h#58)、[device_posture_platform_provider_default.cc:15](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/browser/device_posture/device_posture_platform_provider_default.cc#15)。

## Viewport Segments

入口：`window.viewport.segments`；关联 CSS viewport-segment 环境变量/媒体查询。

Linux 开放条件：ViewportSegments stable；Window。getter 对非 outermost main frame 返回 nullopt。

硬件关联：从 FrameWidget::ViewportSegments 取显示区段矩形，再按 device scale 与页面 zoom 转成 CSS 坐标；关联折叠屏铰链/分割区域的 Browser display 配置。普通桌面应保留单连续显示区段的上游行为。

源码：[runtime_enabled_features.json5:6851](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/platform/runtime_enabled_features.json5#6851)、[window.idl:152](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/window.idl#152)、[dom_viewport.cc:25](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/dom_viewport.cc#25)。

## Virtual Keyboard

入口：`navigator.virtualKeyboard.boundingRect`、overlaysContent、geometrychange，show/hide。

Linux 开放条件：SecureContext、Window；navigator 属性没有额外 RuntimeEnabled gate；show 要页面已有用户交互。

硬件关联：boundingRect 来源为当前 Frame 的 VirtualKeyboardOverlayRect；表示系统屏幕键盘占用/覆盖区域，关联输入法与触屏环境。默认创建空 DOMRect，再接实际 overlay rect，并不枚举物理键盘厂商或序列号。

源码：[navigator_virtual_keyboard.idl:12](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/virtualkeyboard/navigator_virtual_keyboard.idl#12)、[virtual_keyboard.cc:46](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/virtualkeyboard/virtual_keyboard.cc#46)、[virtual_keyboard.cc:133](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/virtualkeyboard/virtual_keyboard.cc#133)。

