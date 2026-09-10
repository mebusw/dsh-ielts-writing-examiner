# dsh-ielts-writing-examiner

An IELTS writing practice + AI scoring plugin that runs inside the
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai) **web** profile.

Pick a real IELTS question, write an essay, get a full band-score
breakdown with strategy notes, grammar corrections, vocabulary
suggestions, and a model answer. Every practice is saved as a
session you can revisit, clone, or delete from the sidebar.

The plugin follows DSH's currently configured default model — there is
no per-plugin provider switcher and no API key UI. Configure your
model in the host runtime.

![](./assets/poster.jpg)


## Install

The plugin installs into a DSH profile via `dsh plugin add`, which is a
thin wrapper around `pnpm add` in the profile's directory.

```bash
dsh plugin --profile web add dsh-ielts-writing-examiner
```

After install, restart `dsh web` (or rely on `patchReload: live` in the
profile config to hot-pick-up the new bundle). A **IELTS Writing**
button appears in the sidebar footer; click it to open the workbench.

The package must also be listed in the profile's `dsh.profile.bundles`
so its host half is composed. The local dev workflow below does this
for you.

## Local development

```bash
# 1. Build host + client halves into lib/
pnpm install
pnpm build

# 2. Wire it into your local DSH web profile (writes to ~/.dsh/profiles/web)
pnpm reinstall    # = bash scripts/reinstall.sh

# 3. Offline smoke (no LLM call required)
pnpm verify
```

`scripts/reinstall.sh` runs `pnpm build` then `pnpm add file:<repo>` in
`~/.dsh/profiles/web`. After it returns, reload the web profile.

## Usage

1. Click **IELTS Writing** in the sidebar footer to open the workbench.
2. The sidebar lists every practice as `task · score · time`. Hover a
   row to reveal **↻** (re-attempt the same question) and **✕**
   (delete).
3. **+ New practice** in the sidebar opens a fresh question picker.
   Pick from any Task 1 or Task 2 prompt in the bundled bank.
4. Write your essay in the textarea; it auto-saves every 1.5 s of
   inactivity.
5. Hit **Submit for scoring** (or **提交评分** in 中文) — the AI
   examiner runs asynchronously. The view flips to a loading card,
   then to the full Result when the score returns.
6. Use the **中 / EN** toggle in the sidebar footer to flip every
   visible label between Chinese and English. The button highlight +
   the labels themselves update; the AI's prose is whatever language
   it produced (you can ask the model in either language via the
   prompt).

## Data location

```
~/.ielts-examiner/
├── index.json                     # SessionRecord[] (sidebar data source)
├── sessions/<sid>/
│   ├── meta.json                  # { id, questionId, status, wordCount, … }
│   ├── essay.txt                  # raw essay
│   └── result.json                # full LLM output (parsed JSON)
└── prompts/
    └── 雅思写作.compressed.prompt.md   # seeded on first boot
```

`~/.ielts-examiner` is created on first run. Sessions are keyed by a
12-character id; cloning a session copies the `questionId` and the
essay but starts a fresh scoring run.

## Model

The plugin reads from DSH's `agent-default-model` block via
`ctx.agentDefaultModel.currentSelection()`. Configure it in
`~/.dsh/settings.yaml`:

```yaml
agent-default-model:
  provider: deepseek
  model: deepseek-chat
```

There is intentionally no provider/key UI inside the plugin. To switch
models, edit the host settings and reload the profile.

## Features

- **Sidebar session list** with status dot (idle / running / done /
  failed) and last-action time.
- **Auto-save essay** every 1.5 s of inactivity.
- **Async scoring** with 1.5 s polling; flips to Result view when done.
- **4-criterion band** breakdown: Task Response / Coherence & Cohesion
  / Lexical Resource / Grammatical Range.
- **Annotated essay HTML** with `<ins>`/`<del>` highlights for
  suggested changes.
- **Strategy / key points / techniques / structure** (mermaid) on the
  analysis card.
- **Grammar fixes** + **vocabulary alternatives** in collapsible
  sections.
- **Sample essay** for the same prompt.
- **zh / en UI toggle** at the bottom of the sidebar (every label
  switches — sidebar title, footer count, card titles, buttons, time
  strings, error messages, etc.).
- **Clone / delete** sessions from the sidebar.

## Scripts

| Script           | What it does                                                |
| ---------------- | ------------------------------------------------------------ |
| `pnpm build`     | Bundle host (esbuild) + client (concatenate) into `lib/`.    |
| `pnpm verify`    | Build then run an offline smoke (RPC, asset, prompt).        |
| `pnpm reinstall` | Rebuild + reinstall into `~/.dsh/profiles/web`.              |
| `pnpm test:e2e`  | Playwright e2e (requires a running web profile).             |
| `pnpm pack:dry`  | Show what `npm pack` would publish.                          |

## File map

```
src/
├── host/                  # Node side: registers RPC, asset, prompt, LLM call
│   ├── apply.js           # apply(ctx, {dataDir}) → mounts routes
│   ├── session-store.js   # CRUD over ~/.ielts-examiner/sessions/<id>/
│   ├── llm.js             # calls DSH runtime default model
│   ├── prompt.js          # seeds the bundled prompt on first boot
│   ├── default-model.js   # resolves provider/model from host settings
│   └── question-bank.js   # reads assets/雅思真题.json
├── client/                # Browser side: React UI (function components)
│   ├── index.js           # slot registration (footer button + overlay panel)
│   ├── pages.js           # Root, Nav, NewPractice, Result, Loading, SessionDetail
│   ├── components.js      # iwCard / iwBtn / iwBadge / etc.
│   ├── strings.js         # zh + en i18n table; `t(lang)` lookup
│   ├── styles.js          # scoped CSS template literal
│   ├── api.js             # RPC client over /ielts-examiner/rpc
│   ├── md.js              # markdown + mermaid rendering
│   └── export-pdf.js      # (currently disabled) html2pdf export
└── shared/
    └── schema.js          # result schema shared between host and client

assets/
├── 雅思真题.json          # question bank
└── images-for-task1/      # images referenced by Task 1 questions

prompts/
└── 雅思写作.compressed.prompt.md   # examiner prompt, seeded into ~/.ielts-examiner/prompts/

cordis.patch.yml           # bundle layer manifest (id: dsh-ielts-examiner)
lib/                       # build output (gitignored)
  ├── index.js             # host half
  └── client.js            # client half (browser, ModuleLoader-wrapped)
```

## License

MIT.
