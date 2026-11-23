# Quality and security

| Layer | What it does |
|---|---|
| **TDD + AC** | Every requirement has a test; QA checks that the test actually holds it. |
| **App checks** | The app runs the project's typecheck and tests itself, on a clean copy of what is committed, before each QA review and after a merge. A failure blocks approval only if the check passes on the base (see "App checks" below). |
| **gitleaks** | Secrets in the code block approval. A secret that was in an earlier commit and is gone from the code is a note to rotate it, not a block, but the task then waits for you to merge it. Microsoft's published Azurite key (local emulator only) is not a secret. |
| **OSV-Scanner** | Vulnerable dependencies block approval. |
| **Semgrep** | Static analysis of the changed files blocks approval. It runs only when Semgrep is installed (see "Semgrep" below). |
| **Design check** | A static check of added UI lines against the design system tokens + a screenshot review (see "Design system and Storybook"). The project's own design-system folder and token files (`tokens.css` and the like) are not checked: that is where the palette is defined. |
| **Browser check** | QA opens the app in Chrome (Playwright / DevTools MCP), takes screenshots and reads the console. |
| **Strix** | Pentest in Docker (optional). Findings at the level you set block the task and go to the QA fixer. Smaller ones don't stop it: the app files them as one new task on the board, without repeats, for you to start when you choose. |
| **Security hooks** | Path boundaries, a list of forbidden commands (everything else is allowed), a ban on killing the app's own processes. |
| **Environment isolation** | Agents use their own Claude Code configuration, not your `~/.claude`, and commands start without the app's Claude key. |

The scanners (gitleaks, OSV-Scanner), Claude Code, CodeGraph, Superpowers and Mermaid ship with the app, so you don't need to install anything separately. Semgrep is not bundled (it is a Python package): install it if you want that gate. Docker and Chrome are needed only for Strix and browser checks. The status of all tools is shown in Settings → Tools.

## Details

### App checks

The app itself runs the project's typecheck and tests on a clean copy of what is committed, before each QA review and after a merge, and reads the real exit codes.

#### What blocks approval

- A failure blocks approval only if the same check passes on the commit the task started from.
- A deleted test file blocks approval.
- An existing test switched off blocks approval. A test that runs only when a resource is there doesn't count as switched off.
- A changed `test` or `typecheck` script blocks approval.
- A check or install that runs out of time gets a second try before it counts.

#### When a check isn't run again

- A commit that was already checked, with the same commands and settings, isn't checked a second time. QA rounds and restarts on a commit that hasn't moved use the result of the first run, and the log says when it ran. So does the check before a merge that brings nothing new into the task.
- The result on the commit a task started from is kept too, for every task that starts from it.
- A run that ran out of time, lacked a tool or had no database is never kept.
- **Run QA again** always runs the checks anew.
- The results are kept while the app is open, on your computer in `~/.vibe-teamlead/check-results`, outside the folders agents work in. The app signs each one with a key that exists only in its memory, so a result written there by anything else is ignored, and after the app restarts a commit is checked once more.

#### When a check can't say anything

- If a check can't say anything (it fails on the base too, its tool isn't installed), the task isn't blocked and the log says it wasn't verified.
- A check that fails on main too gets one task that fixes main. The task is urgent, created and started at once, past the queue.
- Tasks that hit the same failure while that task is open don't start another.

#### A project's first task

- When main has no checks at all yet (a new project's first task), the app runs the ones the task itself sets up, with its database, and says so in the task's window.
- A failure then blocks.
- A pass counts for less, since the task chose what checks it.

#### Which commands run

- Commands are detected for npm, pnpm, yarn, bun, Python, Go, Rust, Maven, Gradle, .NET, Ruby, PHP and Swift at the project's root.
- Others go in the project's settings.

#### Databases

- If the project's compose file names a database (Postgres, MySQL, Redis, Mongo) and Docker is running, the app starts an empty temporary one for each run.
- It applies the migrations (Prisma, Drizzle, Django, Alembic, Rails, Laravel), takes settings from `.env.example` and removes the database afterwards. There is nothing to set up.
- Migrations only ever run on that temporary database.
- Settings in `.env.example` that point at any other database are left out.
- Without Docker the log says the check couldn't be completed, and the task isn't blocked.

#### Other services

- The compose file's other services (queues, storage, search…: RabbitMQ, Kafka, Redpanda, MinIO, LocalStack, Elasticsearch, OpenSearch, Meilisearch, Typesense, or any service with an `image:` and no `build:`) are started as throwaway containers for each run too, each on a local port only, and removed afterwards.
- The database and these services share one network of the run's, created for it and removed with it. On it each container has its compose name, so a service reaches another as it would in compose (Keycloak at `postgres:5432`, an app image at `redis:6379`). It is a network of its own, never the host's.
- Only the image and safe settings come from the file: environment values, command, ports and healthcheck. Never volumes, privileges, devices, `env_file`, the host's network or a user.
- Settings in `.env.example` that point at one of them (by its compose name, or localhost with its port) point at its container instead, with the credentials it started with. S3 settings get the stand-in's keys and path style, and the buckets the example names are created.
- A service that doesn't come up is named in the log, and the settings that point at it stay empty; the checks still run.

#### The project starts

- After the tests, the app starts the project in the same clean copy, with the same throwaway database and services, by its recipe: the `preview.json` in that commit, the services saved for the Preview, or what it works out from the files (see "Preview").
- It runs the recipe's build, migrations and seed, starts every service, and passes when every service came up, the page answers, and five seconds later every service still runs. Everything it started is stopped afterwards.
- It counts like any check: a task that makes the project stop starting is blocked only if the project starts on the commit the task started from, each copy by its own recipe. A project that doesn't start on main gets the task that fixes main.
- It can't say anything, and blocks nothing, when a tool is missing, Docker isn't running, or a port the compose file names is in use on this computer (an open Preview of the project, or your own `docker compose up`).
- The compose file's ports: when all of them are free, both copies run its services on those ports, so an address the project hard-codes (Azurite's `127.0.0.1:10000`) reaches them; otherwise both run them on free ports. A copy that had to move one anyway is not compared with the other.
- It doesn't run for a project with nothing to start, or for a desktop or mobile app.
- A changed `preview.json` is listed for the reviewer as a file that decides how checks run.

#### Where you see the result

- The task's window shows what passed.
- Its card says when the checks couldn't say everything.

#### What isn't isolated

- These checks run the task's own code with your permissions, without API keys in their environment, and not in a sandbox.

### Semgrep

Static analysis of the changed files (injection, unsafe APIs; its registry rules at ERROR severity) blocks approval.

#### When it runs

- It runs only when Semgrep is installed: `brew install semgrep` on macOS; `pip install semgrep` on Windows, where there is no winget package, or anywhere with Python.
- Otherwise, or when its rules can't be fetched, the gate is skipped and the report says so.

#### Partial scans

- When Semgrep could not parse some of the files, or reported an error about the run itself, the report says "CLEAR (PARTIAL: …)".
- The Security tab then names what was not covered, so you can look at those files yourself.
- If it could not scan any of the files, the gate counts as failed.

### Environment isolation

- Agents run with their own Claude Code configuration (`~/.vibe-teamlead/claude-code`), not your `~/.claude`.
- Environment variables are filtered.
- The commands an agent runs (tests, installs, dev servers) start without the app's Claude key, so project code can't read or spend it.

## Strix's model

Strix runs on its own model, chosen in Settings → Agent Settings → Security QA (Strix) → Model for Strix. By default it is **Same as agents**: the Claude API key from Settings → Claude and the task's QA model. A Claude subscription can't run Strix, so with a subscription choose another provider here, or the pentest is skipped.

| Provider | Model (example) | What you enter |
|---|---|---|
| Same as agents | the task's QA model | nothing (the Claude API key) |
| OpenRouter | `openrouter/z-ai/glm-5.3` | API key |
| Vercel AI Gateway | `vercel_ai_gateway/zai/glm-5.3` | API key |
| Anthropic | `anthropic/claude-sonnet-5-5` | API key |
| OpenAI | `openai/gpt-6.1-sol` | API key; a base URL for an OpenAI-compatible server (optional) |
| DeepSeek | `deepseek/deepseek-v4-pro` | API key |
| Moonshot (Kimi) | `moonshot/kimi-k3.1-pro` | API key |
| Azure OpenAI | `azure/<deployment-name>` | API key, endpoint URL, API version (e.g. `2025-11-01-preview`) |
| AWS Bedrock | `bedrock/us.anthropic.claude-sonnet-5-5` | access key ID, secret access key and region, or an AWS profile and region |
| Google Vertex AI | `vertex_ai/gemini-4-argon` | project, location (e.g. `global`), a service-account JSON file (optional; otherwise gcloud application default credentials) |
| Local / OpenAI-compatible (Ollama, LM Studio, vLLM) | `ollama/qwen3-vl` or `openai/local-model` | base URL (e.g. `http://localhost:11434`, `http://localhost:1234/v1`), API key (optional) |
| ChatGPT subscription | `chatgpt/gpt-5.4` | nothing: run `strix auth login chatgpt` once in a terminal |

The model field is filled with the provider's example when you choose it; you can change it. A model typed without the provider's prefix gets it.

- **Strix's recommendation:** GLM-5.3 through OpenRouter or Vercel AI Gateway.
- **Cyber access programs:** frontier OpenAI, Anthropic and Gemini models refuse most offensive security tasks unless your account is in the provider's program (OpenAI Daybreak, Anthropic Cyber Verification Program, Gemini Fairwind).
- **Local models** under about 30B parameters often produce malformed tool calls.

Keys and secrets (API keys, the AWS secret access key, the Azure key) are kept apart from the settings, encrypted by the system (Keychain on macOS), separately for each provider. After saving, the form shows only that a key is saved; you can replace or remove it. Strix gets only the chosen provider's variables, never the Claude key unless you chose Same as agents, and keys are masked in the logs you and the agents see. If something the provider needs is missing, the pentest is skipped and the reason names what is missing; nothing fails.

## Placeholders left in the product

A task can ship temporary text on purpose: a home page that says it is a placeholder, "coming soon", "lorem ipsum". When no later task replaces it, it stays. The board names such text in the project's pages (any stack: React, Vue, Svelte, Astro, server templates), read again after every merge, with the file and line. **Create a task** adds a task to replace it; **Leave it** keeps it off the list for this project. It is a text search, not a model, so it costs nothing. Inputs' `placeholder` attributes, tests, stories and server code are not counted.

When a brief is split into tasks, the spec analyst also checks how a person reaches every page from the home page, and names the task that replaces any placeholder a task leaves.
