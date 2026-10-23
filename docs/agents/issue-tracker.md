# 需求记录：本地 Markdown

本仓库的 issue 与规格以 Markdown 文件形式存放在 `.scratch/` 目录下。

## 约定

- 一个功能一个目录：`.scratch/<feature-slug>/`
- 规格文件为 `.scratch/<feature-slug>/spec.md`
- 实施类 issue 一个 ticket 一个文件，放在 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，绝不合并成单个 tickets 文件
- Triage 状态记录在每个 issue 文件靠近顶部的 `Status:` 行（角色字符串见 `triage-labels.md`）
- 评论与对话历史追加到文件末尾的 `## Comments` 标题下

## 当某个技能说「发布到 issue tracker」时

在 `.scratch/<feature-slug>/` 下新建一个文件（目录不存在则先创建）。

## 当某个技能说「取出相关 ticket」时

读取被引用的那个路径下的文件。用户通常会直接给出路径或 issue 编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图（map）**是一个文件，每个 ticket 对应一个**子（child）**文件。

- **地图**：`.scratch/<effort>/map.md`（承载 Notes / Decisions-so-far / Fog 三部分正文）。
- **子 ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，问题写在正文里。用一行 `Type:` 记录 ticket 类型（`research`/`prototype`/`grilling`/`task`），用一行 `Status:` 记录 `claimed`/`resolved`。
- **阻塞关系**：在靠顶部写一行 `Blocked by: NN, NN`。当它列出的每个文件都是 `resolved` 时，该 ticket 解除阻塞。
- **前沿（Frontier）**：扫描 `.scratch/<effort>/issues/`，挑选处于打开状态、未被阻塞、且未被认领的文件；编号最小者优先。
- **认领（Claim）**：在任何实际工作之前，先把 `Status` 置为 `claimed` 并保存。
- **完成（Resolve）**：在 `## Answer` 标题下追加答案，把 `Status` 置为 `resolved`，然后向 `map.md` 的 Decisions-so-far 追加一条上下文指针（要点摘要 + 链接）。
