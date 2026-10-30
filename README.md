# pi-mixagent

基于 [pi coding agent](https://github.com/badlogic/pi-mono)（`@mariozechner/pi-coding-agent`）的扩展：
**便宜模型查代码 → 旗舰模型只写修改方案 → 便宜模型在新 session 里执行**，以减少旗舰模型的输入与输出 token。

```
用户提示词
   │
   ▼
① Scout（默认 Haiku，主 session）
   只读工具：grep / find / ls / read / bash(rg、grep、git log…)
   搜到无关结果时可调用 discard 丢弃它们
   找到相关代码后调用 handoff 工具
   │  handoff 把「用户提示词 + Scout 的全部工具调用及结果 + 关键文件全文 + Scout 备注」
   │  打包成一份 Markdown（图片作为附件跟在后面）
   ▼
② Planner（默认 Opus，单次调用、无工具）
   以 Markdown 输出所有修改（SEARCH/REPLACE 块 / 新文件全文 / 命令 / 回答）
   │  方案保存为 .md 文件
   │  如果方案只有回答（没有修改和命令），直接显示回答，不启动 Executor
   │  大任务：Planner 只输出 ## Subtasks，每个子任务由一次 Planner 调用并行写方案，
   │  再由一次 join Planner 调用合并成最终方案（共 1+N+1 次旗舰调用）
   │  join 可以附带 ## Tasks，把文件分成互不重叠的几组，交给多个 Executor
   ▼
③ Executor（默认 Haiku，全新的 pi session）
   按方案调用 edit / write / bash 执行修改
   有 ## Tasks 时：每组一个 Executor 并行执行，全部完成后再用一个 Executor 运行 Commands
   │
   ▼
结果（执行报告或 Planner 的回答）显示在 handoff 工具结果里
```

## 为什么能省旗舰模型的 token

| 环节 | 旗舰模型（Opus）看到 / 产生的内容 |
| --- | --- |
| 输入 | 只有一条消息：打包后的 Markdown。**没有** pi 的系统提示词、工具 schema 和越来越长的多轮对话 |
| 探索 | 0 次。grep/read 的多轮往返都由 Haiku 完成 |
| 输出 | 只写 SEARCH/REPLACE 差异块，不写整文件、不调用工具、不写执行过程 |

另外还会做一些压缩：

- Scout 可以用 `discard` 工具丢弃无关的搜索结果（见下文），被丢弃的内容在 Scout 上下文和 Planner 包里都只剩一行提示
- 重复的工具调用只保留最后一次；如果文件已经作为「关键文件」附了全文，对它的 `read` 结果就不再重复附带
- 单个工具输出、单个文件、整个包都有字符上限（可配置）
- 已完成的周期里，Scout 的探索记录会从后续上下文里裁掉，只保留 handoff 的结果（方案摘要和执行报告），所以 Haiku 的上下文也不会一直膨胀
- Planner 觉得上下文不够时可以回复 `## Need context`，Scout 会补查后再次 handoff，次数由 `maxContextRounds` 限制

## 复杂任务的 fork-join

规划和执行都可以拆分，**规划全程用 Planner 模型**，执行用 Executor 模型。

### 规划：1 + N + 1 次 Planner 调用

第一次 Planner 调用（lead）先判断任务大小。任务较大且包含多个相互独立的部分时（大约 4 个以上文件，或几处较大的修改），它不直接写方案，而是只输出拆分：

```
## Summary
整体思路
## Design
各部分共享的关键约定（主要接口或命名、共享代码归谁写），保持简短，细节由子 Planner 补充、join 统一
## Subtasks
- S1: `src/a.ts`, `src/b.ts` — 简短目标
- S2: `src/c.ts` — 简短目标
```

- **子 Planner**：每个子任务一次 Planner 调用，最多同时运行 `maxParallelPlanners` 个。每次调用收到同一份包，外加 lead 的拆分和「只写 S2」的说明，输出该子任务的完整方案
- **join Planner**：所有子方案完成后再调用一次 Planner。它收到包、lead 的拆分和所有子方案，负责检查和合并：对齐接口，补上缺失的 import，把同一文件的多段修改合成一段，然后输出最终方案和合并后的 Commands。子方案里不需要改动的文件段，join 只写一行 `` ### `path` — from S1 ``，程序会把它原样替换成对应子方案的那一段，join 不必重复输出
- 所有 Planner 调用的系统提示词完全相同，包放在消息开头，角色说明附在末尾，所以子 Planner 和 join 可以命中 lead 写入的提示词缓存（取决于提供商是否支持缓存）
- 子 Planner 失败（报错、空回复等）时自动重试，最多 2 次；重试后仍失败或被中止时直接报错，不启动 Executor。join 引用了任何子方案里都没有的文件段时也会报错（方案仍会保存）
- 小任务或耦合紧密的任务不拆分：lead 直接写方案，只调用一次 Planner

### 执行：由 join 决定一个还是多个 Executor

join Planner 决定怎么执行。改动包含多个独立部分时，它会附上 `## Tasks`，把 `## Changes` 里的文件分成 2～5 组：

```
## Tasks
- T1: `src/a.ts`, `src/b.ts` — 简短目标
- T2: `src/c.ts` — 简短目标
```

- 每组由一个新的 Executor session 执行，只收到方案摘要、`## Changes` 开头的共同说明和自己那几个文件的修改块，最多同时运行 `maxParallelExecutors` 个
- 任务 Executor 出错时，用新的 session 重试，最多 2 次。重试时会提醒它前一次可能已改了部分文件，修改前先读文件，跳过已完成的修改。中止不重试
- 所有任务完成后，如果方案有 `## Commands`，再用一个 Executor 统一运行命令（构建、测试），必要时做小修复；有任务失败或被中止时不运行
- 每个文件只能属于一个任务，所以并行的 Executor 不会改同一个文件。分组不合法（文件没分配、重复分配、任务编号重复、只有一组）时退回到单个 Executor
- 没有 `## Tasks` 时用单个 Executor

设置 `"forkJoin": false` 可以全部关闭：Planner 不会收到拆分说明，只调用一次。

## discard 工具

Scout 在探索期间，每个工具结果前都会带上编号（例如 `[#3]`，只在发给模型的上下文里添加，不写入 session）。如果某次搜索的结果和任务无关（匹配错了、vendored/生成的代码等），Scout 可以调用：

```
discard({ ids: [3, 5], reason: "only matches in node_modules" })
```

- 被丢弃的工具结果在上下文里替换为 `[#3 discarded: only matches in node_modules]`
- `discard` 调用本身和它的结果不会加入上下文
- 打包给 Planner 时，被丢弃的步骤只保留调用描述和一行 `[discarded by the scout as irrelevant: …]`
- 提示词要求 Scout 只在搜索到无关结果时使用，不要丢弃 Planner 可能需要的内容
- 只能丢弃当前周期里已经返回结果的工具调用；编号不存在时工具会报错，且不会丢弃任何内容

## Planner 看图

Planner 模型支持图片输入时（模型的 `input` 包含 `image`），下面这些图片会和 Markdown 包放在同一条消息里发给它：

- 用户提示词里附带的图片（例如粘贴的截图）
- Scout 用 `read` 读取的图片文件（pi 的 read 工具会先缩放）
- handoff `files` 里的图片文件（png / jpg / gif / webp），原样附带；超过约 3.75 MB 的会提示改用 `read`

Markdown 里用 `[image N]` 标注每张图的位置，图片按编号依次放在文本后面，每张前面有一行来源说明（`[image 2] step 3: read shot.png:`）。超过 `maxPlannerImages` 的图片，或者 Planner 模型不支持图片时，标注为 `[image omitted]`，不发送图片。被 `discard` 丢弃的步骤里的图片也不会发送。Executor 不会收到图片，它只按方案执行。

## 安装

需要 pi ≥ 0.73，并已配置好 Anthropic 或其他提供商的 key（`/login` 或环境变量 `ANTHROPIC_API_KEY`）。

```bash
# 方式 1：作为 pi 包安装（全局）
pi install /path/to/mixagent

# 方式 2：在 ~/.pi/agent/settings.json 里添加
#   "extensions": ["/path/to/mixagent/src/index.ts"]

# 方式 3：临时试用
pi -e /path/to/mixagent/src/index.ts
```

装好后直接输入提示词就行，底部状态栏会显示 `mix claude-haiku-4-5 → claude-opus-4-7 → claude-haiku-4-5`。

## 自定义模型

优先级从高到低：

1. **命令行参数**
   ```bash
   pi --mix-scout anthropic/claude-haiku-4-5 \
      --mix-planner anthropic/claude-opus-4-7 \
      --mix-executor openai/gpt-5-mini
   pi --mix-off        # 启动时关闭 MixAgent
   ```
2. **运行时命令**（只对当前 pi 进程生效，用 `/mix save` 持久化）
   ```
   /mix model planner anthropic/claude-opus-4-7
   /mix model scout              # 不写模型时，弹出可用模型列表选择
   /mix thinking planner high
   /mix save                     # 写入 ~/.pi/agent/mixagent.json
   /mix save project             # 写入 <项目>/.pi/mixagent.json
   ```
3. **项目配置** `<cwd>/.pi/mixagent.json`
4. **全局配置** `~/.pi/agent/mixagent.json`
5. 内置默认值

模型格式是 `provider/modelId`，必须在 pi 的模型列表里（`pi --list-models`）。如果 pi 内置列表里还没有新模型（例如 Claude 5 系列），可以在 `~/.pi/agent/models.json` 里自行添加，详见 pi 的 `docs/models.md`。

完整配置项见 [`mixagent.example.json`](mixagent.example.json)：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用 |
| `scoutModel` / `plannerModel` / `executorModel` | Haiku 4.5 / Opus 4.7 / Haiku 4.5 | 三个角色用的模型 |
| `scoutThinking` / `plannerThinking` / `executorThinking` | `off` / `medium` / `off` | 思考等级 |
| `plannerMaxTokens` | `32000` | Planner 的输出上限 |
| `scoutTools` | read,bash,grep,find,ls | Scout 可用的工具（edit/write 会被强制排除） |
| `executorTools` | read,bash,edit,write,grep,find,ls | Executor 可用的工具 |
| `scoutBashGuard` | `true` | 拦截 Scout 执行可能有写操作的 bash 命令（rm、>、sed -i、git checkout、npm install…） |
| `maxToolOutputChars` / `maxFileChars` / `maxPackageChars` | 2 万 / 6 万 / 30 万 | 打包时的字符上限 |
| `maxPlannerImages` | `10` | 最多给 Planner 看几张图；设为 `0` 则不发送图片 |
| `maxContextRounds` | `2` | Planner 最多能要求补充上下文几次 |
| `pruneScoutHistory` | `true` | 从后续上下文中裁掉已完成周期的探索记录 |
| `persistExecutorSession` | `true` | 是否把 Executor session 保存到磁盘（能在 `/resume` 里看到，并通过 parentSession 关联到主 session） |
| `forkJoin` | `true` | 允许把大任务拆成子任务，由多次 Planner 调用并行规划、join 合并，再由一个或多个 Executor 执行（见上文 fork-join） |
| `maxParallelPlanners` | `4` | fork-join 时同时运行的子 Planner 数量上限 |
| `maxParallelExecutors` | `4` | fork-join 时同时运行的任务 Executor 数量上限 |
| `planDir` | `~/.pi/agent/mixagent/plans` | 方案 Markdown 的保存目录；设为 `""` 则不保存 |

## 命令

| 命令 | 作用 |
| --- | --- |
| `/mix` 或 `/mix status` | 查看当前状态和模型 |
| `/mix on` / `/mix off` | 开启或关闭。关闭后恢复原来的模型和工具，变回普通 pi |
| `/mix model <scout\|planner\|executor> [provider/id]` | 切换某个角色的模型 |
| `/mix thinking <role> <level>` | 设置某个角色的思考等级 |
| `/mix save [global\|project]` | 把运行时修改写进配置文件 |

## 界面

handoff 工具的结果折叠时显示：

```
prompt: 把问候语改得更友好
✓ claude-opus-4-7 plan · 2 file change(s) 8.1k in / 612 out · $0.087
✓ claude-haiku-4-5 executed 3 turn(s) · 14k in / 420 out · $0.006
  ✓ edit {"path":"src/greet.ts",...}
  ✓ $ npm test

（Executor 的报告，以 Markdown 渲染）
```

第一行是原始提示词（折叠时只显示第一行，展开后显示全文）。展开（Ctrl+O）后显示原始提示词全文、Planner 的完整方案、所有工具调用、方案文件路径和 Executor session 路径。

规划被拆分时，Planner 显示为多行：`✓ claude-opus-4-7 split into 3 subtask(s)`，每个子任务一行（`✓ claude-opus-4-7 S1 planned … · 目标`），然后是 `✓ claude-opus-4-7 join · N file change(s)`，每行都有各自的 token 和费用。展开后可以看到 lead 的拆分和每份子方案；保存的方案文件末尾也附有这些内容。

执行被拆分成多个任务时，Planner 那一行后面会显示 `· N parallel task(s)`。每个任务单独一行（`✓ claude-haiku-4-5 T1 executed … · 目标`），执行中的任务会显示最近的工具调用。最后一行是运行 Commands 的 join Executor（`claude-haiku-4-5 commands executed`）。

## 注意事项

- **主 session 的模型**：每次输入提示词，主 session 会切到 Scout 模型。pi 会把它记成默认模型，`/mix off` 时会恢复原来的模型。
- **为什么 Executor 不直接切换主 session**：pi 的扩展 API 中，`newSession()` 只能在斜杠命令里调用，工具里调用不了，而 `sendUserMessage("/cmd")` 也不会触发扩展命令。所以 Executor 是用 pi SDK（`createAgentSession`）创建的一个**真正的新 session**：上下文是全新的，只有 Executor 系统提示词、AGENTS.md 和方案；session 文件保存在同一目录，并通过 `parentSession` 关联到主 session，可以用 `/resume` 打开继续对话。它的进度会实时显示在 handoff 工具里。为了避免递归，Executor session 不加载任何扩展。
- **打印模式**（`pi -p`）：pi 只输出最后一条 assistant 文本，所以在没有 UI 的模式下，Scout 会多一次很便宜的调用来原样转述执行报告或回答；交互模式和 RPC 模式下 handoff 会直接结束本轮，没有这次额外调用。
- 如果方案里没有 `## Changes` 和 `## Commands`（例如用户只是提问），Planner 的 `## Answer` 会直接作为结果显示，不启动 Executor，省掉一次模型调用。界面上显示为 `✓ <planner> answered (no executor)`。
- Executor 只做提示词和方案要求的事。
- Scout 的 bash 写操作拦截是启发式的，不是沙箱。
- 如果用户只是闲聊、和代码无关，Scout 可以不 handoff，直接简短回答。

## 开发

```bash
npm install
npm run typecheck
npm test            # 单元测试：打包、裁剪、bash 拦截、方案解析、TUI 渲染
npm run test:e2e    # 端到端：在真实 pi 进程里用脚本化的 mock provider 跑完整流程（不需要 API key）
```

端到端测试会验证：Scout 带着只读工具和 handoff 运行；Planner 只收到 1 条消息、没有任何工具；Executor 在全新 session 里应用了修改；方案 .md 文件已保存；Executor session 关联了 parentSession；第二轮对话时上一轮的探索记录被裁掉；Scout 丢弃的结果被替换为提示、discard 调用不进入上下文；Scout 读取的图片作为图片块发给 Planner；Planner 拆分时按 lead + 子 Planner + join 共调用 4 次、系统提示词相同、join 的 `from S1` 引用被展开，各任务的 Executor 只收到自己的文件，并由最后一个 Executor 运行命令；`/mix off` 之后恢复为普通 pi。

源码结构：

```
src/
  index.ts       扩展入口：阶段切换、handoff 工具、/mix 命令、渲染
  transcript.ts  提取当前周期、打包成 Markdown、去重、裁剪已完成周期
  planner.ts     调用旗舰模型（streamSimple，无工具），解析 Need context
  executor.ts    用 SDK 创建新 session 运行 Executor
  prompts.ts     三个角色的提示词
  safety.ts      Scout 的 bash 只读拦截
  config.ts      配置加载与合并
```
