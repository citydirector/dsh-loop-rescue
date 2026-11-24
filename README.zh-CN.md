# dsh-loop-rescue

[English](README.md) · **简体中文**

[![npm](https://img.shields.io/npm/v/dsh-loop-rescue)](https://www.npmjs.com/package/dsh-loop-rescue) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH plugin](https://img.shields.io/badge/DSH%20plugin-%E2%89%A50.2.1--rc.2-blue)](https://github.com/topics/dsh-plugin)

在 DSH 模型陷入复读时，停止当前输出，剪掉写入会话的重复内容，再自动续跑。适用于同一段推理、短句或正文反复出现的情况。

需要 **DSH >=0.2.1-rc.2 <0.3.0** 和 **Node.js 24.9+**。已覆盖 0.2.1-rc.3；不需要为安装插件升级到 alpha。

## 快速开始

1. 在 DSH「插件 → 添加插件」输入 `dsh-loop-rescue`，安装并启用。
2. 与 `@mrweicodes/dsh-loop-guard` 二选一，避免重复切断同一条流。
3. 默认就是救援模式。想先观察检测结果，可把 `mode` 改为 `observe`。

命令行安装到 Web profile：

~~~sh
dsh plugin --profile web add dsh-loop-rescue
~~~

命令行操作前关闭对应的 DSH 实例，完成后重启。Desktop 用户优先使用插件页；命令行管理 desktop profile 时，使用该桌面安装自带的 CLI 和相同的 DSH_HOME。

## 配置

配置保存在 profile 的 `cordis.patch.yml`，行 ID 为 `loop-rescue`：

~~~yaml
- set:
    - id: loop-rescue
      config:
        mode: rescue
        watch: both
        maxConsecutiveRescues: 3
        language: auto
~~~

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `rescue` | 剪除并续跑；`cut` 只剪除，`observe` 只记录 |
| `watch` | `both` | 检测 `reasoning`、`text` 或两者 |
| `marker` | `true` | 在剪除处留提示 |
| `maxConsecutiveRescues` | `3` | 连续救援上限，正常调用后重置 |
| `stallCalls` | `3` | 连续只思考无产出时提醒；0 关闭 |
| `stallMinReasoningChars` | `1024` | 计入空转的单次推理长度下限 |
| `retryTemperature` / `retryReasoningEffort` | 未设置 | 续跑请求的可选采样参数 |
| `retryRequests` | `1` | 续跑后使用上述参数的请求数 |
| `language` | `auto` | `auto`、`zh` 或 `en` |

`detector` 下可调整检测阈值；通常不必修改。完整示例、检测规则和离线脚本见[进阶说明](docs/advanced.zh-CN.md)。

## 更新

安装来源使用 npm 包名。DSH 提供版本列表时在插件页更新；没有该界面时，关闭 DSH 后运行：

~~~sh
dsh plugin --profile web add dsh-loop-rescue@latest
~~~

从 GitHub 来源迁移时，先备份 profile 的 `cordis.patch.yml`，移除旧包后用 npm 包名重新添加，并检查原配置。发布流程见 [PUBLISHING.md](PUBLISHING.md)。

## 使用边界

- 检测到循环时，只将保留下来的内容写入最终消息；已显示的流式文字如何重绘取决于 DSH 前端。
- 有未闭合工具调用时不切断，避免执行不完整参数。
- 不处理“每回合重复调用同一工具”这类跨步骤循环。
- 不会自动修改已经保存的历史会话。离线清理前必须关闭 DSH，并保留备份。
- 采样参数能否生效取决于模型适配器。

## 开发

~~~sh
npm ci --ignore-scripts --legacy-peer-deps
npm test
~~~

CI 在 Node.js 24 和 26 上同时检查 DSH 0.2.1-rc.3 与 alpha 运行时的兼容性。源码入口是 [src/index.js](src/index.js)，检测器是 [src/detector.js](src/detector.js)。

## 相关项目

[@citydirector](https://github.com/citydirector) 的其它 DeepSeek Harness（DSH）项目：

| 项目 | 类型 | 用途 |
|---|---|---|
| [DSH-build](https://github.com/citydirector/DSH-build) | 构建 | DSH 的 Windows 便携版 / 桌面版绿色构建，每天跟随上游打补丁、冒烟、发布 |
| [dsh-remote-access-proxy](https://github.com/citydirector/dsh-remote-access-proxy) | 插件 | 在手机、平板或其它电脑上用浏览器访问 DSH Web GUI |
| [deepinfra-fusion-proxy](https://github.com/citydirector/deepinfra-fusion-proxy) | 插件 | DeepInfra Standard / Flex 按会话切换与自动回退 |
| [dsh-pwsh-plugin](https://github.com/citydirector/dsh-pwsh-plugin) | 插件 | 常驻 pwsh 会话工具（`pwsh_run`），附带给 `bash` 补写边界的 WSL 垫片 |
| [ui-locate-mcp](https://github.com/citydirector/ui-locate-mcp) | MCP 插件 | 按界面文字和图标给出精确像素坐标，用于桌面操作 |
| [dsh-session-manager](https://github.com/citydirector/dsh-session-manager) | 离线工具 | 离线升级、归档、回收站、清洗循环、修复烂尾 / 隐藏会话 |

## 许可证

[MIT](LICENSE)
