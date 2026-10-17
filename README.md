# dsh-loop-rescue

DSH 循环救援插件：模型陷入重复（`Now. / OK. / Emit. / Producing.` 轮转、段落刷屏）时，从流内部切断，**把循环部分从落盘内容里剪掉**，再自动续跑。

和单纯截断相比，关键区别是：被切断的那条消息在下一轮上下文里**不含循环**，模型不会再读一遍自己的复读，然后接着复读。

## 原理

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

## 安装

和 `@mrweicodes/dsh-loop-guard` **二选一**，两者同时开会重复切断：

```powershell
dsh plugin --profile web remove @mrweicodes/dsh-loop-guard
dsh plugin --profile web add -w github:citydirector/dsh-loop-rescue
```

装完重启 `dsh web`。本仓库是纯 JS，没有构建步骤，不需要放行 pnpm 构建脚本。指定版本可以用 `github:citydirector/dsh-loop-rescue#v0.1.0`。

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

## 离线扫描

用插件同一份检测器复跑历史会话，看会在哪里剪：

```powershell
node tools/scan-session.mjs <会话文件或目录>          # 只列命中
node tools/scan-session.mjs <会话文件或目录> --all    # 连未命中一起列
node tools/scan-session.mjs <会话文件> --json
```

支持纯 jsonl 和 zstd 压缩的会话文件（zstd 需要 Node 22.15+）。脚本只依赖 `src/detector.js`，普通 node 就能运行。

## 救回已经嗝屁的会话

插件只能拦住新的循环；历史里已经提交的循环会被模型继续模仿。DSH 发给模型的请求是会话日志的冻结投影，插件改不了，所以用离线脚本在 **DSH 完全退出后** 直接清洗会话文件。没装过插件的老会话同样适用。

```powershell
node tools/clean-session.mjs            # 自动找数据目录，列出有循环的会话（标题 / 最后使用时间 / 循环段数），按序号选，回车=最新
node tools/clean-session.mjs --dry-run  # 只看会改哪里
node tools/clean-session.mjs --undo     # 从备份恢复
```

Windows 下也可以双击 `tools\clean-session.cmd`，或把某个会话文件夹拖到它上面。

- 数据目录自动在 `D:\dsh-desktop\data`、`D:\dsh-portable\data` 等位置查找 `sessions\`；找不到时用 `--data <数据目录>` 指定。
- 只改命中的 `assistant/message`：正文/推理截到循环起点，`data.stream` 同步截断，并移除该消息的 `source.replayState`（里面有原文副本）。其余行逐字节不变。
- 改之前先备份到 `<数据目录>\sessions-loop-rescue-backup\`；检测到 DSH 进程在运行会拒绝执行（`--force` 可跳过，不推荐）。
- 目前只支持 v4 会话文件；需要 Node 22.15+。

## 测试

```bash
npm install
npm test
```

## 已知限制

- 聊天区已经流出的循环文字在消息提交后会被替换成剪过的版本，但具体怎么重绘取决于 DSH 前端版本；
- 跨步骤的循环（每一步都是「说一句 → 调同一个工具」）不在本插件范围内，那是内置 `guard/repeat-tool-reminder` 的职责；
- `retryTemperature` 需要适配器支持 temperature；Ollama 的重复惩罚等参数 DSH 目前没有通用字段，无法从这里设置。

## 许可

MIT
