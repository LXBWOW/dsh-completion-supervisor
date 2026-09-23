# dsh-completion-supervisor

[English](README.md) | **简体中文**

用 Jev 作为快速的类型化分类器（而不是 LLM），检查 agent 声称的「完成」是否真的完成。

**状态：确定性强制 + Jev 观测（`policy_v 3`）。** 有三条规则可以干预一轮次，每一条都是与插件自己
算出的事实做比较 —— 一个未解决的 tool error、一个没有依据的验证声明、一次被记录下来的、没有通过的
测试运行。任何由 Jev 概率推导出来的东西都只被记录，不决定任何事情。每个用户任务最多干预一次。

每个可评估的轮次仍然会调用 Jev，它的七个概率、延迟、模型和 `ground_truth` 仍然会写进日志：这份
记录是唯一有可能为「把某个概率重新拿回决策」提供正当性的东西。
[Jev 做什么、不做什么](#jev-做什么不做什么) 明确写出边界，因为「它听起来在做什么」和「它实际返回
什么」之间的差距，是关于这个插件最大的错误预期来源。

---

## 问题

一个编码 agent 说自己完成了。有时候确实完成了。有时候：

- 它说「测试通过」，却从未运行过测试
- 它创建了一个文件，却从未把它纳入跟踪
- 一段总结描述的结果，与被记录的命令相矛盾
- 一次构建失败了，而失败被总结掉了

用户是后来才知道的，或者永远不知道。

## 做法

在一轮次即将关闭的那一个时刻，收集确定性证据，压缩它，用**一个**请求向 Jev 提七个狭窄的是/否问题，
再对答案运行一个纯策略。自 `policy_v 3` 起，策略用这些答案来**标注**轮次，而只用确定性证据来行动。

```
agent/turn-stopping
      |
      v
TaskState  (deterministic facts gathered in code)
      |
      v
one Jev request  (7 x noul)
      |
      v
decide()  (pure function)
      |
      v
shadow log   (row 1: the assessment)
      |
      v
outcome row  (row 2: what the user actually did next)
```

## 为什么用 Jev，以及为什么批量提问

Jev（TypeSafe System One）**不是 LLM**。它接收一个 state 加上类型化的问题，返回概率。这使它成为
狭窄、重复验证的合适工具：它很快（实测 566–850 ms），很便宜（每次调用约 $0.000022），并且在一个
请求里回答七个问题。

更早的一个设计 —— 在**每一次 tool call** 上加一道 Jev 闸门 —— 已被放弃。它每次 tool call 都会触发，
于是延迟和配额随 tool call 数量线性增长，换来的只是一个额外的安全层，而不是更好的完成质量。这个插件
改为在每次**完成声明**时触发一次：每个用户任务 **1–3 次调用**，而不是几十次。

## Jev 做什么、不做什么

以下五条陈述，每一条都可以对照本仓库和决策日志来验证，而不是对照厂商的描述。它们放在这里，是因为
「Jev 听起来在做什么」和「它实际返回什么」之间的差距，是关于这个插件最大的错误预期来源 —— 其中
包括若干个曾被写进本文件早期草稿里的预期。

1. **它不读对话历史。** 请求体是一个由当前轮次组装出来的 `state` 对象：`goal`、`claim`、`repo`、
   `commands`、`evidence`、`activity`，以及可选的 `prior`。这里没有 transcript 字段，而 `prior` 在
   state 溢出时会在 fitting 阶段被丢弃。实测 `input_tokens`：中位数 2496，最大 6407 —— 一个 state 装得
   下，一段历史装不下。
2. **它不输出自然语言。** `output_tokens` 在全部 68 次被记录的调用中恰好是 136，响应体是
   `{probabilities, request_id, usage}`。它没有文本通道，所以任何被归到 Jev 头上的句子 —— 「它说」、
   「它指出」、「它认为」—— 都不可能来自它。解释永远属于策略层。
3. **它返回七个概率**，每个类型化问题一个，各自在 `[0,1]` 区间内：
   `requirements_satisfied`、`implementation_complete`、`verification_sufficient`、
   `blocking_issue_remaining`、`evidence_matches_claim`、`needs_more_verification`、`ready_to_finish`。
   响应里没有别的东西被使用，我们也没有任何决策是从它可能返回的其他东西推导出来的。
4. **不存在被确认的 `good_block` 样本。** 这个 verdict 路径存在于 logger 中，但从没有任何一行走过它。
   在 11 个由概率驱动的 `P4` 触发的轮次中，事后复核没有一个是必要的；唯一一个真正到达用户的干预被记录为
   `false_block`。
5. **同一个 state 反复采样的离散度是 0.04–0.11。** `tools/probe-determinism.mjs` 把同一个 state 分别
   发送了 5 次、8 次和 6 次：离散度达到 0.110，而阈值间隙是 0.05–0.30，也就是说噪声大小和被要求做出的
   决定一样大。`needs_more_verification` 在全部 68 次调用中都待在 `[0.64, 0.87]` 之内（中位数 0.78）
   —— 一种长期偏向「还没完成」的倾向，`lib/questions.js` 把它归因于「对错误的问题给出了正确的答案」。

由此推出两件事，而两者对这个插件的构建方式都是承重的。它无法告诉你*缺什么* —— 一个概率没有任何字段
可以承载一个条目，所以干预消息里任何具体的诉求都是策略层的，不是 Jev 的。而它对自己之前说过什么没有
记忆：唯一的去重来源是一行 state（`already_intervened_this_turn`，以及该轮次材料事实的指纹）。

## 分工

核心规则：

| 问题的种类 | 谁来回答 |
|---|---|
| 测试命令的退出码是 0 吗？ | code |
| 哪些文件变了，有没有文件被漏掉跟踪？ | code |
| agent 是否声明了从未运行过的测试？ | code |
| 这份证据是否真的满足了用户的请求？ | **Jev** —— 自 `policy_v 3` 起被记录，从不被采纳行动 |
| 这需要人来介入吗？ | 人 |

凡是 code 能算的东西，永远不问 Jev。这个插件里价值最高的检查是 `unverified_claims`：agent 说「所有
测试通过」，而被记录的命令里没有任何测试命令。code 能以确定性、零成本地检测出这个矛盾。

## 永远 fail-open

每一种失败都以同样的方式结束：**记录它，不干预，让 DSH 原生地结束这一轮。**

| 失败 | 行为 |
|---|---|
| 没有 `TYPESAFE_API_KEY` | 跳过 Jev；确定性检查照常运行 |
| key 文件缺失或不可读 | 等同于没有 key —— 在 turn-close 路径上永不抛异常 |
| Jev 超时 | 记录，不干预 |
| Jev HTTP 错误 | 记录，不干预；key 会从回显的 body 中被脱敏 |
| 响应格式错误 / 不完整 | 记录，不干预 |
| state 超出 token 预算 | 跳过 Jev，不发送被截断的 state |
| `git` 不可用 | facts 变成空，评估继续 |
| 任何抛出的异常 | 在最外层 guard 被捕获；轮次正常结束 |

不完整的答案集会被**拒绝**，永不使用默认值。一个伪造的 `0.0` 会被读成「确信还没完成」，可能阻断一个
本来没问题的轮次。

Jev 永远不是单点故障。

## 为什么阈值是不对称的

```
false block  ->  interrupt a working agent, burn a turn, show a user an unexpected message
false pass   ->  the user notices, exactly as if this plugin were not installed
```

一次 false pass 更便宜。所以**完成**的门槛很高（0.70–0.75），而**阻断**的门槛很低（0.40–0.65），
中间留下一段很宽的、默认放行的区间。

**这个排序现在已经不决定任何事情，而它过去如何决定是值得说清楚的，因为它解释了日志的整个形状。**
在 `policy_v 1` 和 `v2` 下，`P4` 在 `requirements_satisfied < 0.40 OR blocking_issue_remaining >= 0.65`
时触发 —— 在 `P8` 这个唯一的 `finish` 路径被走到之前就已经触发了。所以只要这两者之一成立，
`readyToFinishAtOrAbove` 就根本不会被查询，而一个被描述为「很高」的 `finish` 边界是一个没有任何代码去
读的数字。

这是实测而不是推理：`node tools/analyse.mjs --replay` 在被记录的概率上扫描阈值集合。在最初 13 条带概率
的评估上，把完成阈值从 0.70 移到 0.90，改变了**零**行的结果 —— `requirements_satisfied` 的中位数是
0.26、最大值是 0.48，而 `blocking_issue_remaining` 的中位数是 0.74。P4 早就已经返回了。

由此推出两件事，而两者都比催生它们的规则活得更久：

1. **移动一个边界修不好一个 block-first 的失败。** 当扫描显示没有变化时，原因在被调参的那个数字的
   上游 —— 而诚实地读出这一点，正是让概率本身（而不是它们的阈值）成为嫌疑对象的原因。
2. **`P9_default_pass` 才是真正放行一轮次的东西。** 任何不触发规则的轮次都会放行，不需要任何概率越过
   任何东西。「放行需要 0.70」一直是对这张表的误读；在 `policy_v 3` 下它是唯一可能的读法，因为每一条
   会去查询概率的路径都返回 `finish`。

所以当大多数行都在阻断时，问题不是「哪个阈值」，而是「state 是否完整到能做出判断，以及所问的问题是否
关于一个真实存在的东西」。这两点在第一轮里都是错的 —— 非仓库工作区里缺失的文件证据，以及下一节实测
契约中描述的 reasoning-block 声明。

这与 [Foreman](https://github.com/thruwire/foreman) 的立场相反，而且是故意的。Foreman 是一个无人值守
的工厂调度器：当它的评估失败时，它必须停下并呼叫人类，因为盲目继续可能损坏仓库。这个插件是助手增强：
当它的判断失败时，正确的结局就是 DSH 表现得和没装它一样。

## Jev 不是确定性的 —— 而这一点决定了阈值能意味着什么

用 `node tools/probe-determinism.mjs` 实测，该脚本反复发送**一个完全相同的 state** 并报告离散度。
同一个固定 state 在两个 prompt 版本下都被探测过，所以这两列也展示了 v2 改写带来的变化：

| question | v1（`prompt_v=1`，重复 8 次） | v2（`prompt_v=2`，重复 6 次） |
|---|---|---|
| `requirements_satisfied` | 0.400–0.450 | **0.480–0.520** |
| `implementation_complete` | 0.650–0.700 | 0.630–0.690 |
| `tests_sufficient` → `verification_sufficient` | 0.420–0.470 | **0.540–0.600** |
| `blocking_issue_remaining` | 0.260–0.370 | 0.340–0.380 |
| `evidence_matches_claim` | 0.430–0.480 | **0.230–0.260** |
| `needs_more_verification` | 0.670–0.700 | 0.700–0.730 |
| `ready_to_finish` | 0.500–0.540 | 0.530–0.570 |

每一个问题都有波动；没有一个是常量。同一个 state 可能回来是 `0.48`，也可能是 `0.52`。

其中两个偏移是这次改写的目标，有一个不是：

- **`requirements_satisfied` 越过了 P4 边界**（0.40）。同一个 state 过去会因为 `req < 0.40` 被阻断，
  现在落在它之上，因为这个问题不再询问某个仓库。
- **验证类问题上升了约 0.12**，因为一个任务不再因为没有测试而被扣分。
- **`evidence_matches_claim` 下降了约 0.20，而这不是有意为之。** v2 的措辞要求把声明与「只有那些被记录
  的条目」相比，这比 v1 的表述更严格：探测所用 state 的声明提到了 state 并未记录的具体计数，于是诚实的
  答案变成了「没有依据」。因此 P6（`evidence_matches_claim < 0.50`）在那个 state 上触发，而过去是 P4
  触发。在 `policy_v 2` 下净效果是这个 state 仍然被阻断，只是由另一条规则阻断 —— 正是这个发现终结了
  调参。在 `policy_v 3` 下 `P4` 和 `P6` 都只是建议性的，所以这个 state 被记录了两次，而两者都不对它
  采取行动。

这种严格性是一个缺陷还是正确的读法，取决于真实任务，而这正是 8 任务轮次要回答的问题。要关注的信号是
**一个明显已完成的任务上出现 false block**。

噪声本身带来三个后果，没有一个是可选的：

1. **把阈值放在真实取值落点上的阈值，有一部分是在噪声上做决定。**
   `requirementsUnsatisfiedBelow` 是 0.40，而真实测量值落在 0.26-0.54。
   `blockingIssueAtOrAbove` 是 0.65。两者都落在它们所评判的数值的离散范围之内。
2. **小于离散度的前后差异不算证据。** 这不是假设：v2/v3 的 artifact 对比一开始看起来像有四个任务改善
   （`requirements_satisfied` 上 0.06-0.10）。只有其中一个 —— 创建文件的那个任务，**+0.27** —— 通过了
   这个检验。
3. **阈值必须连同容差一起给出，并且选在远离数据中心的位置**，而不是拟合到一个单次观测上。

重复次数是论断的一部分，不是细节：5 次重复把离散度界定为 0.06，看起来很让人安心，而 8 次重复发现了
0.11。**把这里的任何数字都当作下界。**

这三条后果当初是作为调参的告诫写下的。`policy_v 3` 就是把它们当作结论来执行的结果：如果一条边界无法
在不落进噪声内部的情况下放置，而且没有任何阈值移动能修好一个 block-first 的失败，那么诚实的做法就是
停止在那个信号上花费中断。这就是为什么这个版本是一次收缩，而不是再一次调参。

### 这对 artifact 结果的影响

创建文件的那个任务把 `ready_to_finish` 从 0.38 移到了 **0.72** —— 而 `P8_finish` 的门槛是 0.75。
这是 0.03 的差距，而该问题的实测离散度是 0.04，所以那一轮是否完成是由采样决定的，而不是由证据决定的。
artifact 修复是真实的，也大到足以测量；但它还没有大到能让结果稳定。

在 `policy_v 3` 下这种不稳定性不付出任何代价：`P8_finish` 和 `P9_default_pass` 都允许这一轮通过，
于是采样现在只决定这一行以哪个名字被记录。这正是这次收缩要把一类风险转换成一类标签的那种发现。

那次测量是在 `prompt_v=1` 下取得的，而措辞此后已经改变 —— 见下面的确定性表，同一个 state 在每个版本下
得分不同。两个版本的数字不可互换，每一行上的 `question_set_hash` 才是区分它们的东西。

## 成本控制

三种机制把调用次数维持在每任务 1–3 次：

1. **`maxAssessments: 3`** —— 每个用户任务的硬上限。一条新的用户消息会重置这个预算。
2. **评估指纹** —— 如果材料事实自上次评估以来没有变化，就跳过 Jev 调用。一个被干预过的轮次以完全
   相同的证据再次停下，就是同一个情境；Jev 会返回同一个答案。
3. **跳过非编码轮次** —— 没有 tool call 的轮次没有什么可验证的。这是节省调用次数最大的单一来源，
   因为一个会话里大多数轮次都是对话。

这里故意**没有基于时间的冷却**。它是任意的（为什么是 20 秒？），而且它既可能压掉一次真实的重新评估，
也可能仅凭挂钟上的运气放行一次毫无意义的评估。指纹以因果的方式做决定。

## 目录结构

```
lib/
  index.js       plugin entry: hooks, throttle rules, fail-open guards
  jev.js         hand-written System One client; strict validation (no SDK, no deps)
  questions.js   the 7 noul questions, versioned by PROMPT_VERSION
  taskstate.js   evidence derivation + staged compression
  fingerprint.js material-facts hash (what counts as "changed")
  policy.js      decide(): PURE, replayable, all thresholds in one table
  log.js         JSONL rows (assessment / skip / outcome) + ground-truth backfill
  health.js      READ-ONLY summary of the log; writes nothing, calls no model
  state.js       in-process per-session state
  git.js         read-only git evidence via ctx.shell
  tokens.js      calibrated token estimator (no tokenizer)
  build.js       BUILD_ID: hash of the shipped sources, so a row is attributable
tools/
  analyse.mjs    offline: summary + threshold replay over the shadow log
  build-id.mjs   recompute/verify BUILD_ID
  fix-mojibake.mjs  detect text a PowerShell round-trip damaged
  decode-session.mjs  read a real session log (concatenated zstd frames)
  set-key.mjs    place the API key with hidden input; never echoes it
  verify-task-boundary.mjs  prove the allow-list against a live session's sources
  verify-*.mjs   the contract probes, kept as reproducible evidence
test/
  pure.test.mjs          the pure modules
  integration.test.mjs   the plugin against a fake DSH context
  real-fixtures.test.mjs regressions locked to captured live data
  fixtures/real-rows.json  the captured data (nothing here is hand-written)
```

`lib/` 里除 `index.js` 和 `git.js` 之外的一切都是**纯的或边界注入的**，因此可以在没有 DSH、没有网络、
没有磁盘的情况下测试。

## 安装

bundle patch 已经作为 profile bundle 接好了。把依赖和 bundle 条目加到
`~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "dsh-completion-supervisor": "link:C:/Users/lxb-tuf/Desktop/git cloud/dsh-completion-supervisor"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-completion-supervisor"]
    }
  }
}
```

然后放好 key 并**重启 DSH**（Desktop 没有 HMR —— `patchReload: "live"` 在那里不适用）：

```
npm run set-key          # prompts with hidden input, writes the file
npm run key-status       # says whether a key is in place; never prints it
```

`set-key` 写入到：

```
~/.dsh/completion-supervisor/.env
TYPESAFE_API_KEY=<key>
```

请使用脚本，而不要把 key 粘贴到某个方便的地方。密钥被泄露的三种方式，按发生频率排序：它被回显进一段
会被持久化和总结的聊天记录；它被 shell 历史或 Windows 注册表通过 `setx` 捕获；或者它被提交进版本库。
这个提示符不会向终端写回任何东西，直接拒绝非 TTY 的 stdin（通过管道传入的 key 已经存在于某个文件或
命令行里了），并且把值排除在进程参数列表之外。

该文件由插件自己读取，位置在 DSH home 内部 —— 在每个仓库之外，就在决策日志旁边。它不可能被误提交，
一个项目里的 `git status` 也永远不会显示它。环境变量 `TYPESAFE_API_KEY` 同样有效，并且优先级更高；
裸 key、`KEY=value` 行和带引号的形式都被接受。

**为什么插件自己读文件，而不是依赖 harness 来做。** `dsh-app-boot` 导出了一个 `loadEnv()`，它调用
`process.loadEnvFile('.env')`，而且它的文档注释承诺的行为正是这份 README 过去所暗示的。在已发布的
Desktop 构建里，那个函数**被定义了但从未被调用** —— 对整个 app 目录树做递归搜索只找到三处引用，
全部在它自己的定义行和导出行上。所以用户创建的 `.env` 会被静默忽略，而唯一的症状是 `present: false`，
读起来像 key 有问题，而不是文件没被读取。在插件里读取它，使这条说明在任何启动器下都成立。

key 永不被打印、永不被写进日志行、永不被提交。两道独立的 guard 强制实施「日志」这一半：JSONL writer
会从每个被序列化的行里脱敏 key，而每一条 logger 输出在发出之前都会被清洗。两者都存在，因为现实的泄露
不是故意的 `log(key)` —— 而是一个上游错误字符串引用了它拒绝的那个 header，并且它有两个落点。

## 验证它正在运行

让 agent 调用 `completion_supervisor_status`。它会报告模式、key 是否存在、**是哪个来源给出了答案**、
阈值、版本标记、`BUILD_ID`、被跟踪的会话，以及失败计数器。

status 工具会实时重新读取 key，而不是只报告插件加载时冻结的值。如果你刚刚放好 key，那一行会说明这一点
并告诉你需要重启 —— 而不是留给你去解读一个没有解释的 `present: false`。它报告来源（环境变量，或文件
路径），从不报告值。

重启之后第一个要读的字段是 `BUILD_ID`。如果它与源码树里的 `node tools/build-id.mjs --check` 不一致，
那么正在运行的插件比代码旧，而自重启以来写下的每一行都来自那个更旧的构建。这不是理论上的担忧：第一次
安装期间，一次重启加载到了已修复的 writer，而 reader 的修复还在等待中，结果那些行看起来自相矛盾 ——
`repo_available` 出现在 `changed_fields` 里却不在 `facts` 里 —— 而行里没有任何东西能解释它。

环境变量只在插件加载时读取一次，所以 `TYPESAFE_API_KEY` 也需要重启才能被加载。

## 一眼看清健康状况

`completion_supervisor_health`（一个 agent 工具）和 `/supervisor`（一个 slash command）仅凭决策日志
回答「它最近一直在正常工作吗？」，不需要手工逐行读。一个可选参数 `limit`（默认 50，被限制在 1..500）：

```
/supervisor                    # at the prompt — no model, no tokens
/supervisor 100

completion_supervisor_health           # the same report as a tool, for the agent to call
completion_supervisor_health limit=100
```

这个 slash command 之所以存在，是因为「让我看看判定结论」是人对 UI 提的问题，而不是让模型去解释的请求：
它运行在 command runtime 里，从不进入一个轮次，也不可能在被转述给读者的路上被改写。工具保留下来，是
为了 agent 在调查某个东西时需要这些数字的场景。**两者渲染出完全相同的字节** —— 一个报告构建器，
并且有测试断言两个输出完全相同，因为面向两个读者提供两个界面是可以的，而两个事实来源不行。

它被命名为 `/supervisor` 而不是 `/health` 是有意的：这是一个处在共享命令命名空间里的第三方插件，
那个通用词会和第一个想要它的无关东西撞名。`/supervisor` 也为后续的子命令留了空间。

```
Completion Supervisor Health

Mode: INTERVENTION
Build: c3cf56013b16
Policy: v2
Task state: v4
Jev model: jev-1.13.0

Last 50 assessments
-------------------
Assessments:          50
Tasks:                34
Window:               2026-09-20T06:03:18Z .. 2026-09-20T17:37:35Z
Mixed in window:      policy_v 1,2 | task_v 1,2,3,4 | log_v 1,2 | mode shadow 48 / intervention 2
Jev successes:        48
Jev failures:         2  (no_key 1, timeout 1; fail-open, the turn ended unsupervised)
Actual steers:        1
Steer suppressed:     42  (shadow_mode 42)
Gray-zone cases:      1
Advisory P6 hits:     1

Jev latency:          48 samples | avg 986 ms | p50 1041 ms | p95 1584 ms | max 1901 ms

Steers by reason:
  P4_requirements_unmet (requirements)    1

Most recent steer:
  time:  2026-09-20T17:31:00.016Z
  task:  57cbd8f4#task1
  rule:  P4_requirements_unmet
  req:   0.28   blk: 0.31   gray_zone: false
  goal:  "已重启"

Health: CHECK
- recent_steer_needs_review: true — 1 steer(s) in the last 50 assessments; whether a given one was
  CORRECT depends on the task's meaning, which this command cannot judge
```

那个窗口是在 `policy_v 2` 生效期间取得的，并且横跨两个策略版本，这就是为什么 `Steers by reason`
里写的是 `P4`。一个完全在 `policy_v 3` 下记录的窗口不可能产生这样一行：唯一会干预的规则是
`P1`/`P2`/`P3`。

在读一个 v3 窗口之前，有一件事需要知道。`Advisory P6 hits` 是一个早于这次收缩的单规则标签，而报告
对象已经以 `steer.advisoryHits` 携带了完整分解（`P4`、`P5`、`P6`、`P7`）。对一个 v3 窗口来说，最重要
的数字是 `P4_requirements_unmet`，因为它统计了在 `policy_v 2` 下这个插件**本会**中断的轮次数。
`Gray-zone cases` 是更宽的计数 —— 被观测区间标记、而没有任何东西对其采取行动的轮次。

### 它只是读取器，仅此而已

它打开 JSONL 来读取。它不写任何行、不调用任何模型、不碰任何 supervisor 状态，也无法改变任何决策。
缺失的、空的、不可读的或部分格式错误的日志会产生一份报告，而不是一个异常。

它被有意设计成与 `completion_supervisor_status` 不同的工具，后者从它内存中持有的值来描述正在运行的
进程。两者读取的地方不同 —— status 可以在一台从未评估过任何东西的机器上工作，health 工作在一个不记得
任何轮次的进程里 —— 把它们合并成一个输出，会产生来自两个来源的数字，而没有任何东西说明哪个是哪个。

### 它永远不会说「false positive」

读者最想先得到答案的问题 —— 那次干预是不是错的？ —— 需要任务的含义，而任务的含义活在对话里，不在
日志里。所以报告携带的是 `recent_steer_needs_review: true`，永远不是 `false_positive`。一个声称自己
知道的确定性计数器会被相信，而「被相信」恰恰使它比完全没有计数器更糟。

### 这些数字的含义

- **`Jev failures`** —— 没有从 Jev 得到答案的评估。每一次都是 fail-open，所以那些轮次是在无人监督下
  结束的。括号里按 `jev_error.kind` 拆分它们：`no_key` 是配置故障，`timeout` 是一次服务中断，两者
  需要不同的应对。
- **`Steer suppressed`** —— 策略想行动而一个运行时限制阻止了它（`shadow_mode`、
  `per_task_steer_budget`）。与 `Actual steers` 不同，后者是实际发生的事。
- **`Mixed in window`** —— 只有当窗口横跨一次变化时才打印，它是那行诚实声明。`would_steer`、
  `gray_zone` 和 `advisory_rule` 是在 `log_v 2` 中加入的，所以在更旧的行上，报告从这些行确实携带的
  `action` + `enforce` 重新推导「想行动」，而不是报告一个好看的零。`gray_zone` 和 `advisory_rule` 在
  那些行上确实没有值，而 `task_v 1-2` 的行是在缺少 artifact 和命令输出证据的情况下到达 Jev 的，
  那些证据是更晚的行才有的。
- **`Jev latency`** —— 只统计成功的调用。一次超时会贡献它的完整超时值，那测量的是超时设置而不是服务。

### 判定结论

`Health: OK` 或 `Health: CHECK`，由对字面存在于行中的字段做比较而生成。`CHECK` 在以下任何一种情况下
触发：正在运行的 `BUILD_ID` 与最新被记录的行不同；自那一行以来发生了模式变化；最近 20 次评估中有两次
或更多 Jev 失败；连续五次尾部失败；一次干预（会抬高 `recent_steer_needs_review`）；一个任务被干预
两次；一次干预超过了 `maxSteersPerTask`；一行无法解析；最近 20 行内出现 `no_key`；窗口内有多于一个
Jev 模型在作答；日志缺失。每一行都会指出它来自哪个字段。

`no_key` 和失败检查故意只看最近的尾部而不是整个窗口：在 key 安装之前写下的一行是历史，而一个会一直
触发直到它滚出窗口的检查，正是读者学会忽略它的方式。当下缺失的 key 会让每一个新行都失败，所以尾部
也能捕捉到那种情况。

有一种情况被故意**不**设为检查，而它正是读者最先遇到的那个。与最新被记录的行不同的 build id，在那一行
是在**本进程启动之前**写下的时候只是一个 `note:` —— 那是重启之后的正常状态，在第一个轮次被评估之前
—— 只有当那一行是在我们启动之后写下的，才是一个检查，而那意味着有别的什么东西在往这个日志里追加。

那个看起来显而易见的判据 —— 构建自身的时间戳 —— 是**错的**，这被记录下来是因为它被试过：一个旧进程
会继续写行，即使新构建已经落地，因为源码变化时没有任何机制会重启它。这个检查的第一个版本把最新行与
`BUILD_AT` 比较，并在第一次真实运行时就拉响了 stale-code 警报 —— 那一行是在构建之后 58 秒、新进程
启动之前 40 秒写下的。进程自身的启动时间是可靠的，理由不依赖时间上的运气：这个进程写下的每一行都
携带它的 build id，所以比进程更旧的一行不可能是我们的。把这件事做错意味着警报在每次重启时都触发，
而那正是「一个本来有效的警报变成被忽略的警报」的方式。

## 上线过程与干预边界

先跑了三轮影子运行。开启干预的闸门是一次离线 **replay**，而不是样本数量 —— 见下面的「验证过什么」。

### 两个区间，以及它们现在还能决定什么

**决定什么被记录下来的阈值，不是决定什么被执行的阈值。** 自 `policy_v 3` 起，两者都不再决定任何被执行
的事情 —— 两者都只是记录 —— 而它们仍然被分开保留，因为它们回答两个不同的问题。

| band | requirements | blocking | 它做什么 |
|---|---|---|---|
| observation | `< 0.40` | `>= 0.65` | 作为 `shadow_rule` 记录在该行上。让新行与磁盘上已有的每一个影子轮次的行保持可比。 |
| intervention | `< 0.30` | `>= 0.75` | 作为 `advisory_rule: P4_requirements_unmet` 记录在该行上。不干预任何东西。 |

所以 `advisory_rule: P4_requirements_unmet` 的含义恰好是*「这一轮在 `policy_v 3` 之前本会被中断」*。
这使该字段成为「这次收缩去掉了多少次干预」的计数，而如果任何人想为把它们拿回来辩护，这就是要盯的
数字。

`advisory_rule` 是相对于干预区间而不是观测区间来测量的，这是有意的：`requirements_satisfied` 在所有被
记录的行上的中位数是 0.27，所以一个 0.40 的检验会在大约一半的轮次上触发，并把 `P5`/`P6`/`P7` 藏在
它后面 —— 这与保留 advisory 的目的正好相反。

`P4`、`P5`、`P6` 和 `P7` 是**建议性的**：被求值、被记录、无法干预。`P1`、`P2` 和 `P3` 直接干预，因为
它们比较的是 code 算出的事实，而不是概率。其他任何东西都不可以行动。

`gray_zone: true` 意味着观测区间标记了这一轮，而没有东西对它采取行动。在 `policy_v 3` 下，这正是它
标记的*每一个*轮次上发生的事，所以这个字段现在是「插件选择不去管的轮次」的完整计数，而不是两个区间
之间一个狭窄的中间地带。

### 为什么概率是被弃用而不是被重新调参

四项测量，全部可以从日志中恢复：

- **从来没有被确认的 `good_block`。** 141 行、97 次评估、68 次 Jev 调用 —— verdict 路径存在，而没有任何
  一行走过它。
- **11 次由概率驱动的 `P4` 触发，复核时没有一个被确认是必要的。**
- **唯一一个真正到达用户的干预被记录为 `false_block`**（`applied=true`，09-20T17:36）。用户自己的备注
  说前提是可辩护的，而被干预的体验是不受欢迎的 —— 这正是这个插件一直陈述的不对称性：一次错误的干预
  比一次漏掉的干预代价更高。
- **信号的波动和它自己的决策间隙一样大。** 同一个 state 反复发送：离散度 0.04–0.11
  （`tools/probe-determinism.mjs`）。`needs_more_verification` 在 68 次调用中从未低于 0.64。

一个没有被测到的真阳性、噪声和它的阈值间隙一样大、且失败模式会打断别人工作的信号，不应该再花费真实的
中断。删除它也会删除证据，所以这些数字仍然在每一个轮次上被收集。

**这是一个终态，不是一个步骤。** 插件处在 `deterministic enforcement + Jev observation` 模式，不再被
校准：问题集、每一个阈值取值和评分尺度都已冻结，没有进一步的调参计划。任何想把一个概率重新拿回决策的人，
应该从此刻起写下的行上的 `advisory_rule` 计数来论证 —— 而不是再来一次阈值扫描，那正是这个版本所终结的
练习。

### 为什么 P6 不再阻断

它在 **12 个带标签的样本上触发了四次，每一次都是 false block** —— 一个已完成轮次被中断 —— 而它在
任何一个确实未完成的任务上都从未触发过。每一次触发都是因为一段声明引用了某条命令打印出的文本，而 state
里完全没有它；`task_v 4` 为其中三个里的两个修复了这一点；第三个用 `pwsh` 创建了自己的文件，而这个插件
对 `pwsh` 的产物有意不去猜测。所以这条规则读到的是证据里一个真实的缺口，却把它报告成 agent 的问题。
它被保留、被计算、被记录，因为一段跑在证据前面的声明正是这个插件存在的意义所在 —— 只是它不能凭这一点
去中断任何人。

只把 P6 消音**不会**足够：在 v4 的 N2 行上，`P7_needs_verification` 触发并产生了一个换了个名字的、
完全相同的 false block。

### 现在 replay 的结果

`node tools/score-round.mjs` 把全部 12 个带标签的行通过运行中的策略重放一遍。因为 `decide()` 是纯的，
而行记录了它读取的每一个字段（`facts`，加上七个概率），所以这不需要 Jev 调用，也不需要新的采样。
在 `policy_v 3` 下：

```
steered a task that was COMPLETE     0/8   <- the number that must be 0
steered a task that was INCOMPLETE   2/4
missed an incomplete task            2/4   <- the price of the contraction, stated rather than hidden
advisory rules that fired            P6_evidence_mismatch ×4, P4_requirements_unmet ×2
```

**读第三行，而不只是第一行。** 四个未完成的行里有两个不再被抓住。两者都是 `N4`，「下载一个不存在的
URL」—— `task_v 3` 和 `task_v 4` 下的同一个任务 —— 而对照行就是那个 `blocking_issue_remaining` 落在
0.77、对着 0.75 边界的行（见 [止损](#止损stop-loss)）。仍然被抓住的两个是由确定性规则抓住的，
`P1_unresolved_errors` 和 `P3_failing_tests`，这正是这个分裂的形状：存活下来的规则比较的是事实，
不依赖任何概率越过任何东西。

失去那些行是一个关于「哪种错误更糟」的判断，而不是一次测量，而立场就是 `lib/policy.js` 头部所写的
—— 中断一个正在工作的 agent，代价严格高于让一轮次以它本来会有的方式结束。附在它上面的诚实提醒是：
这个损失背后的样本是同一个任务被评了两次，所以它比 2/4 所暗示的证据更薄。

### 干预预算

`maxSteersPerTask: 1`，故意比 `maxAssessments: 3` 更紧。评估上限界定我们**看**的频率；干预上限界定
我们**说话**的频率。一个被干预过的轮次会再次到达 `turn-stopping`，所以同一个任务的第二次评估是预期
之中的 —— 针对同一个分歧的第二次干预是一个循环，而一个循环比任何一次单独漏掉的干预都更糟。预算用尽
之后，该任务后续的轮次会以 `steer_suppressed: per_task_steer_budget` 被记录，并被允许正常结束。

每一行都把 `would_steer`（策略想做什么）与 `will_steer`（运行时限制允许什么）分开。没有这个拆分，
一份安静的日志无法区分「一个健康的策略」和「一个被耗尽的预算」，而这两者需要相反的应对。

### 止损（Stop-loss）

**第一次明确的 false block 就把它切回影子模式。** 具体地说：一个被干预的轮次，而工作实际上是完成的，
这是从 agent 自己的 transcript 判断的，而不是从 supervisor 的行判断。回退是一行 —— `cordis.patch.yml`
里的 `shadowMode: true` —— 外加一次重启。

自 `policy_v 3` 起这条规则基本上处于休眠状态，而说出这一点比留下一个没有东西可以触发的承诺更好：
剩下的唯一干预来自 `P1`/`P2`/`P3`，它们是记录事实中的矛盾 —— 一个失败的退出码、一个背后没有运行的
声明、一个未解决的错误。这类干预对「它错了吗？」有一个可核查的答案，而这正是这条规则所需要的。

催生这条规则的测量，仍然是读日志的理由。在对照任务上，加入命令输出把 `requirements_satisfied` 从 0.17
提高到 **0.40**，把 `blocking_issue_remaining` 从 0.84 降低到 **0.77** —— 距干预边界 0.02。在
`policy_v 2` 下那个轮次被抓住了，勉强。在 `policy_v 3` 下它完全不被抓住，因为那条边界不再花费一次
中断。

用 `shadowMode: true`（或 `enabled: false`）加一次重启回滚。

## 如何读日志

`~/.dsh/completion-supervisor/assessments.jsonl`，三种行：

- `row: "assessment"` —— 看到了什么、Jev 说了什么、策略决定了什么
- `row: "skip"` —— 一个我们故意**没有**评估的轮次，以及原因
- `row: "outcome"` —— 用户接下来做了什么，稍后追加，通过 `assessment_id` 关联

skip 行和 assessment 行一样重要。没有它，一条触发过于频繁的规则就是不可见的，而且它压得越多分析看起来
越*健康* —— 因为它吞掉的轮次从不出现在计数里。`node tools/analyse.mjs` 之所以在 assessment 分解之前
打印 skip 分解，就是这个原因。

outcome 行是让日志可评估的东西。没有它，我们只能问「不同的阈值会做什么？」，而永远问不了「这些判断
是对的吗？」。

| verdict | 含义 |
|---|---|
| `true_pass` | 我们放行了，用户继续往下走 |
| `false_pass` | 我们放行了，用户报告了问题 —— 我们漏掉了 |
| `good_block` | 我们阻断了，agent 随后修好了它 |
| `false_block` | 我们阻断了，用户驳回了我们 —— **我们代价最高的错误** |

false-block 率高于约 10% 就是回到影子模式的信号。什么算一次明确的 false block，见上面的「止损」。

每一条 assessment 行还携带 `task_key`、`assessments_used_before` 和 `max_assessments`。它们的存在是
为了让每个任务的预算可以从数据里核查：没有它们，「一个任务里三次评估」（上限在起作用）和「三个任务
各评估一次」（重置在起作用）会产生相同的行数，而一个从未触发规则的任务不会写下任何 skip 行来区分
二者。`assessments_used_before` 记录的是预算规则实际比较过的那个值，所以它解释决策而不是跟着决策走。
`node tools/analyse.mjs` 按 `task_key` 分组，并在任何一次评估在预算已耗尽的情况下运行时发出警告。

## 版本标记

每一行都记录 `log_v`、`task_v`、`prompt_v`、`question_set_v`、`question_set_hash`、`policy_v`、
`fingerprint_v` 和 `build_id`。在不同措辞、阈值、模型或**代码**下产生的行不得合并到同一个分析里，
而这些字段就是读者区分它们的方式。

`question_set_v` 就是 `prompt_v`，只是换了一个说明它到底给什么做版本的名字；两者都写，是为了让磁盘上
已有的行保持可读。`question_set_hash` 是它**派生**出来的孪生字段：对问题名和指令文本、按声明顺序、
在加载时计算出的哈希。它存在是因为一个手工维护的版本号有一种静默的失败模式 —— 改了指令、忘了 bump，
于是日志就声称两个不同的问题集是同一个，从而悄悄让跨越那条边界的每一次概率比较失效。派生哈希不可能
被忘记。即使漏了一次 bump，按它分组也是正确的；而顺序是哈希的一部分，因为在一个批量请求里问题是按
索引回答的，所以重新排序会把每一个概率重新指派给另一个问题。

**当前：`prompt_v=2` / `question_set_v=2`，哈希 `d3773ecfa135493b`。** v1 是基线：七个问题是按照
「每个任务都是代码改动」写的，这使其中三个对非代码任务无法回答。v1 的行被保留，且不得与 v2 的行在任何
概率上合并 —— `question_set_hash` 是区分它们的字段，而 `lib/questions.js` 里的 `readProbability`
存在的意义是让读者仍能跨两者显示一列，因为改名后的 `tests_sufficient` / `verification_sufficient`
在两者中含义相同。

`build_id` 是已发布源码的哈希（`node tools/build-id.mjs`）。它存在是因为当*读取端*被修复时，形状版本号
不会改变：第一次安装之后，写下的行里 `repo_available` 出现在 `changed_fields` 中却不在 `facts` 中，
因为 writer 被重新加载了而 reader 没有。行里没有任何东西说明这一点，而这种不一致看起来像是 flakiness。
当一行的 `build_id` 与 `node tools/build-id.mjs --check` 不同时，正在运行的插件早于这些源码。

`task_v` 是在比较 Jev 被**展示**了什么时要读的那个。当前：**4**（v3 下 `activity` 中的 artifacts，
v4 下的命令输出 —— 两者都在下面），而 `fingerprint_v` 是 **3** 以与之匹配。这两处改动都是有意作为
`task_v` 的 bump 而不是 `prompt_v` 的 bump：七个问题未被触动，所以 `question_set_hash` 不变，
v2/v3/v4 的行在**被问了什么**这一点上保持可比 —— 这正是让校准问题（「是缺失的证据还是措辞？」）可以
通过比较分组来回答的原因。它被回答了，而答案是证据，不是措辞；见下文。一次 `prompt_v` 的 bump 会让
每一次比较都失去所有更早的行。

`policy_v` 是在**决策**改变而不是问题或 state 改变时要读的那个。当前：**3**。它升到 3 是因为 `P4`
不再干预，于是同样的概率再次产生不同的判定，v2 的行不得与 v3 的行合并。这两次 bump 干净地分开：
v1 和 v2 的差别在*哪些规则可以行动*，v2 和 v3 的差别在*是否任何概率可以行动*。`log_v` 是 **2** 且
没有变动：它自己的那次 bump 有一个匹配的原因 —— v1 的行早于 `would_steer`、`will_steer`、
`steer_suppressed`、`steers_used_before`、`max_steers_per_task`，以及 `enforce` / `advisory_rule` /
`shadow_rule` / `gray_zone` 这些字段 —— 而 v3 是停止**读取**字段而不是新增任何字段，所以行的形状
完全相同，一次 bump 会暗示一种读者找不到的差异。

### 实际作答的是哪个模型

在 `jev` 内部，每一行携带两个模型字段：

| field | 含义 |
|---|---|
| `model_requested` | 我们请求的别名 —— `jev-latest` |
| `model` | API 实际作答的具体 id，如果它没有给出则为 `null` |

两者都被记录，因为**一个阈值就是关于某个模型的论断**。`jev-latest` 是一个会移动的别名，所以一份只记录
别名的日志无法回答那个决定校准是否仍然有效的问题：这些行写下之后，别名背后的东西变了吗？一旦返回的 id
被确知是一个具体版本，阈值就绑定到那个版本而不是别名。

当响应省略 `model` 时它保持为 `null`，而不是回退到请求的别名。回退会断言一个没有任何东西确认过的具体
版本，而之后的读者会把它当作校准仍然有效的证据。

## 超时

`jevTimeoutMs` 在**校准阶段是 5000ms**，高于插件起始时的 3000ms。

一次超时是一次*丢失的观测*，而不只是一行慢记录：最初四次真实调用中就有一次在 3000ms 超时。如果缓慢
与庞大或含糊的 state 相关 —— 也就是那些有意思的 —— 那么把它们掐掉就会让样本偏向容易的案例，这与校准
阶段的目的正好相反。

在关闭 `shadowMode` 之前，这个数字必须**降下来**。那时它处在 turn-close 路径上，用户要等它，所以这个
值必须来自实测分布（每一行都记录 `latency_ms`），而不是来自这个默认值。

## 真实的契约：实测而非假设

下面七条事实是通过读取一份真实会话日志和一个真实 shell 确立的，每一条都推翻了一个合理的假设。它们被
记录在这里，是因为 `test/fixtures/real-rows.json` 和 `test/real-fixtures.test.mjs` 里的 fixtures 把它们
锁定了。

1. **`tool/call.data.arguments` 是一个 JSON 字符串。** DSH 把模型的原始参数文本原样写出
   （`dsh-agent-loop/lib/index.js:687-695`），只在执行路径上解析它。一个只接受对象的读取端会对*每一次*
   调用都看到 `{}` —— 这不仅丢失一个字段，它会把「agent 跑了测试而且它们通过了」变成「agent 声明了
   从未运行过的测试」，也就是对一轮诚实轮次的捏造指控。

2. **Shell 状态标记位于结果的末尾。** `renderPwshResult`（`dsh-tool-pwsh/lib/index.js:59-79`）把
   `[exit code: N]` 追加为最后一行，而在成功时完全省略它。所以一个从前缀截断的读取端会在任何长输出上
   丢掉这个标记 —— 而一个失败的测试套件恰恰正是产生长输出的那种情况。在一次真实的 31k 字符运行上实测：
   从头部读取在读到一个断言中间就结束了，缺失的标记意味着「exit 0」，于是一个**失败的套件被记录为
   通过**。Tool 结果因此改为从尾部读取。

3. **退出码是 shell 宿主进程的，不是子进程的。** 一个裸的 `node -e "process.exit(7)"` 报告
   `[exit code: 1]`，因为 pwsh 会规范化非零的子进程状态。追加 `; exit $LASTEXITCODE` 才能把真实值传递
   出来。所以这个标记对「零 vs 非零」是权威的，但绝不能被引用为某个子进程的确切状态。DSH 自己的
   `parseExitStatus`（`dsh-shell/lib/index.js:31-46`）读的正是这个标记，不读别的。

4. **`git` 可用与「没有变化」不是一回事。** `collectGitFacts` 返回 `available`，而这里的默认工作区
   *不是*一个仓库 —— 所以每个计数都是 0，而天真的读法是「一棵干净的树」。`repo.available` 是 TaskState、
   指纹和每一行日志的一部分，这样「什么都没变」和「我们没法看」永远不会被之后的分析混淆。

5. **一条 `user/message` 通常不是用户。** 这是造成损害最大的缺陷，因为它的两个影响都是静默的。在一个
   真实会话上实测（4125 个事件，用 `tools/decode-session.mjs` 解码），`user/message` 的来源是：

   | source | count | 它是什么 |
   |---|---|---|
   | `user` | 14 | 人类 —— 唯一的任务边界 |
   | `subagent-settled` | 13 | 一个子 agent 完成 |
   | `plugin (hindsight)` | 9 | 记忆注入 |
   | `agent-message` | 6 | 另一个 agent |
   | `agent-instructions`、`skill-catalog`、`plugin (dsh-system-prompt)`、`plugin (compact)`、`plugin (agent-mailbox)` | 5/5/5/4/3 | DSH 机器消息 |

   代码只排除了 `plugin` 和 `tool`，然后把其他一切都当成人类接受。于是每一条 `subagent-settled` 和
   每一次 `hindsight` 注入都会开启一个「新的用户任务」并重置每任务的评估预算 —— 每任务 3 次的上限静默
   地不再存在，而由于一次重置不是错误也不写任何行，日志自始至终看起来都很健康。更糟的是，`goal` 取的是
   *第一个*符合条件的消息，而那个会话里的第二条 user 角色消息是一个 `agent-instructions` 块：Jev 可能
   被问到「一个**系统提醒**是否已完成」。

   修复方案是一份允许列表，`isUserAuthored(source) → source?.kind === 'user'`（`lib/taskstate.js`）。
   一个未来的合成来源现在默认为「不是人类」，这倾向于评估更少，而不是倾向于无上限的预算或捏造的 goal。
   注意 DSH 自己的 `MessageSourceMap` 是一份*类型*声明：它列出了 `skill-invocation` 和 `team-message`，
   而运行时发出的是 `agent-instructions` 和 `skill-catalog`，后者它根本没有命名。这个差距就是为什么
   靠读类型无法让一份拒绝列表保持正确。

   **这个修复是如何在一次真实运行上验证的**，而不只是在测试里。一个 subagent 会话是在修复后的插件加载
   *之后*创建的，并且被安排去派生一个嵌套的 subagent —— 这正是产生 `subagent-settled` 消息的东西。
   它的会话日志随后包含一条人类消息和四条合成消息（`agent-instructions`、`skill-catalog`、
   `agent-message`、`subagent-settled`），而它的评估行记录的是 `#task1`。在旧的拒绝列表下，那个会话
   会被算作五个任务并重置预算四次。`npm run verify-boundary -- <session-id>` 可以重现这一点：它解码
   一份会话日志，按来源统计 user 角色的消息，并把被记录的 `task_key` 增量与每个修订本会算出的结果做
   比较。

6. **退出码并不总是属于那条命令。** DSH 的 `[exit code: N]` 标记携带的是 **shell 宿主进程**的退出码，
   而在 Windows PowerShell 里那是**最后一条语句**的退出码。因此，一个为了捕获输出而包装调用的 agent
   会把真实结果藏起来。用 `tools/measure-exit-shapes.mjs` 实测，该脚本对每一种形状都真实运行：

   | shape | observed | faithful? |
   |---|---|---|
   | `npm test` | 1 | yes |
   | `npm test 2>&1 \| Select-Object -Last 3` | 1 | yes |
   | `cd <dir>; npm test` | 1 | yes |
   | `npm test; exit $LASTEXITCODE` | 1 | yes |
   | `npm test; Write-Output "after"` | **0** | **masked** |
   | `npm test > $null 2>&1; Write-Output "after"` | **0** | **masked** |
   | `$out = npm test 2>&1; $code = $LASTEXITCODE; Write-Output "…"` | **0** | **masked** |

   在第一个真实 Jev 轮次里，一个 subagent 写下了最后那种形状，于是一个真的失败了（npm exit 1）的套件
   被记录为 `tests_passed: true`。agent 的声明是诚实的；**插件的证据是错的** —— 这正是这个插件存在的
   意义所要防止的那一种错误，而它由插件自己产生。

   这台机器上没有安装 PowerShell 7，所以 `dsh-pwsh-local` 回退到 5.1，而 5.1 的行为才是要紧的契约。

   修复不是停止信任退出码，而是记录它*是**谁**的*退出码。只有一条语句时，标记就是命令自己的；有多条时
   它属于最后一条，除非最后那条语句是显式的 `exit $LASTEXITCODE` 透传。`exitCodeIsAttributable()`
   实现的正是这条规则，并且与每一种实测形状都吻合。一条无法归属的命令对**两种**结果都不投票，于是判定
   变成 `null`（未知）—— 记录 `true` 是那个 bug，而记录 `false` 则会对一轮诚实的轮次捏造指控。
   `facts.unattributable_exits_n` 让这个比率可以离线测量，而 `tools/replay-real-commands.mjs` 重放真实
   会话里的逐字命令，以证明没有任何失败运行被误读。

   **三种状态，以及每一种的含义。** `tests_run` 说明到底有没有东西运行过；`tests_passed` 是一个独立的
   三态字段，它的 `null` 是一个真实答案而不是缺失值：

   | `tests_run` | `tests_passed` | 含义 |
   |---|---|---|
   | `true` | `true` | 一次运行成功了，而且被记录的退出码确实是那次运行的 |
   | `true` | `false` | 一次运行失败了，而且被记录的退出码确实是那次运行的 |
   | `true` | `null` | 运行发生过，但它的结果无法被诚实地读出 —— agent 包装了这次调用 |
   | `false` | `null` | 没有运行被记录 |

   `null` 从不投票给成功或失败；它把 `tests_passed` 降级为「未知」，而不是朝任一方向猜测。
   `npm run verify-tristate` 端到端地证明这一点而不是靠构造：它解析出 DSH 解析出的同一个 shell，
   在子进程里运行真实命令，用 DSH 自己的渲染规则（`renderPwshResult`，转录自
   `dsh-tool-pwsh/lib/index.js:60-80`）塑造输出，并把得到的事件喂给真实的 `deriveEvidence`。它报告
   五个案例 —— 包括一个它预期会弃权的案例。

7. **一条 `assistant/message` 携带模型的私有推理，而且它也有一个 `.text`。** 真实会话里最常见的形状是
   `[reasoning, text, tool-call]` —— 在一个 160 行的会话里 23 条 assistant 消息中有 11 条如此，
   `[reasoning, tool-call]` 有 5 条、`[reasoning, text]` 有 3 条。`reasoning` 和 `text` 块都暴露一个
   `.text` 字符串，所以一个把所有带 `.text` 的块连接起来的读取端，会产出「模型在思考」后接「模型在回复」，
   而在一次 4000 字符的头部读取里，思考会占满预算，回复被完全截掉。

   用 `node tools/decode-session.mjs --match <session-id> --blocks` 实测，它并排报告两种规则：在那个
   会话上，两种规则在 **23 条 assistant 消息中的 23 条**上都不一致 —— 100% 的污染率。所以 `claim`
   每一次都是一份**草稿**：

   | rule | 一次真实轮次上的 claim |
   |---|---|
   | old（任何带 `.text` 的块） | `用户只发了"？"——可能是在问"怎么了/为什么停了"？我上一条回复被截断了…` |
   | new（仅 `type === 'text'`） | `上一轮回复被截断了，任务没停。现在直接下安装包。` |

   后果在原因之前就已经在数字里显现：**在每一次真实评估上**，`evidence_matches_claim` 都停在
   **0.10–0.34**。Jev 被问到 agent 的最终总结是否有被记录的证据支持，而给它看的却是模型在思考该下载
   哪个浏览器。那里出现一个低概率是*对实际被问到的那个问题的正确答案*，这使它成为代价最高的那一类
   缺陷：分数看起来像校准问题，于是本能是去移动一个阈值 —— 而没有任何阈值能修复读错了文本。

   还有一个比低分更糟的二阶效应。`detectUnverifiedClaims` 对 claim 跑正则，所以一个模型*在想*
   「我应该在说测试通过之前先检查一下」会被匹配成「声明了测试通过、却没有记录到测试命令」——
   一次**对诚实轮次的捏造指控**，策略随后可以据此阻断。

   修复方案是一份允许列表（`block.type === 'text'`），理由和 `isUserAuthored` 一样：一个新的私有块类型
   绝不能静默地变成面向用户的文本。代价是不对称的 —— 漏掉一个块只损失一点上下文，而放进一个块会把思考
   塞进 claim 并可能阻断一轮诚实的轮次。现在一条只有 reasoning 的消息会让 claim 保持不变，而不是覆盖它，
   所以一轮里最后一次 tool call 无法决定 Jev 被问的是什么。

## 一轮产出了什么（artifacts）

`repo.changed_files` 曾是「这一轮产出了什么」的唯一通道，它来自 `git status`。在这台机器上默认工作目录
**不是 git 仓库**，所以那个列表一直是空的：一个创建了文件的轮次到达 Jev 时没有任何关于它的证据。Jev
随后被问到「仓库状态是否满足用户的请求」，什么也看不到，并在**每一次真实轮次上**把
`requirements_satisfied` 答成 **0.26-0.48** —— 低到足以在事实上完整的轮次上触发 P4 阻断规则，那是在
P4 还能干预的时候。这个 0.27 的中位数也正是为什么 P4 advisory 是相对于干预区间而不是观测区间测量的。

`lib/artifacts.js` 从唯一一个不需要推断的来源填补这个缺口：那些声明了路径的 tool 的**结构化参数**。

| tool | argument | 含义 |
|---|---|---|
| `write` | `file_path` | 产出 |
| `edit` | `file_path` | 产出 |
| `present` | `files[].path` | 产出 |
| `read`、`read_image` | `file_path` | 只是访问 —— 不是产出 |

这个排除本身就是设计。**一条 shell 命令永远不会被解析以推断它可能产生的副作用。**
`Invoke-WebRequest -OutFile x`、`New-Item x`、`Set-Content x` 和 `npm run build` 都会创建文件，而除了
一个 shell 解释器，没有别的东西能说出是哪些 —— 在真实日志上实测，全部 545 次 `pwsh` 调用只携带
`command/description/workdir/timeoutMs/run_in_background`，而**全部 1375 条 tool 结果都是纯文本**
（`[text]`）。猜测会把一个捏造的路径放进整个判断所依赖的 state 里，这与把一个被包装过的退出码读成通过
是同一类错误。

未知 tool 被忽略（一份允许列表，和 `isUserAuthored` 一样），所以一个未来的 tool 是被少报而不是被误报。
`node tools/scan-tool-schemas.mjs` 的存在就是为了发现它：它报告这台机器实际用过哪些参数名，并标出那些
看起来像路径的。

### `verified_artifacts` 意味着什么、不意味着什么

它意味着**一次针对该路径的、产出性的 tool call 没有报告错误**。`isError` 是结果块上一个真实的结构化
字段，所以这是一个观测。它也**不**意味着内容被检查过：哈希、签名和存在性探测在这里由 `pwsh` 执行，
而它的结果是纯文本。该字段被设计成在有结构化来源时接受 `sha256` / `signature` / `exists`；今天没有
任何东西填充它们，而从文本推导它们会比省略它们更糟。

### 在真实会话上验证

`node tools/verify-artifacts.mjs --match <session-id>` 通过插件自己的读取端重放一个会话，并打印 Jev
会看到什么。两次真实运行：

- 一个创建了文件的 subagent：`created_or_written_paths: scratch\unverified-note.md`，同时
  `repo.available: false` 和 `changed_files: []` —— 正是过去什么都携带不了的那种情况。
- 一个浏览器下载任务：artifact
  `C:\Users\lxb-tuf\Downloads\AdsPower-Global-8.7.23-x64.exe` 被**通过 `present`** 记录下来，而紧挨着
  它的 `pwsh` 下载命令没有贡献任何东西。

第二个结果值得直白地说出来，因为这是一个真实的限制而不是一个 bug：**只有 agent 用 `present` 声明了
文件，一次下载才有证据。** 一个用 `pwsh` 下载、却从不 present 结果的 agent 不会留下任何 artifact，
而 supervisor 不会替它编造一个。

`touched_paths` 被记录，但故意**不**是指纹的一部分：读不同的文件并不能说明工作是否完成，并且会不断
变化，所以把它包含进来会破坏指纹存在的意义 —— 去重。

## 一条命令打印了什么（输出证据）

`task_v 4` 给 `commands[]` 里的每个条目加上 `output_tail`、`output_truncated` 和 `output_chars`，
因为 claim 所引用的一条事实从未到达裁判那里。

**迫使这次改动的那项测量。** 在 `task_v 3` 下，每一个被阻断的已完成轮次都是由 `P6_evidence_mismatch`
阻断的：`evidence_matches_claim` 停在 0.40-0.47，对着 0.50 的阈值 —— C1 0.42、C2 0.47、N2 0.40。
三者中 claim 都引用了某条命令**打印**出来的东西（「脚本打印了 hello, world」、「12 files, 4078 lines
total」），而 state 只携带命令文本和它的退出码，没有输出。Jev 回答该 claim 不被所记录的条目支持，
而**它是对的** —— 所以措辞并不太严格，阈值也不太低。agent 自己的话所引用的一条事实，从未被放到裁判
面前。

所以这里是补上缺失的证据，而不是放宽检验：

| field | 含义 |
|---|---|
| `output_tail` | 结果的末尾，有界 |
| `output_truncated` | 我们保留的是否少于命令打印出来的 |
| `output_chars` | **原始**字符数 |
| `output_hash` | 对有界输出的 FNV-1a —— 指纹的输入 |

**取尾部，不取头部**，理由和 `readToolResult` 一直从尾部读取的理由相同：测试摘要、总计、计数以及 DSH
自己的 `[exit code: N]` 标记都在底部。`output_chars` 是针对原始结果测量的，而不是针对 20k 的尾部窗口，
否则一份 200k 的日志描述的会是它的读取端而不是它自己。

**两个预算。** 每条命令 1500 字符，全部命令合计 4000，按**最新优先**使用 —— 最近的命令才是收尾声明所
指的那一条。十二条命令都到每条上限会是 18k 字符，塞在一个 12k token 的 state 里，那样 `fitState` 就
不得不降级 goal 和 claim —— 判断真正关于的那两段文本 —— 去给日志尾部腾地方。更旧的命令保留它们的退出
码，只失去输出，而退出码正是 `tests_passed` 的推导来源。

**指纹只取哈希，从不取文本。** `materialFacts` 会被 `JSON.stringify` 然后哈希，所以实时输出会因为一个
确定性工具打印出的任何无关字节而移动指纹 —— 日志行里的一个时间戳、一个进度计数器、一个临时路径 ——
而每一次移动都要花掉一次 Jev 调用。`output_hash` 是在共享预算运行*之前*、从一条命令自己的有界输出算出
的，所以两个相同的轮次无论后来的命令消耗了什么，指纹都完全一致。

**脱敏发生在源头。** 一个 shell 结果可能回显 agent 打印过的 token，而 state 既被发给 Jev 也被写进日志，
所以 `deriveEvidence` 会在输出变成事实之前把配置的 secret 从输出中清除（`lib/redact.js`）。
`DecisionLog` 保留它的行级清洗作为最后一道防线，而测试断言：对一个**没有**配置 secret 的日志，
`log.redactions === 0` —— 这只有在源头已经做了这件事时才能通过。

## 已知问题，故意暂不修复

**每任务的评估预算无法在重启后存活。** `maxAssessments` 是由一个内存计数器（`lib/state.js`）强制的，
所以重启 DSH 会重置它。在日志里出现过：一个 `task_key` 出现在五行上，前四行的
`assessments_used_before: 0` 且 `build_id` 各不相同。在开发期间、频繁重启的情况下，「硬上限」比它的
名字所暗示的要软。

这是故意不修的，而且它不阻碍影子运行。持久化它意味着写入读取端必须容忍的状态，而 DSH 的会话日志是
**fail-closed** 的 —— 一条读取端无法解析的自定义写入路径会让整个会话无法加载，那是一个远比多一次 API
调用更糟的结果。如果这件事真的重要，用一个以 session 或 task 为键的持久化存储来修它。

**一个用户请求并不是任务的轮次曾被干预过一次 —— `policy_v 3` 就是对它的回应。** 第一次真实干预，
记录于 2026-09-20，是这个做法的实例，它被保留在这里而不是悄悄删掉，因为它是这次收缩背后最强的单一
证据。用户的消息是一个四字符的状态确认；agent 的轮次验证了重启并报告了它，同时还重述了**上一轮**
产生的测试结果。Jev 看到的 `goal` 是那个四字符的确认，旁边是 `created_or_written_paths: []` 和
`tests_run: false`，并把 `requirements_satisfied` 答成 **0.28** —— 低于当时还能干预的那个干预区间。
`evidence_matches_claim` 回来是 **0.14**，而那个数字是对的：那段 claim 提到的结果，那一轮的 state 里
没有任何东西能支持。

所以这个判断是可辩护的，而用户体验不是，两者同时成立：

| 什么 | verdict |
|---|---|
| `evidence_matches_claim 0.14` | **正确** —— 那段 claim 确实跑在了所记录的证据前面 |
| 用户的请求已经被满足 | **也正确** —— 重启被验证并报告了 |
| 中断那一轮 | **错误** —— 用户要求的是状态检查，不是工作 |

**此后改了什么，以及为什么这不再是一个悬着的风险。** 修复不是下面提出的**非任务 guard** —— 而是移除
了一个概率进行中断的能力。在 `policy_v 3` 下，同一个轮次会记录 `advisory_rule: P4_requirements_unmet`
（以及 `P6_evidence_mismatch`）并被允许结束，因为这个案例触发的每一条规则都是建议性的。上表里的三种
读法没有改变：它们是对的，而**行动**是错的，这是一个没有阈值能据以行动的区分，而一次收缩不必去处理它。

所以非任务 guard **没有被构建**，而现在它需要的是一个与这个案例不同的理由：
`completion_supervisor_status` 和 Hindsight 工具不产生路径，非 shell 工具的输出根本不进入 state，而
一个非常短的 `goal` 让 `requirements_satisfied` 几乎没有可锚定的东西 —— 所以一个只由验证构成的轮次
仍然没有任何被记录下来的东西可以指。

升级规则，如已商定的。既然剩下的唯一干预来自 `P1`/`P2`/`P3`（它们比较的是被记录的事实而不是概率），
这条规则现在基本只是历史：

- **在一个状态确认轮次上再出现一次干预** → 是**事实**错了，因为现在只有事实能干预；去修证据提取，
  而不是加一条非任务规则
- **在一个明显正常的任务上出现一次干预** → 立即回到影子模式，不讨论
- 一次正确的干预 → 记录它并继续

## 故意不实现

周期性评估、卡死检测、worker 切换，以及模型路由。MVP 是
`turn-stopping → TaskState → Jev → decision` —— 先作为影子观察者发布，然后作为有守卫的干预者，然后在
`policy_v 3` 收缩回「确定性强制 + Jev 只做观测」的角色 —— 它从那里一步步挣得前进的资格。

同样被故意推迟的：用 material/message 的 tool 拆分来跳过评估。这两个事实被记录
（`material_tool_calls`、`message_only_tool_calls`），但没有任何东西对它们采取行动，因为一次真实轮次
显示，一个「对话型」subagent 仍然携带一个 tool call —— harness 指示它用 `send_message` 回报。
因此「它调用 tool 了吗？」不是「它做工作了吗？」的可靠代理，而在允许一条规则据它省下一次 API 调用之前，
必须先观察这个分布。这个分类器是一份拒绝列表，所以一个未知的未来 tool 会被算作 material，永远不会被
静默跳过。

## 已知约束

- **永远不要通过自定义的 `session.append(...)` 事件持久化状态。** 写入端没有白名单，所以它会落到磁盘上，
  但读取端是 fail-closed 的（`dsh-session-persistence/lib/index.js:182-197`），而 `append()` 无法设置
  `ignorable` —— 整个会话日志会变得无法加载。这个插件不向会话日志追加任何东西。
- **一个已提交的轮次无法被重新打开。** `agent/turn-stopping` 是唯一的守卫窗口。
- **`ctx.shell.run` 需要 `sandboxPolicy`** —— `dsh-pwsh-local` 的 `resolve()` 没有默认值。
- **Desktop 没有 HMR** —— 配置改动需要重启。
- **永远不要通过 PowerShell 5.1 编辑这些文件。** `Set-Content -Encoding UTF8` 会把已有文件当作 ANSI
  （这里是 code page 936）读取并重新编码它读到的东西，所以非 ASCII 文本会被静默替换。它两次消耗了真实
  时间：`lib/log.js` 里的中文正则字面量变成了 `SyntaxError: Invalid regular expression`（响亮，已修复），
  而 em dash 变成了 U+9225 + U+FFFD（静默 —— 代码仍然运行，只有读者会注意到）。PowerShell 5.1 也没有
  `` `u{...} `` 转义，所以写一个会把这六个字符按字面存储。请使用 edit 工具，或 Node。
  `node tools/fix-mojibake.mjs --check` 能检测出所有这些；`--check` 以非零退出。注意 PowerShell 的
  `Get-Content` 也会把合法的 UTF-8 CJK *显示*成乱码 —— 在断定一个文件损坏之前先用 Node 验证，因为
  日志里的中文文本是完好的，只有一个控制台在说谎。

## 测试

```
npm test                              # pure, integration, and real-fixture regression suites
node tools/build-id.mjs --check       # is the running plugin older than these sources?
node tools/fix-mojibake.mjs --check   # did a shell round-trip mangle any text?
node tools/verify-tristate.mjs        # three-state test verdict, through a real shell
```

测试数量故意不写在这里。它曾写着 92，而当时套件已经增长到 114，把过时的数字留在读者用来判断套件是否
健康的唯一地方，比不写数字更糟：`npm test` 自己会打印数量。

不需要网络，也不需要安装 DSH。集成测试把决策日志写到一个真实的临时文件，所以它们也验证了磁盘上的行
形状。

`test/real-fixtures.test.mjs` 与其他两个文件不同，而这个不同正是要点。它的输入是从一次真实运行中逐字
复制出来的（`test/fixtures/real-rows.json`），而不是手工写的。到目前为止发现的每一个缺陷都是形状不匹配，
而手工写的 fixture 会把它*错误地*编码进去：最初的 fixture 把 `arguments` 作为对象传入，因为那是它的
假设，于是套件保持绿色，而插件在生产里是坏的。一份由代码作者编写的 fixture 只能确认作者的假设；一份
从系统复制来的 fixture 才能推翻它们。

其中两个回归被写成可执行的反事实 —— 测试重建**旧的、有缺陷的**读取端并断言那个坏结果，然后断言修复后
的结果。这样 bug 就被记录为行为，而不是一段会随时间失准的段落。

## 在开发机上冒烟测试一次改动

因为 Desktop 没有 HMR，每一次代码改动都需要重启 DSH 才能被观察到。按顺序：

1. `npm test` —— 形状契约。
2. `node tools/build-id.mjs --write` —— 给新修订打上标记。
3. `node tools/verify-tool-contract.mjs` —— 加载**真实的** `dsh-tools`，并对每一个已注册的 tool 定义
   用它的真实 schema validator 做检查。值得在重启之前做，因为一个 schema 使用了不受支持关键字的 tool
   会让整个插件在加载时失败，而受支持的子集窄到会让你意外（`minimum` 和 `maximum` 会被拒绝）。它还会
   对每个 `execute()` 调用一次。
4. 重启 DSH。
5. `completion_supervisor_status` —— 确认模式行、两个区间都被打印
   （`observation band (logged only)` 和 `intervention band (advisory only since policy_v 3)`）、干预那
   一行只写了 `P1, P2, P3` 而没有别的，以及 `BUILD_ID` 与第 2 步一致。不一致意味着正在运行的插件比
   源码树旧，而自那以来写下的任何日志行都来自上一个构建。`/supervisor` —— 或者渲染同一份报告的工具
   —— 是从日志而不是从内存读取同一个 `BUILD_ID`，并在最新一行早于本进程时打印一个 `note:` —— 那是一次
   在首次评估之前的新重启，不是故障。只有当在本进程启动**之后**写下的一行写着不同的 id 时，它才会抬起
   stale-code 的 CHECK。
6. 运行一个使用 `pwsh` 的轮次，然后读最新的日志行：`facts.repo_available` 必须存在，而 `commands` 必须
   包含那条真实命令及其退出码。
7. 对失败测试路径，运行内置的故意失败项目：
   `cd test/fixtures/failing-project && npm test`。该行必须读出 `tests_run: true`、
   `tests_passed: false`，并到达 `P3_failing_tests`。有两个看起来更简单的命令**不能**用于这项检查，
   两者都被记录在 fixture 里：一条以 `;` 分隔的尾随语句会成功并成为最终状态（于是那个「失败」从未
   发生），而一个裸的 `process.exit(7)` 会被 pwsh 规范化为 1。
8. `node tools/analyse.mjs` —— skip 分解在一次重复停止之后应显示 `no_material_change`，而不是第二次
   评估，而每任务预算那节应把每一个新行归属到一个任务。「被问了什么」那一节必须显示一个属于**用户**
   请求的 goal；一个包含 `system-reminder` 的 goal 意味着来源允许列表已经回归。
9. `npm run verify-boundary -- <session-id>` —— 检查一个带有合成 user 角色消息的会话是否仍然记录了
   单个 `task_key`。这是唯一一项无法只靠插件日志完成的检查，因为它需要会话日志来统计人类实际发出了
   什么。
10. `node tools/score-round.mjs` —— replay 闸门。`steered a task that was COMPLETE` 必须保持 `0/8`。
    在 `policy_v 3` 下 `steered a task that was INCOMPLETE` 读作 `2/4` —— 在 `P4` 还能干预时它是 `4/4`
    —— 而 `missed an incomplete task` 就是为此付出的 `2/4`。任何对策略、问题集或 TaskState 的改动都
    必须移动这些数字，或解释为什么没有移动。
11. `node tools/fix-mojibake.mjs --check` —— 退出 0。如果它报告了任何东西，说明一次 shell 往返损坏了
    文本，受影响的文件必须在提交前修复。
