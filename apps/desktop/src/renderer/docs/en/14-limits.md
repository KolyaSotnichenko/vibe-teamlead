# Limitations and things to know

- **Weaker models** (through a gateway) follow instructions less well: they fall back to grep instead of CodeGraph more often and may not check off the spec checkboxes. For architecture, planning and QA, stronger models are better.
- **Keep the lid open while agents work.** A sleeping Mac wakes only for moments, so agents barely move, and work after a pause costs more because the model's cache has expired. The app tells you when this happened.
- **Strix loads the CPU** while its container is running. This is normal; Docker cleans up after it finishes.
- **A PR needs a GitHub `origin`**; merging works without it.
- **Enable the Claude subscription** only on your own computer. Its limits are shared with your regular Claude usage.
