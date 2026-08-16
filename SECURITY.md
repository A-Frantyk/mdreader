# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private reporting: **Security → Report a vulnerability** on
this repository (<https://github.com/A-Frantyk/mdreader/security/advisories/new>).
You'll get an acknowledgement within a few days; fixes ship in the next
release with credit in the release notes if you'd like it.

There is no bug bounty.

## Supported versions

Only the latest release on the
[Releases page](https://github.com/A-Frantyk/mdreader/releases) receives
fixes.

## Scope — what counts

mdreader is a desktop viewer/editor for **untrusted Markdown files** — a
document you downloaded should not be able to do anything beyond
rendering itself. Reports of the following are especially welcome:

- Script execution or sanitizer bypass from document content (Markdown,
  raw HTML, mermaid or KaTeX blocks) — see `src-tauri/src/render.rs`.
- A document causing the app to open, run, read, or write a file the
  user didn't explicitly choose (link handling in `src/app.js`, the
  Tauri commands in `src-tauri/src/lib.rs`).
- Network requests triggered by a document beyond loading `<img>` URLs it
  explicitly references.
- Anything that lets a document reach `window.__TAURI__` or the Tauri
  IPC.

Out of scope: issues that require the user to already have installed a
malicious build, and hangs/slowness on pathological documents (reported
as ordinary issues, still appreciated).

## Verifying downloads

Every release ships `SHA256SUMS-<platform>.txt` next to the installers,
and builds from a `v*` tag carry a GitHub build-provenance attestation:

```sh
gh attestation verify <installer> --repo A-Frantyk/mdreader
```

Note that macOS builds are ad-hoc signed (not notarized) and
Windows/Linux builds are unsigned — see the README's install notes.
