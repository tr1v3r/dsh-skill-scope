# dsh-skill-scope

[English](#english) | [中文](#中文)

让 DeepSeek Harness (DSH) 的 agent 拥有**物理隔离的 skill 可见性**：一个 agent 只能看到、只允许加载白名单内的 skill。两层交付——组合级的过滤 provider（Layer A）与调用级的 scoped worker 派发（Layer B，实验性）。

## 为什么

两篇 2026 年的实证研究指向同一个结论：

- **Evaluating AGENTS.md**（[arXiv:2602.11988](https://arxiv.org/abs/2602.11988)，ETH Zurich SRI Lab）：仓库级 context files 普遍不提升任务成功率，且平均推高推理成本 20%+；"仓库概述"类内容尤其无用。
- **More Skills, Worse Agents?**（[arXiv:2605.24050](https://arxiv.org/abs/2605.24050)）：skill 库从小组扩到 202 个，pass rate 最多降 21%；分解显示主要瓶颈是 **skill shadowing（选错 skill）**，而 context overhead 本身很小、与零不可区分。

推论：**收窄可选集消灭的是"选错"这个主要失败面**，省 token 只是副产品。DSH 的 preset/组合机制已经能表达"这个 agent 看到哪些 skill"，但缺一个直接的旋钮——本插件补上它。

## Layer A：作用域 provider（稳定）

`@tr1v3r/dsh-skill-scope` 导出一个包装 `FileSystemSkillProvider` 的过滤 provider。**在 worker 的 preset 里用它替代 `dsh-skill-filesystem`**，该 agent 的 `<available_skills>` 目录就只包含白名单条目；`enforceOnGet: true`（默认）同时拒绝按名加载范围外的 skill。

```yaml
# worker preset 内（替代 dsh-skill-filesystem 的位置）
- id: skills-fs
  name: '@tr1v3r/dsh-skill-scope'
  config:
    allowSkills: [paper-review-eval]   # 空 = 不过滤；denySkills 永远生效
    denySkills: []
    # 以下与 dsh-skill-filesystem 同义透传
    includeDefaultRoots: true
    customSkillDirs: []
```

要点：

- 过滤发生在**发现层**（`list()` 的 candidates），不在渲染层打补丁——被过滤的 skill 对该 agent 物理不可见，不是"提示它别用"。
- `get()` 二次校验：即使组合里混入了其它 provider，范围外的名字也拒绝加载。
- 观察语义：隐藏的 skill 记为"发现结果之外"，与"文件不存在"同形，不泄漏目录结构。

## Layer B：scoped worker 派发（实验性）

`@tr1v3r/dsh-skill-scope/worker` 提供 `ctx.skillScope.spawnWorker({ name, skills, prompt })`：通过 `ctx.agents.create()` 建 worker，`setup` 里把指定 skill 以**只读借注**（`ctx.skills.register()`）注册进 worker 的运行时层，且不挂任何 filesystem provider——worker 的目录恰好等于传入清单。适合三评制（同 skill × 3 个独立实例）与单职责微服务式编排。

```js
const a = await ctx.skillScope.spawnWorker({ name: 'rater-a', skills: ['paper-review-eval'], prompt: '...' })
const b = await ctx.skillScope.spawnWorker({ name: 'rater-b', skills: ['paper-review-eval'], prompt: '...' })
const c = await ctx.skillScope.spawnWorker({ name: 'rater-c', skills: ['paper-review-eval'], prompt: '...' })
// 三份独立评分 → 偏差大则人工仲裁
```

## 安装

```sh
dsh plugin --profile <profile> add @tr1v3r/dsh-skill-scope
```

## 路线图

- [ ] Layer A：组合级实测（挂进自定义 preset 验证目录投影与 invalidate 传播）
- [x] Layer A：watcher 失效透传的针对性测试（`test/watch.test.mjs`：真实 chokidar watcher 验证 invalidate 传播与目录刷新）
- [ ] Layer B：`agents.create` setup 契约实测；`whenIdle` 回收与错误传播
- [ ] Layer B：`exposeTool` —— 给编排 agent 注册 `spawn_scoped_worker` 模型工具
- [ ] 文档：三评制 gate 与输出契约的编排配方

## License

MIT
