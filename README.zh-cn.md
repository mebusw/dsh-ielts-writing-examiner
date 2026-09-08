# dsh-ielts-writing-examiner（雅思写作练习与 AI 评分）

一个跑在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) **web**
profile 里的 IELTS 写作练习 + AI 评分插件。

挑一道真题、写一篇作文、拿到完整的四项评分（TR / CC / LR / GRA），
外加思路解析、语法批改、用词建议和同题范文。每次练习都作为一条
session 保存到侧栏，可以回看、克隆或删除。

模型完全跟 DSH runtime 当前默认模型走，插件里没有渠道切换也没有
API key UI —— 模型配置在 host 那边改。

## 安装

插件通过 `dsh plugin add` 安装进某个 DSH profile，本质上是把
`pnpm add` 在 profile 目录下执行一遍。

```bash
dsh plugin --profile web add dsh-ielts-writing-examiner
```

装好之后重启 `dsh web`（或者靠 profile 配置里的 `patchReload: live`
热加载新 bundle）。左下角 sidebar footer 会多一个 **IELTS 写作**
按钮，点开就是工作台。

注意：除了把包安装进去，profile 的 `dsh.profile.bundles` 里也要列
上这个包，host 半边才会被拼到 patch tree 上。下面的本地开发流程
会帮你一起搞定。

## 本地开发

```bash
# 1. 把 host + client 两半构建到 lib/
pnpm install
pnpm build

# 2. 接到本地 DSH web profile（写入 ~/.dsh/profiles/web）
pnpm reinstall    # = bash scripts/reinstall.sh

# 3. 离线 smoke（不调 LLM）
pnpm verify
```

`scripts/reinstall.sh` 会先跑 `pnpm build`，然后在
`~/.dsh/profiles/web` 里执行 `pnpm add file:<repo>`。脚本退出后，
刷新一下 web profile 即可。

## 使用

1. 点 sidebar 底部的 **IELTS 写作** 按钮，打开工作台。
2. 侧栏列出每一次练习，格式是 `题目类型 · 分数 · 时间`。鼠标悬
   停一行会露出 **↻**（同一题再来一次）和 **✕**（删除）。
3. 侧栏顶部 **+ 新练习** 打开选题页，从内置题库里挑一道 Task 1
   或 Task 2 的真题。
4. 在 textarea 里写你的作文；每停 1.5 秒自动保存。
5. 点 **提交评分** —— AI 考官会异步批改。视图先切到加载页，评分
   回来后自动切到完整的 Result 视图。
6. 侧栏底部的 **中 / EN** 切换按钮会实时把所有可见文案在中文和英
   文之间切换 —— 侧栏标题、底部计数、卡片标题、按钮文案、时间
   表达、错误提示全都跟着切；AI 评分本身的输出语言由模型决定
   （prompt 里两种语言都能用）。

## 数据位置

```
~/.ielts-examiner/
├── index.json                     # SessionRecord[]（侧栏数据源）
├── sessions/<sid>/
│   ├── meta.json                  # { id, questionId, status, wordCount, … }
│   ├── essay.txt                  # 原始作文
│   └── result.json                # 完整 LLM 输出（JSON.parse 后的对象）
└── prompts/
    └── 雅思写作.compressed.prompt.md   # 首次启动时从 bundle 拷过来
```

`~/.ielts-examiner` 在第一次启动时创建。session 用 12 位 id 作为
key；克隆一个 session 会复制它的 `questionId` 和作文，但会开一次
全新的评分。

## 模型

插件通过 `ctx.agentDefaultModel.currentSelection()` 读 DSH 的
`agent-default-model` 配置。在 `~/.dsh/settings.yaml` 里改：

```yaml
agent-default-model:
  provider: deepseek
  model: deepseek-chat
```

插件里故意没有 provider / key 的 UI。要切模型，改 host 配置然后
reload profile 即可。

## 功能

- **侧栏 session 列表**：状态点（idle / running / done / failed），
  显示最近操作时间。
- **作文自动保存**：每次停止输入 1.5 秒后写盘。
- **异步评分**：1.5 秒轮询；评分完成后自动跳到 Result。
- **四项评分**：Task Response / Coherence & Cohesion /
  Lexical Resource / Grammatical Range。
- **批注文本**：用 `<ins>`/`<del>` 高亮建议的修改。
- **思路 / 重点 / 技巧 / 结构（mermaid 图）**：分析卡。
- **语法批改 + 用词替代**：可折叠展示。
- **同题范文**：高分范文卡。
- **中 / EN UI 切换**：侧栏底部按钮，所有可见文案（侧栏标题、
  底部计数、卡片标题、按钮、时间、错误）都跟着切。
- **克隆 / 删除**：侧栏行级操作。

## 脚本

| 脚本           | 作用                                                  |
| -------------- | ----------------------------------------------------- |
| `pnpm build`   | 把 host (esbuild) + client (concat) 打到 `lib/`。     |
| `pnpm verify`  | 构建后跑离线 smoke（RPC、asset、prompt）。            |
| `pnpm reinstall` | 重新构建并安装进 `~/.dsh/profiles/web`。             |
| `pnpm test:e2e` | Playwright e2e（需要 web profile 在跑）。             |
| `pnpm pack:dry` | 看 `npm pack` 会发布什么。                           |

## 文件结构

```
src/
├── host/                  # Node 端：注册 RPC、asset、prompt、调 LLM
│   ├── apply.js           # apply(ctx, {dataDir}) → 挂载路由
│   ├── session-store.js   # 对 ~/.ielts-examiner/sessions/<id>/ 做 CRUD
│   ├── llm.js             # 调 DSH runtime 当前默认模型
│   ├── prompt.js          # 首次启动时把内置 prompt 拷到用户目录
│   ├── default-model.js   # 从 host 配置里读 provider/model
│   └── question-bank.js   # 读 assets/雅思真题.json
├── client/                # 浏览器端：React UI（function components）
│   ├── index.js           # slot 注册（footer 按钮 + overlay 面板）
│   ├── pages.js           # Root, Nav, NewPractice, Result, Loading, SessionDetail
│   ├── components.js      # iwCard / iwBtn / iwBadge / …
│   ├── strings.js         # 中英 i18n 表；`t(lang)` 查表
│   ├── styles.js          # scoped CSS 模板字符串
│   ├── api.js             # /ielts-examiner/rpc 上的 RPC 客户端
│   ├── md.js              # markdown + mermaid 渲染
│   └── export-pdf.js      # （当前关闭）html2pdf 导出
└── shared/
    └── schema.js          # host 和 client 共用的 result schema

assets/
├── 雅思真题.json          # 题库
└── images-for-task1/      # Task 1 题目里引用的图片

prompts/
└── 雅思写作.compressed.prompt.md   # 考官 prompt，首次启动拷到 ~/.ielts-examiner/prompts/

cordis.patch.yml           # bundle layer 清单（id: dsh-ielts-examiner）
lib/                       # 构建产物（gitignored）
  ├── index.js             # host 半边
  └── client.js            # client 半边（浏览器，ModuleLoader 包装）
```

## License

MIT.
