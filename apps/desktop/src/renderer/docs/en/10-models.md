# Models and access to Claude

## Access (Settings → Claude)

Two modes, with a toggle at the top:
- **API key:** an Anthropic key or a key for a compatible gateway, plus an optional **base URL**. This is how, for example, Meter → Ollama works: `https://gw.metergateway.com/ollama`.
- **Claude subscription:** a token from `claude setup-token`, only for your own computer (do not enable it in builds for other people). The base URL is not used.

The two keys are stored separately, encrypted in the macOS Keychain. Sessions use only the key of the selected mode, with no silent substitution. The Test connection button tests the key of the selected mode.

## Models

- **Agent profile** (Settings → Agent Settings): models and "thinking" level for each phase: spec, planning, code, QA.
- **Custom phase models:** you can set a model separately for each phase. The list comes from your endpoint (Anthropic or a gateway).
- **Feature models:** separate models for Insights, Roadmap, Ideation, spec document analysis and so on. Spec document analysis inherits the Roadmap model until you set its own.
- **Non-Claude models** (glm, kimi, qwen through a gateway) work. The app also substitutes the selected model wherever Claude Code would otherwise call its own "small" models.
