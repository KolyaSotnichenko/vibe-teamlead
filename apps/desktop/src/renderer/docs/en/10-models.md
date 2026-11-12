# Models and access to Claude

## Access (Settings → Claude)

Two modes, with a toggle at the top:
- **API key:** an Anthropic key or a key for a compatible gateway, plus an optional **base URL**. This is how, for example, Meter → Ollama works: `https://gw.metergateway.com/ollama`.
- **Claude subscription:** a token from `claude setup-token`, only for your own computer (do not enable it in builds for other people). The base URL is not used.

The two keys are stored separately, encrypted in the macOS Keychain. Sessions use only the key of the selected mode, with no silent substitution. The Test connection button tests the key of the selected mode.

## Models

- **Agent profile** (Settings → Agent Settings): models and "thinking" level for each phase: spec, planning, code, QA. Every current Claude model (Opus, Sonnet and Haiku 5.5) takes a thinking level: it sets how much effort the model puts in, and the model decides how much to think.
- **Custom phase models:** you can set a model separately for each phase. The list comes from your endpoint (Anthropic or a gateway). The QA fixer uses the Coding model, since it edits code; the QA model is for the reviewer.
- **A task and the settings:** before each run, a task takes the models and thinking levels set here now, so after changing provider or models you only change them here. A run keeps its models to the end. The exception is a task you picked different models for when creating or editing it: it keeps them until you set it back to the same as here.
- **Feature models:** separate models for Insights, Roadmap, Ideation, spec document analysis, CI readiness (default Sonnet, low thinking) and so on. Spec document analysis inherits the Roadmap model until you set its own. The Utility model writes commit messages, PR descriptions and the changelog.
- **Subagent model:** Settings → Agent Settings → Subagents; by default the same as the agent's.
- **Non-Claude models** (glm, kimi, qwen through a gateway) work. The app also substitutes the selected model wherever Claude Code would otherwise call its own "small" models.
