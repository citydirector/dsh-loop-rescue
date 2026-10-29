# 检测原理与离线会话工具

[返回 README](../README.zh-CN.md)

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
