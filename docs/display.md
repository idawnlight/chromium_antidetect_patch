# Chromium 156：显示、窗口与输入设备网页接口

源码版本：Linux stable `156.0.8078.73`，提交 `2f9a11097447f226133bc1a31c787291a5eeab98`。以下结论来自该提交的 C++、IDL 和协议实现；没有使用 main 分支文档作为实现依据。本报告完成了源码调研，没有修改浏览器产品代码。

## 结论与首版选择

显示信息不是 `screen.width` 一个 getter。Chromium 已经通过 `ScreenInfo` 把屏幕矩形、可用区域、缩放、颜色空间、色深、方向、多屏信息传到 renderer，DOM、CSS 与部分渲染配置共同读取它。首版保留正常 Linux 桌面时，直接保留这条链最合适；运行器可以配置实际虚拟桌面/窗口大小，再从浏览器读取结果形成 profile。

具体分为：

| 部分 | 首版处理 | 原因 |
|---|---|---|
| 屏幕大小、可用区域、窗口大小/位置、DPR、viewport、方向 | 保留真实；自动化环境需要固定时，配置实际桌面与窗口 | 与布局、截图、点击、弹窗、多屏移动共用坐标和缩放，不能只改网页 getter |
| 色深、CSS 色域、HDR | 保留实际正常 Linux 输出；后续可以增加一致的 sRGB/SDR 模式 | `ScreenInfo.display_color_spaces` 同时关联 CSS 能力与 compositor 输出 |
| 鼠标/触控板/触屏能力、`maxTouchPoints` | 普通无触屏 Linux 桌面通常自然得到 fine/hover/0；先保留 | 这些值既来自设备枚举，也控制触摸接口暴露和 CSS，需作为一组处理 |
| 多屏型号标签、内置/外接属性 | 沿用原有 `window-management` 权限；将来可统一配置该权限下的视图 | 无权限页面拿不到完整 `ScreenDetailed` 列表，权限内才有显示器标签 |
| rAF、输入事件到达频率 | 首版保留调度 | 时间来自 BeginFrame/实际调度；写死某个屏幕频率字段不会改变这些观测结果 |
| HDR headroom/色度坐标实验接口 | 保持默认 feature 状态 | `.73` 中 `ScreenDetailedHdrHeadroom`、`CanvasHDR` 为 experimental，不能当作稳定默认 API |

如果以后要提供可配置显示身份，建议先设计单个 `DisplayProfile`，把 Screen、CSS、ScreenDetailed 和变化事件全部纳入。不能把 `RenderWidgetHostViewBase` 的 `ScreenInfo` 随意改成另一套数值：这个对象也参与 compositor 缩放和窗口/弹窗行为。纯粹改暴露值时应区分 web-facing 数据和真实渲染数据；需要实际缩放时应完整设置底层桌面、widget 和 compositor。

## 从 Linux 到网页的实际数据链

```text
Linux X11/XRandR / Wayland output 与桌面配置
  → display::Display（bounds/work_area/scale/color/depth/label/rotation）
  → display::Screen::GetScreenInfosNearestDisplay()
  → RenderWidgetHostViewBase::UpdateScreenInfo()
  → RenderWidgetHostImpl visual properties / 跨进程 frame connector
  → Blink WidgetBase / WebFrameWidgetImpl
  → ChromeClient::GetScreenInfo(s)
  → Screen / ScreenDetailed / ScreenOrientation / MediaValues
```

代表性源码：

- [X11 显示器枚举与 EDID/色深/刷新率](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/ui/base/x/x11_display_util.cc)：`BuildDisplaysFromXRandRInfo()` 中，标签来自内置显示器名称或 EDID display name；约 480–521 行设置 label、color spaces、depth、depth_per_component、display_frequency；约 538 行应用 device scale。
- [WaylandScreen::OnOutputAddedOrUpdated](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/ui/ozone/platform/wayland/host/wayland_screen.cc)：约 220–277 行使用 compositor 提供的 logical size、origin、scale、颜色空间和 description。Wayland 与 X11 不保证产生完全相同的窗口坐标行为。
- [DisplayUtil::DisplayToScreenInfo](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/ui/display/display_util.cc)：15–60 行复制 bounds、work area、缩放、色深、方向、屏幕数量、内外置属性、刷新率和 label。
- [Screen::GetScreenInfosNearestDisplay](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/ui/display/screen.cc)：187 行起枚举全部 display，指定 current/primary display。
- [RenderWidgetHostViewBase::UpdateScreenInfo](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/browser/renderer_host/render_widget_host_view_base.cc)：527 行起更新，613 行通知 host；970 行从 `display::Screen` 获取信息。571–589 行对支持按窗口缩放的 Ozone 平台采用 window scale。
- [WidgetBase::UpdateSurfaceAndScreenInfo](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/platform/widget/widget_base.cc)：约 1882–1931 行更新 renderer 的屏幕信息和 compositor 颜色空间。
- [WebFrameWidgetImpl::DidUpdateSurfaceAndScreen](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/web_frame_widget_impl.cc)：5518 行起更新 device scale 对应的 zoom、Screen 实例、ScreenDetailed、CSS 色域以及变化事件，再向 remote frame 传播。
- [CrossProcessFrameConnector](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/browser/renderer_host/cross_process_frame_connector.cc)：207 行保存 visual_properties.screen_infos，317 行返回；跨进程 iframe 也存在这条数据链。

Wayland 的一个具体差异：[GetCursorScreenPoint](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/ui/ozone/platform/wayland/host/wayland_screen.cc) 371 行注释并实现了“没有全局 surface/pointer 坐标时以顶层窗口原点为零、使用当前窗口局部光标位置”的行为。因此不能用 X11 的 `screenX/screenY` 预期判断正常 Wayland 桌面。

## 无需弹出权限即可读取的页面接口

下表的“页面”包含顶层 document 和 iframe 自己的 Window；同源策略控制父页面能否直接访问其他 iframe，但 iframe 内部脚本仍可读取自己的接口。Screen、Window、VisualViewport、CSS media query、PointerEvent 和 `Navigator.maxTouchPoints` 都是 Window 侧能力，不在 WorkerNavigator 上直接暴露。

| 接口 | 与底层的关系 | `.73` 的具体读取点 |
|---|---|---|
| `screen.width/height` | 当前显示器逻辑矩形；特殊 physical-pixel quirk/text-scale 情况另行缩放 | [screen.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/screen.cc) 100–112、186–199 行，`GetRect(false)` |
| `screen.availWidth/Height/Left/Top` | OS work area，能反映面板/任务栏及多屏偏移 | 同文件 137–160 行，`GetRect(true)` 读 `available_rect` |
| `screen.colorDepth/pixelDepth` | OS/display color depth；没有已知深度时返回 24，pixelDepth 直接复用 colorDepth | 同文件 115–135 行 |
| `window.outerWidth/Height` | 浏览器顶层窗口矩形；不等于页面内容大小 | [local_dom_window.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/local_dom_window.cc) 1675–1744 行，`ChromeClient::RootWindowRect` |
| `window.screenX/Y`、别名 `screenLeft/Top` | 顶层窗口相对桌面的坐标，行为受 X11/Wayland backend 影响 | 同文件 1790–1837 行 |
| `window.innerWidth/Height` | 当前 frame 的 layout viewport，经 layout zoom 调整；iframe 得到自身 viewport | 同文件 1747–1788 行 |
| `window.devicePixelRatio` | renderer 的 device scale、页面 zoom 和 DevTools compositor override 共同形成的比率 | 同文件 1942 行 → [local_frame.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/local_frame.cc) 1950 行 |
| `visualViewport.{width,height,offsetLeft,offsetTop,pageLeft,pageTop,scale}` | 真实 visual viewport / pinch scale；和 inner size、layout viewport 不是同一个量 | [visual_viewport.idl](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/visual_viewport.idl)、[visual_viewport.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/visual_viewport.cc) |
| `screen.orientation.type/angle` | ScreenInfo 里的 orientation；缺失类型时根据屏幕矩形和角度推导 | [screen_orientation_controller.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/screen_orientation/screen_orientation_controller.cc) 111–129 行 |
| `navigator.maxTouchPoints` | 设备枚举的最大触点数量经过 WebPreferences → Settings | [navigator_events.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/events/navigator_events.cc) 47 行，`Settings::GetMaxTouchPoints` |

DPR 的源码表达式是：

```cpp
double ratio = page_->InspectorDeviceScaleFactorOverride();
ratio *= LayoutZoomFactor();
```

它并非简单返回 `ScreenInfo.device_scale_factor`。`WebFrameWidgetImpl::DidUpdateSurfaceAndScreen` 把 screen device scale 传给 `WebViewImpl::SetZoomFactorForDeviceScaleFactor`；[web_view_impl.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/exported/web_view_impl.cc) 2465–2474 行处理 compositor override，2522 行起处理 device/text scale。页面缩放改变 `window.devicePixelRatio` 是原版行为；权限内的 `ScreenDetailed.devicePixelRatio` 则直接读取显示器 device scale，不包含页面 zoom。

## CSS 同时提供的显示与输入设备视图

页面可以通过样式和 `matchMedia()` 查询，通常不需要 secure context、用户手势或权限弹窗。即使不给 JavaScript 调用 `screen`，样式仍可使用这些值。

| CSS media feature / units | 源数据 | 首版处理 |
|---|---|---|
| `width`、`height`、`aspect-ratio`、`orientation`；`vw/vh/svw/svh/lvw/lvh/dvw/dvh` | 实际 viewport/layout，`orientation` 是 viewport 宽高关系，和 `screen.orientation` 含义不同 | 保留布局真值 |
| `device-width`、`device-height`、`device-aspect-ratio`（含旧 min/max 写法） | `ScreenInfo.rect`，physical-pixels quirk 下乘 device scale | 与 Screen 成组处理 |
| `resolution`（dppx/dpi/dpcm）、`-webkit-device-pixel-ratio` | `LocalFrame::DevicePixelRatio()` | 与 DPR 成组处理，页面 zoom 时一起变化 |
| `color`、`monochrome` | `ScreenInfo.depth_per_component`、`is_monochrome` | 与 Screen 色深、输出格式一致 |
| `color-gamut: srgb/p3/rec2020` | 当前 ScreenInfo 的 DisplayColorSpaces，经色域分类；存在 DevTools media override 路径 | 保留正常输出，后续统一 sRGB 需覆盖此处 |
| `dynamic-range`、`video-dynamic-range` | `ScreenInfo.display_color_spaces.SupportsHDR()`；此版本两者使用相同 evaluator | 与实际 SDR/HDR 输出一致 |
| `pointer`、`any-pointer` | Settings 的 primary/available pointer types | 与设备能力、触摸组一致 |
| `hover`、`any-hover` | Settings 的 primary/available hover types | 与鼠标/触控板/触屏组一致 |
| `update: none/slow/fast` | Settings 的 OutputDeviceUpdateAbilityType；不是数值 Hz | 保留 |
| `prefers-color-scheme`、`prefers-contrast`、`prefers-reduced-motion`、`prefers-reduced-transparency`、`forced-colors`、`inverted-colors` | 桌面主题/无障碍首选项与 browser settings/override | 属于系统配置，也可形成环境特征；首版保留 Linux 原生配置 |
| `display-mode`；启用额外 feature 时的 `display-state`、`resizable` | 标签页/PWA/窗口模式；后两者由 `DesktopPWAsAdditionalWindowingControls` 控制 | 保留实际窗口模式及默认 feature 状态 |
| viewport segments/device posture | 有相应配置时反映多段显示/折叠形态；普通 Linux 单屏没有这些额外形态 | 保持普通桌面默认值 |

对应实现：[media_values.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/css/media_values.cc) 109–186 行读 viewport 和屏幕尺寸，195–228 行读 DPR/HDR/色深，352–394 行读 pointer/hover/update/gamut，396–556 行读首选项、窗口和 posture 等；[media_query_evaluator.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/css/media_query_evaluator.cc) 512–542 行处理 dynamic range，545 行起处理 resolution，1113 行起处理 color gamut，1357 行起处理 update。

这些 CSS 查询多数返回粗粒度布尔匹配，但页面可以连续尝试不同 width/resolution 阈值恢复具体数值。CSS 色域查询返回的是能力分类；精确色度坐标是另一个权限/实验接口，见下节。

`display-state` 和 `resizable` 的合法值判断明确检查 `DesktopPWAsAdditionalWindowingControls`，见 [media_query_exp.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/css/media_query_exp.cc) 70–79 行；该 feature 在此提交是 experimental，不能当作稳定默认能力。

`cm/mm/in/pt` 也不直接读取 EDID 的物理尺寸或显示器真实 DPI。[resolution_units.h](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/platform/resolution_units.h) 将 CSS inch 固定为 96 CSS px，其余绝对长度按常数换算；[css_primitive_value.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/css/css_primitive_value.cc) 512–528 行使用这些常数。`resolution: ...dpi` 在屏幕上查询的是 DPR 按 CSS 单位换算的结果，也不等于面板的真实 pixels-per-inch。

## 多屏、显示器型号与 HDR 扩展

`screen.isExtended` 是 secure-context 的只读属性。源码 [screen.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/frame/screen.cc) 171–184 行先检查 `window-management` Permissions Policy；policy 不允许时返回 false，允许时返回真实 `ScreenInfo.is_extended`。**读取它本身没有请求用户许可**，因此普通 HTTPS 页面可能知道是不是多屏，即使没有取得完整屏幕列表。

`window.getScreenDetails()` 的规则和能力：

- [window_screen_details.idl](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/screen_details/window_screen_details.idl) 为 SecureContext 的 Window 方法，不暴露给 Worker。
- [window_screen_details.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/screen_details/window_screen_details.cc) 59–121 行使用 `WINDOW_MANAGEMENT` 权限服务；有 transient activation 才 RequestPermission，无手势则 HasPermission；不是 GRANTED 时抛 NotAllowedError。iframe 还受到权限服务的 Permissions Policy 控制。
- 许可后返回 `screens[]`、`currentScreen`，并有 screenschange、currentscreenchange 等事件；每个 `ScreenDetailed` 继承基本 Screen，并增加 `left/top`、`isPrimary`、`isInternal`、显示器 `devicePixelRatio`、`label`。
- [screen_detailed.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/screen_details/screen_detailed.cc) 104–143 行直接读取该显示器 `ScreenInfo`。label 不是 browser 随机名字，Linux 下可来自 EDID 或 Wayland compositor description。
- [screen_detailed.idl](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/modules/screen_details/screen_detailed.idl) 的 `hdrHeadroom/onhdrheadroomchange` 使用 `ScreenDetailedHdrHeadroom` feature；旧 HDR headroom、RGB primaries、white point 属性使用 `CanvasHDR` feature。二者在 [runtime_enabled_features.json5](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/platform/runtime_enabled_features.json5) 1088、5498 行均为 experimental。默认稳定功能列表不能把这些实验字段算作普遍可读。

`window.open()` 的位置参数、`moveTo/resizeTo`、fullscreen/窗口选择等操作还可以通过实际窗口行为观测桌面边界。未来如提供另一套显示身份，应连同行为和变化通知验证；首版使用实际桌面，沿用浏览器自身窗口实现即可。

## 输入设备接口与事件数据

能力链是另一组数据：

```text
Linux DeviceDataManager 的 mouse/touchpad/touchscreen/pointing-stick
  → ui::GetAvailablePointerAndHoverTypes / MaxTouchPoints
  → SlowWebPreferenceCache → WebPreferences
  → WebViewImpl::ApplyWebPreferences → Blink Settings
  → navigator.maxTouchPoints / CSS pointer、hover / touch feature detection
```

[pointer_device_linux.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/ui/base/pointer/pointer_device_linux.cc) 17–61 行：有 touchscreen 则 available pointer 含 coarse；有启用的 mouse/touchpad/pointing-stick 则含 fine 且 hover；`MaxTouchPoints()` 返回枚举设备 touch_points 的最大值，没有触屏返回 0。[slow_web_preference_cache.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/browser/web_contents/slow_web_preference_cache.cc) 157–176 行填充 touch feature detection、pointer/hover、max touch points。[web_view_impl.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/exported/web_view_impl.cc) 1736–1740 行写入 Settings。

有输入发生时，网页还能看到：

- `MouseEvent` 的 screen/client/page/offset 坐标、movement、buttons、时间戳、wheel delta/deltaMode。源数据并不是从 `window.screenX` getter 反算；[mouse_event.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/events/mouse_event.cc) 198–235 行读取原生 WebPointerProperties 的 PositionInScreen/PositionInWidget，并按 frame 和 layout zoom 转换 client 坐标。
- `PointerEvent.pointerType`、`pointerId`、`isPrimary`、`width/height`、`pressure`、`tiltX/Y`、`altitudeAngle/azimuthAngle`、`tangentialPressure`、`twist`。鼠标、笔、触屏的字段和到达节奏可不同。`getCoalescedEvents()` 需要 secure context；普通 PointerEvent 属性没有单独的权限弹窗。
- `.73` 的 `persistentDeviceId` 已出现在默认 [pointer_event.idl](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/events/pointer_event.idl) 中，没有 RuntimeEnabled/权限注解。但**它不是原样暴露 OS 硬件序号**：[pointer_event_factory.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/events/pointer_event_factory.cc) 751–774 行把 browser device id 映射为从 1 递增的 Blink id，未知设备返回 0，鼠标用专门的映射；mapping 在 factory reset 路径清空。
- 同文件 65–73 行：没有 buttons 时 pressure 为 0；buttons 按下而原始 force 未知（NaN）时为 0.5。107–137 行把 pointer 接触形状按 layout zoom 换算，并传入压力/倾角/旋转。首版应沿用这套原生逻辑。

这些接口反映“设备能力”和“本次实际输入”；只有读取 getter 的测试不能覆盖事件字段。后续 humanize 应改变轨迹/节奏，浏览器继续负责按原生规则构造事件。

## 刷新率与 Worker 覆盖

稳定的 `Screen`/`ScreenDetailed` IDL 没有数值刷新率 getter；`ScreenInfo.display_frequency` 是内部字段，不等于网页直接有 `screen.refreshRate`。

实际刷新/调度仍可通过 rAF 回调间隔、动画、视频帧以及输入事件间隔观测：

- X11 [x11_display_util.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/ui/base/x/x11_display_util.cc) 182–195 行由 mode dot_clock/htotal/vtotal 计算刷新率，519 行存入 display；[x11_xrandr_interval_only_vsync_provider.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/ui/base/x/x11_xrandr_interval_only_vsync_provider.cc) 59–83 行提供对应 interval。
- 页面 [PageAnimator::ServiceScriptedAnimations](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/page/page_animator.cc) 78–99 行采用渲染 update 的 monotonic time，并根据 CrossOriginIsolatedCapability 进行时间精度限制；142 行写入每个 controller 时间；[scripted_animation_controller.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/dom/scripted_animation_controller.cc) 178–185 行实际执行 rAF。
- Dedicated Worker 支持 rAF 的条件由有效 BeginFrameProvider 决定；[worker_animation_frame_provider.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/renderer/core/animation_frame/worker_animation_frame_provider.cc) 29–38 行注册时检查，45–81 行使用 `BeginFrameArgs.frame_time` 减 Worker TimeOrigin 再限制精度。Worker 虽没有 `screen`/`matchMedia`，仍可能观察显示相关的 frame cadence。
- rAF 间隔还取决于页面可见性、CPU/GPU 工作量、节流与 display server，不应把一次测量直接解释为精确显示器 Hz。统一某个返回字段并不会统一实际帧调度。

## 截图、点击与坐标的开发约束

这是本路径必须从第一版明确的单位：

| 量 | 单位/语义 |
|---|---|
| DOM layout、boundingClientRect、clientX/clientY | frame 的 CSS px |
| ScreenInfo rect、native window/view rect | device independent pixels，通常与页面 100% zoom 时的 CSS 尺寸数值对应 |
| `window.devicePixelRatio` | 页面 CSS px 到 device pixels 的比例，包含 layout zoom 路径 |
| compositor/位图大小 | device pixels |
| CDP `Input.dispatchMouseEvent` 的 x/y | 主 frame viewport 的 CSS px |
| CDP `Page.captureScreenshot` 的 `Page.Viewport` clip | **DIP**，另有 scale；不可在任意 page zoom 下假设与 CSS px 数值相同 |

这里已经检查了源码，而不只看协议注释：

- [Input.pdl](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/public/devtools_protocol/domains/Input.pdl) 165–177 行声明输入 CSS 坐标；[input_handler.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/browser/devtools/protocol/input_handler.cc) 1551–1573 行的 `ScaleFactor()` 处理 browser zoom、iframe CSS zoom、pinch zoom，1629–1640 行转换 widget 与 screen 坐标。
- [Page.pdl](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/third_party/blink/public/devtools_protocol/domains/Page.pdl) 454–465 行定义 screenshot viewport 为 DIP；[page_handler.cc](https://chromium.googlesource.com/chromium/src/+/2f9a11097447f226133bc1a31c787291a5eeab98/content/browser/devtools/protocol/page_handler.cc) 1516–1552、1584–1612 行计算 host DSF、emulation dpfactor、clip scale 与输出图片尺寸，double-precision DIP 也有专门舍入逻辑。

Chromium Python backend 应继续对调用方提供 Playwright 的 CSS clip/点击语义，在后端转换到各自 CDP 命令。不能让截图拿一套虚拟 DPR、hit test 使用真实 DPR，或为了 css-scale 截图而修改输入坐标。适配验证至少涵盖 DSF=1/1.5/2、页面 zoom、非零 clip、iframe/OOPIF、CSS zoom、CSS/device 两种输出尺寸和点击标记命中；测试应比较图片的实际尺寸和标记内容。

## 首版可执行顺序

1. 在普通 Linux headed 桌面记录真实 screen/window/DPR/CSS/touch/media 值，分别注明 X11 或 Wayland。
2. 在有固定 geometry/scale 的 Linux 虚拟桌面运行相同采集，确认运行环境配置形成的是一整组实际一致的显示参数。
3. 暂不改这组 display getter；先实现 CPU/内存等适合独立配置的硬件暴露点。
4. CDP 后端加入截图/输入单位验证，随后接入 humanize。
5. 确有需求时，再实现按 profile 提供单屏/SDR/sRGB 等完整显示视图，并覆盖 Screen、CSS、多屏权限内返回、iframe、变化事件和实际窗口行为。

本报告列出的稳定 API、权限 API 和实验 API 是三类不同的可见面；后续采集结果应记录 secure context、权限状态、feature flags 和 display backend，才能与该固定源码逐项对应。
