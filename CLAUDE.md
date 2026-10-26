# Sidecar

Personal Chrome extension (Arc-style spaces and vertical tabs), loaded unpacked from a git clone on each computer. See README.md.

## Versioning

Every commit that changes the extension itself (code, manifest, icons, anything Chrome loads) bumps the version in `manifest.json`. If the version hasn't already changed since the previous commit, increment the patch number ("Z" in X.Y.Z), e.g. 1.0.1 → 1.0.2, and include it in the same commit. Commits that only change docs (README.md, CLAUDE.md) don't bump the version. The version shows on the Sidecar card in `chrome://extensions`, which is how to tell whether a computer has pulled and reloaded the latest code. These are not GitHub releases; no tags or release notes needed.
