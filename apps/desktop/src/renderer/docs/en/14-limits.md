# Limitations and things to know

- **Weaker models** (through a gateway) follow instructions less well and may not check off the spec checkboxes. For architecture, planning and QA, stronger models are better.
- **Whether an agent asks CodeGraph depends on the model**, not on how strong it is: in the logs of two projects (1398 sessions) some models asked in most sessions and one never did. So the app looks up the files a session works on itself, and each session's last log line says how often the agent asked.
- **Keep the lid open while agents work.** A sleeping computer wakes only for moments, so agents barely move, and work after a pause costs more because the model's cache has expired. The app tells you when this happened.
- **Strix loads the CPU** while its container is running. This is normal; Docker cleans up after it finishes.
- **A PR needs a GitHub `origin`**; merging works without it.
- **Windows (beta): projects inside WSL** (`\\wsl$\…`, `\\wsl.localhost\…`) aren't supported yet, and the app refuses them when you add the project. Keep the project on a Windows drive, for example `C:\Users\you\projects`.
- **Windows (beta): the installer isn't signed.** SmartScreen warns on first run (More info → Run anyway). Agents and the app's checks need Git for Windows; Settings → Tools shows it and offers `winget install --id Git.Git -e`.
- **One copy of the app per user.** A second launch brings the open window to the front.
- **Enable the Claude subscription** only on your own computer. Its limits are shared with your regular Claude usage.
