# CPU / RAM 原生补丁

本组补丁作用于 Chromium `156.0.8078.73`。维护文件是 [patches/chromium/series](../patches/chromium/series) 中按顺序列出的补丁；完整 Chromium 源码与构建产物放在独立 checkout。

## 配置与使用

在启动浏览器前设置 `INVISIBLE_CHROMIUM_PROFILE`：

```bash
INVISIBLE_CHROMIUM_PROFILE='{"hardwareConcurrency":8,"deviceMemory":8,"cpuPerformance":3}' \
  /path/to/chrome --user-data-dir=/path/to/profile
```

变量由 Linux 子进程和 zygote 继承，各进程首次读取后缓存。一个 browser process 使用一个配置；新页面、跨站 renderer 和独立 Worker 在运行首段网页脚本时即使用它。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| hardwareConcurrency | 8 | Window 与各类 Worker 声明的逻辑处理器数，正整数 |
| deviceMemory | 8 | GiB，首版支持 8、16、32 |
| cpuPerformance | 根据声明核数推导 | 1–2 核→1，3–4→2，5–12→3，13及以上→4；可显式设置0–4 |

设置 `{}` 使用默认 8/8/3。变量未设置时，全部采用原版数据源。格式或字段值错误会给出启动错误，避免部分字段悄悄落回宿主值。

首版选用 8 GiB 以上档位：在实际内存≥8 GiB的 Linux64 主机上，这些档位对应相同的默认 V8 heap ceiling。低内存档需要同时实现 isolate resource constraints，因此本组配置暂不提供。动态 JS/DOM/Canvas 内存占用保持实际值。

## 修改位置

| 修改点 | 实现与覆盖范围 |
| --- | --- |
| 新增 blink/common/hardware/web_hardware_profile | 解析环境 JSON，保存进程生命周期内不变的网页硬件声明 |
| NavigatorConcurrentHardware | 从公共 mixin 返回声明核数；Window、Dedicated/Shared/ServiceWorker 共用 |
| ApproximatedDeviceMemory::Initialize | 将声明 RAM 送入原版分档算法；JS、Browser 导航 CH、Renderer 子资源 CH 共用此实现 |
| RenderProcessHostImpl::Init | profile tier 优先于持久化 pref 和宿主分类，经现有 InitializeRenderer Mojo 传入；不会被宿主异步 CPU 分类覆盖 |

系统资源查询、线程池、调度、内存 allocator 及 CPU 分类内部实现保持原版。补丁添加的代码通过 C++ 数据入口生效，网页 getter 的原型和属性描述保持原版。原有 CDP 显式 emulation 仍可覆盖 HC/tier；清除后回到 native profile 默认值。

## 应用

先用官方 depot_tools 同步上述 stable tag 及它的 DEPS，然后在本仓根目录执行：

```bash
bash scripts/apply-patches.sh /path/to/chromium/src
```

应用使用标准 `git apply`，不添加资产或镜像摘要校验。每个 release 分支维护自己版本的补丁。

## Linux 构建

使用官方 depot_tools，在独立目录同步源码。当前实际构建用的是 GitHub 的 Chromium 镜像，DEPS 使用 release 自己的版本：

```python
# /path/to/chromium-build/.gclient
solutions = [{
    "name": "src",
    "url": "https://github.com/chromium/chromium.git",
    "managed": False,
    "deps_file": "DEPS",
    "custom_deps": {},
    "custom_vars": {"checkout_pgo_profiles": False},
}]
target_os = []
```

在该构建目录运行：

```bash
gclient sync --no-history --nohooks --revision src@156.0.8078.73
python3 src/build/install-build-deps.py --no-prompt --no-arm --no-chromeos-fonts --no-syms
gclient runhooks
```

接着应用本仓补丁，复制 [linux-release.gn](../build/linux-release.gn) 为 `src/out/Release/args.gn`，在 `src` 中运行：

```bash
gn gen out/Release
autoninja -C out/Release blink_common_unittests
out/Release/blink_common_unittests \
  --gtest_filter='WebHardwareProfileTest.*:ApproximatedDeviceMemoryTest.*'
autoninja -C out/Release chrome
```

当前参数为 release、非 component、无调试符号、LTO/PGO/remoteexec 关闭。`out/Release` 包含浏览器运行所需的二进制和资源；直接挂载整个目录到桌面容器运行。

## 验证入口

- `blink_common_unittests --gtest_filter='WebHardwareProfileTest.*:ApproximatedDeviceMemoryTest.*'`：配置解析和原版内存分档。
- `scripts/verify-hardware.mjs`：独立 browser 进程的原版路径、默认配置及非默认配置；首段读取、Worker、iframe、跨站导航与 Client Hints。

```bash
node scripts/verify-hardware.mjs /path/to/out/Release/chrome evidence/hardware-verification.json
```

脚本支持与现有观察工具相同的 `PROBE_DISPLAY`、`PROBE_NO_SANDBOX` 和 `PROBE_BROWSER_ARGS`。在 [Docker 桌面](CONTAINER.md) 中，把浏览器目录改成构建的 `out/Release`，并将执行命令改为 `node /opt/probe/verify-hardware.mjs /opt/chrome/chrome /tmp/verification.json`。脚本自行启动三次独立进程并配置环境，无需额外传入 profile。

`--stock-only` 只运行原版路径，已在现有 CfT `.4` 上通过；见 [工具运行记录](../evidence/hardware-verification-stock-cft-156.0.8078.4.json)。这份记录用于确认测试入口可用，native 结果使用自行构建的 `.73` 单独记录。

构建与实际运行结果在完成后记录到本文件。
