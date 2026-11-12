# 原生配置、构建与验证指南（Chromium `157.0.8103.50`）

本组补丁作用于 Chromium Linux Stable `157.0.8103.50`（`049750111b1e5c11565c792b2aeed5541f332bad`）。

---

## 1. 运行时环境变量 `INVISIBLE_CHROMIUM_PROFILE`

在启动浏览器前设置 `INVISIBLE_CHROMIUM_PROFILE`（由 Browser、Zygote、Renderer、GPU 与 Utility 子进程继承并缓存）：

```bash
# 使用标准 Linux Desktop 默认画像（8 核 / 8 GiB / tier 3 / Intel UHD 630 Mesa OpenGL 4.6）
INVISIBLE_CHROMIUM_PROFILE='{}' /path/to/chrome --user-data-dir=/path/to/profile
```

| JSON 字段 | 默认值 | 支持范围与说明 |
| --- | --- | --- |
| `hardwareConcurrency` | `8` | 正整数；覆盖 Window 与 Dedicated/Nested/Shared/ServiceWorker |
| `deviceMemory` | `8` | `2`、`4`、`8`、`16`、`32`（单位 GiB）；同步覆盖 JS `navigator.deviceMemory`、导航与子资源 `Device-Memory` / `Sec-CH-Device-Memory` Client Hints，以及 `gin::IsolateHolder` 的 V8 `jsHeapSizeLimit` |
| `cpuPerformance` | 按核数自动推导 | `1..2` 核→`1`，`3..4`→`2`，`5..12`→`3`，`>=13`→`4`；也可显式指定 `0..4` |
| `normalizeWebgl` | `true` | 为 `true` 时规范化 WebGL1/2 硬件参数、整数精度与 MSAA 采样上限，消除 `llvmpipe` 或服务器大显卡特征 |
| `webglVendor` | `"Google Inc. (Intel)"` | 非空字符串；覆盖主线程与 Worker `OffscreenCanvas` 的 `UNMASKED_VENDOR_WEBGL` |
| `webglRenderer` | `"ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)"` | 非空字符串；覆盖 `UNMASKED_RENDERER_WEBGL` |

- **未设置 `INVISIBLE_CHROMIUM_PROFILE` 时**：全部保留上游 Chromium 原始行为（便于同二进制做 A/B 对照测试）。
- **JSON 非法或字段越界时**：启动阶段立即 `CHECK` 报错退出，防止配置拼写错误时静默回退暴露宿主机真实硬件。

---

## 2. 源码同步、打补丁与构建

使用 `depot_tools` 在独立构建目录（如 `$HOME/.cache/chromium-build`）同步 `157.0.8103.50`：

```bash
cd "$HOME/.cache/chromium-build"
. ./env.sh
git -C src fetch --depth=1 origin refs/tags/157.0.8103.50:refs/tags/157.0.8103.50
git -C src checkout -f 157.0.8103.50
gclient sync --no-history --nohooks --revision src@049750111b1e5c11565c792b2aeed5541f332bad
gclient runhooks
```

在 `chromium_patch` 仓库应用全部 Chromium 与 V8 补丁：

```bash
cd /path/to/chromium_patch
bash scripts/apply-patches.sh "$HOME/.cache/chromium-build/src"
cp build/linux-release.gn "$HOME/.cache/chromium-build/src/out/Release/args.gn"
```

执行编译与单元测试：

```bash
cd "$HOME/.cache/chromium-build/src"
gn gen out/Release
autoninja -C out/Release blink_common_unittests
out/Release/blink_common_unittests \
  --gtest_filter='WebHardwareProfileTest.*:ApproximatedDeviceMemoryTest.*'
autoninja -C out/Release chrome chrome_sandbox
```

---

## 3. 自动化验收脚本

- `scripts/verify-desktop.mjs`：在桌面容器内串联验证原版对照、`--remote-debugging-pipe` 默认桌面画像、以及 `4 GiB` 自定义画像三组独立进程，覆盖：
  - Window / iframe / OOPIF / 四类 Worker 的 CPU、内存、V8 堆上限、`webdriver === false` 与 Client Hints；
  - 无 `--ignore-gpu-blocklist` 下的 WebGL1/2、Worker `OffscreenCanvas`、`failIfMajorPerformanceCaveat: true`、8x MSAA 调用与全部规范化参数；
  - H.264 / AAC 编解码器、屏幕工作区面板边距（`availHeight < height`）、无顶部黄条警告（`outerHeight - innerHeight` 正常）、音频输入/输出设备、零 espeak 语音泄露、字体与时区；
  - `Runtime.enable` 下的实例/原型链 `Error.stack` getter、`Proxy` 与 DOM getter 零触发断言；
  - CDP `Input.dispatchMouseEvent` 的 `isTrusted`、`pointerdown.pressure === 0.5`、`movementX/Y` 与屏幕坐标偏移断言。
- `scripts/probe.mjs`：采集单次桌面完整环境快照 JSON。
