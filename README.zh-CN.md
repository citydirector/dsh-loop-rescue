# dsh-loop-rescue

[English](README.md) · [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/tag/citydirector/dsh-loop-rescue?sort=semver&label=release)](https://github.com/citydirector/dsh-loop-rescue/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH plugin](https://img.shields.io/badge/DSH%20plugin-%E2%89%A50.2.1--rc.2-blue)](https://github.com/topics/dsh-plugin)

DSH 循环救援插件：模型陷入重复（`Now. / OK. / Emit. / Producing.` 轮转、段落刷屏）时，从流内部切断，**把循环部分从落盘内容里剪掉**，再自动续跑。

和单纯截断相比，关键区别是：被切断的那条消息在下一轮上下文里**不含循环**，模型不会再读一遍自己的复读，然后接着复读。

需要 **DSH 0.2.1-rc.2 或更新的 0.2.x**。纯 JS，没有构建步骤。

## npm 安装与更新

插件本身兼容 DSH 0.2.1（包括 0.2.1-rc.3）。若当前 DSH 提供 npm 版本列表，请在插件页更新；否则关闭 DSH 后运行 `dsh plugin --profile web add dsh-loop-rescue@latest`（桌面版将 `web` 换成 `desktop`），再重启。GitHub Actions 自动发包不要求升级 DSH 到 alpha 版本。

需要 DSH 0.2.1-rc.2 或更新的 0.2.x，以及 Node.js 24.9+。在 DSH「插件 → 添加插件」输入 `dsh-loop-rescue`，或运行：

```sh
dsh plugin --profile web add dsh-loop-rescue
```

旧版从 GitHub 安装的用户：先备份 profile 的 `cordis.patch.yml`，在插件页移除旧包并用上述 npm 包名重新添加，保持原 profile 与配置行 ID。配置仍由 profile 保存；重新添加后检查已保存的值。此后统一使用 DSH 插件页的版本列表与更新功能。更新完全由 DSH 管理。

## 快速开始

和 `@mrweicodes/dsh-loop-guard` **二选一**，两者同时开会重复切断。

1. **安装**：侧边栏 **插件** → 添加插件，填入
   ```
   dsh-loop-rescue
   ```
   装完打开开关。
2. 默认配置即可使用。想先观察，把 `mode` 设成 `observe`（见「配置」）。

命令行安装：

```powershell
dsh plugin --profile web remove @mrweicodes/dsh-loop-guard
dsh plugin --profile web add dsh-loop-rescue
```

命令行装完重启 `dsh web`。不需要放行 pnpm 构建脚本。

## 配置

默认配置即可使用。需要调整时写进 profile 的 `cordis.patch.yml`：

```yaml
- set:
    - id: loop-rescue
      config:
        mode: rescue              # rescue：切+剪+续跑 | cut：切+剪 | observe：只记日志
        watch: both               # both | reasoning | text
        marker: true              # 剪除处留「〔已删除 N 字重复思考〕」
        maxConsecutiveRescues: 3  # 连续救援上限，出现一次正常调用就清零
        stallCalls: 3             # 连续几次只思考无产出就提示继续；0 关闭
        stallMinReasoningChars: 1024
        retryTemperature: 1.0     # 续跑请求改用的温度；不填不改
        retryReasoningEffort: low # 续跑请求改用的推理强度；不填不改
        retryRequests: 1          # 续跑后几次请求使用上面两项
        language: auto            # auto | zh | en
        detector:                 # 检测阈值，一般不用动
          poolWindow: 30
          poolMinCoverage: 0.75
          cycleMinChars: 600
```

建议先用 `mode: observe` 跑一两天，看日志里的 `loop-rescue: ... loop detected` 是不是都是真循环，再切到 `rescue`。

## 工作原理

agent-loop 组装 `assistant/message` 时，每个 block 的最终内容取自 `block-end` 的载荷，而不是之前流出的 delta。插件在 `llm/stream` 瀑布里包装模型调用：

1. 对每个推理/正文 block 跑流式检测器；
2. 命中后闭合所有打开的 block：循环所在的 block 换成**剪到循环起点**的内容（可留一行标记），以 `stop` 结束流；
3. 落盘的消息里只剩循环之前的有效内容。原始流仍完整保存在事件的 `stream` 记录里，轨迹视图可以查看；
4. 等回合真正结束（`whenIdle()`）后，用 `followup()` 发一条带纠正语的续跑消息；
5. 续跑的前 N 次请求可选地改用另一组采样参数；
6. 连续救援达到上限就不再续跑，留一条提示。

为什么不事后改会话：`assistant/message` 不能携带 `sourceEventSeqs`，会话面的 replace 操作没法用 assistant 消息替换 assistant 消息。在 `block-end` 处剪，是唯一不破坏消息角色和工具调用配对的做法。

### 检测规则

| 规则 | 抓什么 | 剪在哪 |
|---|---|---|
| 短句池 `pool` | 最近 30 句里 ≥75% 是几种反复出现的短句（顺序可以变） | 回溯到这批短句第一次出现的位置 |
| 逐字周期 `cycle` | 尾部是同一段文字的逐字重复，周期 16–4000 字符，重复 ≥3 遍，总长 ≥600 | 保留第一份，从第二份开始剪 |

防误伤：

- 中文句号直接断句，英文句号后面要跟空白才断；
- 纯符号行（`|---|`、`}`）不计入统计；
- 正文中的列表项、表格行、引用行不计入统计；
- 正文中的 ``` 代码块内部完全跳过；
- 短句池至少要有两种句子在轮转；
- 打开的 block 里有工具调用时不切，因为闭合半截工具调用会让宿主执行参数不完整的调用。

## 离线扫描

用插件同一份检测器复跑历史会话，看会在哪里剪：

```powershell
node tools/scan-session.mjs <会话文件或目录>          # 只列命中
node tools/scan-session.mjs <会话文件或目录> --all    # 连未命中一起列
node tools/scan-session.mjs <会话文件> --json
```

支持纯 jsonl 和 zstd 压缩的会话文件（zstd 需要 Node 22.15+）。脚本只依赖 `src/detector.js`，普通 node 就能运行。

## 清洗历史里已经提交的循环

插件只能拦住新的循环；历史里已经提交的循环会被模型继续模仿。DSH 发给模型的请求是会话日志的冻结投影，插件改不了，只能在 **DSH 完全退出后** 离线清洗会话文件。没装过插件的老会话同样适用。

推荐用 [dsh-session-manager](https://github.com/citydirector/dsh-session-manager)（`dsm loops`，Windows 有单文件 exe），检测规则和本插件同一套，另外还能升级、归档、修复烂尾会话。

本仓库也带一个轻量脚本（需要 Node 22.15+，只支持 v4 会话）：

```powershell
node tools/clean-session.mjs            # 列出有循环的会话，按序号选，回车=最新
node tools/clean-session.mjs --dry-run  # 只看会改哪里
node tools/clean-session.mjs --undo     # 从备份恢复
```

- Windows 下也可以双击 `tools\clean-session.cmd`，或把会话文件夹拖到它上面；找不到数据目录时用 `--data <数据目录>` 指定。
- 只改命中的 `assistant/message`：正文 / 推理截到循环起点，`data.stream` 同步截断，移除该消息的 `source.replayState`。其余行逐字节不变。
- 改之前备份到 `<数据目录>\sessions-loop-rescue-backup\`；DSH 在运行时拒绝执行（`--force` 可跳过，不推荐）。
- 2026-10-17 之前的版本只读得到压缩日志的第一帧，并会把结果写成单帧（DSH 会把这种会话当损坏隐藏）。已修复；被隐藏的会话可以用 `dsm repair` 找回。

## 已知限制

- 聊天区已经流出的循环文字在消息提交后会被替换成剪过的版本，但具体怎么重绘取决于 DSH 前端版本；
- 跨步骤的循环（每一步都是「说一句 → 调同一个工具」）不在本插件范围内，那是内置 `guard/repeat-tool-reminder` 的职责；
- `retryTemperature` 需要适配器支持 temperature；Ollama 的重复惩罚等参数 DSH 目前没有通用字段，无法从这里设置。

## 开发与测试

```bash
npm install
npm test
```

## 相关项目

- [dsh-remote-access-proxy](https://github.com/citydirector/dsh-remote-access-proxy)：在手机、平板或另一台电脑上使用 DSH
- [deepinfra-fusion-proxy](https://github.com/citydirector/deepinfra-fusion-proxy)：DeepInfra Standard / Flex 按会话切换与自动回退
- [dsh-session-manager](https://github.com/citydirector/dsh-session-manager)：离线会话管理器，可升级、归档、清洗循环、修复烂尾会话

## 许可证

[MIT](LICENSE)
