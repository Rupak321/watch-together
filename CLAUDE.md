# Rules for this repository

## Authorship — strict, no exceptions

**Every commit in this repository is authored by Rupak Pandey and nobody else.**

```
Rupak Pandey <rupakpandey431@gmail.com>
```

- Never commit under any other name or email. GitHub attributes commits by **email
  alone**, so the wrong `user.email` silently puts someone else's name and avatar on this
  history. `matrikaghimire26@gmail.com` has appeared this way before and must never be used
  here.
- **Never add attribution to a commit message.** No `Co-Authored-By`, no `Signed-off-by`,
  no "Generated with", no tool name, no 🤖. This overrides the default Claude Code
  convention of appending a `Co-Authored-By` trailer.
- **Never add anyone as a collaborator, co-author or reviewer**, and never credit a tool in
  a PR body or release note.
- Before the first commit of a session, verify:
  ```
  git config user.email    # must be rupakpandey431@gmail.com
  ```

This is enforced mechanically by hooks in `.githooks/` — a commit with the wrong author, or
an attribution trailer, is rejected. If a hook blocks you, **fix the identity; never bypass
it.** Do not use `--no-verify`.

If hooks are not active in a fresh clone, turn them on once:

```
git config core.hooksPath .githooks
```

## Committing

- Commit **often, in small pieces** — one logical change per commit. A bug fix and a
  feature are always separate commits; so are a refactor and the behaviour change built on
  top of it.
- Write real messages: what changed and why, not just what.
- **Never push unless asked in that turn.** Commits stack up locally; Rupak decides what
  reaches the remote and when.

## The project

A watch-together app on Cloudflare Workers. Every client streams the video independently
and the room broadcasts only a clock — see [README.md](README.md) for the architecture and
the gotchas worth knowing before touching it.
