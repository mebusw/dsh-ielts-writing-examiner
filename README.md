# dsh-ielts-writing-examiner

An IELTS writing practice + AI scoring plugin that runs inside the
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai) **web** profile.

Pick a real IELTS question, write an essay, get a full band-score
breakdown with strategy notes, grammar corrections, vocabulary
suggestions, and a model answer. Every practice is saved as a
session you can revisit, clone, or delete from the sidebar.

A chat box is docked at the bottom of the right-hand work area on every
screen, so you can talk to the examiner at any point without the session
sidebar shrinking. On a correction page, select any text with
the mouse and it shows up as a quote in the chat box; the quoted text
is sent to the model as conversation context, so follow-up questions
stay anchored to what you are reading. Conversations are stored per
practice session.

The plugin follows DSH's currently configured default model — there is
no per-plugin provider switcher and no API key UI. Configure your
model in the host runtime.

![](./assets/poster.jpg)


## Dependencies

| Package | Version | Scope |
| --- | --- | --- |
| `dsh-app-dock` | `^0.1.5` | npm dependency |
| `@deepseek-ai/cordis` | `^4.0.2` | peer dependency |

**`dsh-app-dock` is unscoped** — there is no `@deepseek-ai/` prefix, and
`npm view @deepseek-ai/dsh-app-dock` returns 404. It owns the shared
bottom-left icon grid where this plugin's entry button lives.

The dependency alone is not enough: DSH composes only the bundle layers
listed in a profile's `dsh.profile.bundles`, and an npm dependency does
not appear there on its own. Install the dock as a **separate** step:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-app-dock
npx @deepseek-ai/dsh plugin --profile web add dsh-ielts-writing-examiner
```

then confirm both are listed:

```bash
npx @deepseek-ai/dsh --profile web --dump-config | grep -E '^\s*name:'
# expect both '@deepseek-ai/dsh-app-dock' and 'dsh-ielts-writing-examiner'
```

If the dock is absent the plugin still works. The client half tries to
register with the dock, waits out a 1.5 s grace period, and then claims a
self-owned footer button. A dock arriving later takes precedence and the
fallback is withdrawn, so there is always exactly one entry point —
`{"phase":"entry","entry":"dock"}` vs `{"phase":"entry","entry":"footer"}`
in `~/.ielts-examiner/diag.jsonl` tells you which one is live.

### Model resolution

Scoring does **not** assume any particular provider. The host half reads
the user's selection from the `agentDefaultModel` service and dispatches
through the `llm` service, which owns endpoint and credential resolution
(`@deepseek-ai/dsh-llm` exposes no `baseUrl` at all). A hardcoded
provider table only survives as the fallback for running outside a DSH
runtime.

This means `llm` and the `dsh-llm-*` adapter packages must be present in
the profile. Stripping them out degrades scoring to the standalone HTTP
path, which only knows DeepSeek-shaped endpoints.

## Install

The plugin installs into a DSH profile via `dsh plugin add`, which is a
thin wrapper around `pnpm add` in the profile's directory.

Its GUI entry point lives in the shared **application dock**
(`dsh-app-dock`, see [Dependencies](#dependencies)), so install the dock
first, then this plugin:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-app-dock
npx @deepseek-ai/dsh plugin --profile web add dsh-ielts-writing-examiner
```

Replace `web` with the target profile name (e.g. `desktop`). After
install, restart `dsh web` (or rely on `patchReload: live` in the
profile config to hot-pick-up the new bundle). An **IELTS Writing**
button appears in the dock's icon grid at the bottom-left footer; click
it to open the workbench.

The packages must also be listed in the profile's `dsh.profile.bundles`
so their host halves are composed. The local dev workflow below does
this for you.

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

The heavier browser check (`pnpm test:ui`) runs the client bundle in an
isolated headless Chromium harness with a mocked host and an SSE chat
stream, and writes screenshots to `e2e/artifacts/`. It needs the
Playwright browser binary; if it is missing, point `CHAT_UI_CHROMIUM` at
a Chrome/Chromium executable.

`scripts/reinstall.sh` runs `pnpm build` then `pnpm add file:<repo>` in
`~/.dsh/profiles/web`. After it returns, reload the web profile.

## Supported DSH version

Targets **Harness 0.2.x** (verified on 0.2.1-rc.2):

- Host language is read from `ctx.get('locale')` (the 0.2.x
  `LocaleRuntime`, with `subscribe`); the older `ctx.get('lang')` hook is
  kept only as a fallback.
- The dock is arbitrated under 0.2.x load ordering: dock first, self-owned
  footer only when the dock is absent.
- The chat stream tags historical assistant messages with
  `source: { kind: 'model', provider, model }`, as required by the 0.2.1
  `llm` adapters (`dsh-llm-deepseek` / `dsh-llm-pi-ai`).

## Troubleshooting

When the entry button doesn't appear, the plugin appends its arbitration
to `~/.ielts-examiner/diag.jsonl` (one JSON object per line):

```bash
tail -n 5 ~/.ielts-examiner/diag.jsonl
```

- `{"phase":"entry","entry":"dock"}` — registered with the dock; if the
  matching `entry-rendered` says `dom:false`, the dock accepted it but
  didn't render it.
- `{"phase":"entry","entry":"footer"}` — dock absent, self-owned footer
  fallback in use.
- Neither line — the client half never loaded; check the profile's
  `dsh.profile.bundles`.

## Usage

1. Click **IELTS Writing** in the application dock (bottom-left footer) to
   open the workbench.
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
7. A chat box sits at the bottom of the right-hand work area on every
   screen (the session sidebar keeps its full height). Type a question
   and press **Enter** (Shift+Enter for a newline); the reply streams in
   as you watch. The thread is saved per practice and restored when
   you open that practice again; every **+ New practice** starts with its
   own empty conversation, and switching practices never mixes them.
   While streaming, the send button is replaced by a stop button.
8. On the Result page, select any text with the mouse. It appears as a
   chip under **Quoted** in the chat box; ask your question and the
   selection is included as context. Use the chip's × to drop a quote.
   Up to three selections accumulate, and they are cleared after
   sending. The chat dock is available on every screen, but quoting
   works on any text in the main pane.

### Chat behaviour

- The host half resolves the same runtime default model as scoring and
  streams through the `llm` service (`POST /ielts-examiner/chat`,
  `text/event-stream`). Outside a DSH runtime it falls back to an
  OpenAI-compatible HTTP stream.
- Each turn sends the current screen, question, essay, and correction
  summary to the model (capped, never the whole raw event log), so
  answers are grounded in the essay under discussion.
- Each practice owns its transcript; switching the sidebar selection loads
  that practice's conversation only. Every **+ New practice** starts with
  its own empty conversation key (`draft-<id>`), so unsaved practices never
  share chat. Pressing submit moves that conversation onto the created
  session id. The welcome screen uses a separate `draft` thread.
- Transcripts are persisted client-invisible at
  `~/.ielts-examiner/chats/<session-id>.json` (or `draft-<id>.json` for an
  unsaved practice / `draft.json` for the welcome screen). Deleting a
  practice deletes its chat thread; abandoned unsaved threads are pruned
  after 7 days.
- If a reply fails, the question is kept and the error is shown inline;
  the partial reply (if any) stays in the thread until you reload.

## Data location

```
~/.ielts-examiner/
├── index.json                     # SessionRecord[] (sidebar data source)
├── sessions/<sid>/
│   ├── meta.json                  # { id, questionId, status, wordCount, … }
│   ├── essay.txt                  # raw essay
│   └── result.json                # full LLM output (parsed JSON)
├── chats/<key>.json               # chat transcript: <sid>, draft-<id> (unsaved practice) or draft (welcome)
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
- **Bottom chat box on every screen**, docked inside the right-hand work
  area (the sidebar stays full height), with streaming replies, per-practice
  transcript persistence, Enter-to-send, and a stop button.
- **Select-to-quote**: selections from the main pane become removable
  quote chips in the chat box and are sent as conversation context.
- **Clone / delete** sessions from the sidebar (deleting also deletes
  the practice's chat transcript).

## Scripts

| Script           | What it does                                                |
| ---------------- | ------------------------------------------------------------ |
| `pnpm build`     | Bundle host (esbuild) + client (concatenate) into `lib/`.    |
| `pnpm verify`    | Build then run an offline smoke (RPC, asset, prompt, chat).  |
| `pnpm reinstall` | Rebuild + reinstall into `~/.dsh/profiles/web`.              |
| `pnpm test:ui`   | Headless chat-UI check (isolated harness, no server needed).  |
| `pnpm pack:dry`  | Show what `npm pack` would publish.                          |

## File map

```
src/
├── host/                  # Node side: registers RPC, asset, prompt, LLM call
│   ├── apply.js           # apply(ctx, {dataDir}) → mounts routes incl. chat SSE
│   ├── session-store.js   # CRUD over ~/.ielts-examiner/sessions/<id>/
│   ├── chat-store.js      # per-practice chat transcripts in ~/.ielts-examiner/chats/
│   ├── chat-prompt.js     # chat system prompt + provider-neutral message history
│   ├── chat.js            # one streamed chat turn against the runtime default model
│   ├── llm.js             # calls DSH runtime default model (scoring + streaming deltas)
│   ├── prompt.js          # seeds the bundled prompt on first boot
│   ├── default-model.js   # resolves provider/model from host settings
│   └── question-bank.js   # reads assets/雅思真题.json
├── client/                # Browser side: React UI (function components)
│   ├── index.js           # entry arbitration (dock first / footer fallback) + overlay panel
│   ├── pages.js           # Root, Nav, NewPractice, Result, Loading, SessionDetail
│   ├── chat.js            # bottom chat dock + quote chips + SSE/context helpers
│   ├── components.js      # iwCard / iwBtn / iwBadge / etc.
│   ├── strings.js         # zh + en i18n table; `t(lang)` lookup
│   ├── styles.js          # scoped CSS template literal
│   ├── api.js             # RPC client over /ielts-examiner/rpc + chat SSE client
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
