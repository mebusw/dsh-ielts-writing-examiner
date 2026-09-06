# dsh-ielts-examiner

IELTS 写作练习与 AI 评分插件，跑在 DeepSeek Harness (DSH) web profile 里。

题目 → 作文 → AI 评分 闭环，加上学习记录层（每次练习一条 session）。
模型完全跟 DSH runtime 当前默认模型走，不在插件里配渠道。

## 安装（开发期）

```bash
cd ~/.dsh/profiles/web
pnpm add file:~/work/dsh-ielts-examiner
# 或：
pnpm link ~/work/dsh-ielts-examiner
```

启动 `dsh web`，左下角 footer 多一个 **IELTS 写作** 按钮，点开就是工作台。

## 数据位置

```
~/.ielts-examiner/
├── config.json                    # 预留（v1 不写 LLM 配置）
├── index.json                     # SessionRecord[] (侧栏数据源)
├── sessions/<sid>/
│   ├── meta.json                  # { id, questionId, status, wordCount, createdAt }
│   ├── essay.txt                  # 原始作文
│   └── result.json                # 完整 LLM 输出（JSON.parse 后的对象）
└── prompts/
    └── 雅思写作.compressed.prompt.md   # 首次启动时从 bundle 拷过来
```

题库（`雅思真题.json`）与 Task 1 配图（`images-for-task1/`）打包进 npm，运行时直接读 bundle，零拷贝。

## 模型

完全跟 DSH runtime 默认模型走。runtime 从 `~/.dsh/settings.yaml` 的 `agent-default-model:` 块读：

```yaml
agent-default-model:
  provider: deepseek
  model: deepseek-chat
```

插件里没有任何渠道切换 / API key UI。模型配置改 runtime 这边。

## 开发

```bash
pnpm install
pnpm build         # 产出 lib/index.js + lib/client.js
pnpm verify        # 离线 smoke（不调 LLM）
```

## 设计

参考 `pomasa-studio` 与 `dsh-pictor` 两份实现。完整迁移背景见 `06-ielts-vuetify/migration-guide.md`。
