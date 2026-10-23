# 领域文档（Domain Docs）

说明工程类技能在探索本仓库代码库时，应如何消费本仓库的领域文档。

## 探索之前，先读这些

- 仓库根目录的 **`GLOSSARY.md`**；或者
- 如果仓库根目录存在 **`GLOSSARY-MAP.md`**：它指向每个上下文各一份 `GLOSSARY.md`，读取与本次主题相关的每一份。
- **`docs/adr/`**：读与你即将改动的区域相关的 ADR。多上下文仓库中，还要检查 `src/<context>/docs/adr/` 里的上下文级决策。

如果这些文件不存在，**静默继续**。不要指出它们缺失，也不要主动建议提前创建。`/domain-modeling` 技能（经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 触达）会在术语或决策真正被确定时才按需懒创建它们。

## 文件结构

单上下文仓库（绝大多数仓库都是这种）：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `GLOSSARY-MAP.md`）：

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## 使用术语表里的词汇

当你的输出要指称某个领域概念时（issue 标题、重构提案、假设、测试名称里），使用 `GLOSSARY.md` 中定义的那个词。不要漂移到术语表明确避开的同义词。

如果你需要的概念还不在术语表里，这本身是个信号：要么你在发明项目并不使用的语言（重新考虑），要么确实存在缺口（记下来交给 `/domain-modeling`）。

## 标注 ADR 冲突

如果你的输出与某个既有 ADR 相矛盾，请显式指出，而不是悄悄覆盖：

> _与 ADR-0007（event-sourced orders）冲突，但值得重新讨论，因为……_
