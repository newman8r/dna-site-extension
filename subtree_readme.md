### Git subtree guide for `gedmatch-extension`

This folder is vendored from a separate repository using Git subtree. It keeps the extension usable as its own repo for nontechnical users, while giving this monorepo full code visibility for IDE/agents.

— Upstream repo: `https://github.com/newman8r/dna-site-extension.git`
— Upstream branch: `master`
— Remote alias (in this repo): `ext`
— Subtree mount path (prefix): `gedmatch-extension/`

### Initial setup (already done)

Commands used to add the subtree here:

```bash
# 1) Remove old embedded snapshot (avoid path collision)
git rm -r gedmatch-extension
git commit -m "remove old extension directory"

# 2) Add upstream repo and fetch its master branch
git remote add ext https://github.com/newman8r/dna-site-extension.git
git fetch ext master

# 3) Add subtree at the chosen prefix (keeps full history)
git subtree add --prefix=gedmatch-extension ext master
```

Notes:
- If you see "couldn't find remote ref main", this upstream uses `master`; fetch `master` as shown above.
- We used non-squash mode to preserve upstream history (recommended if you ever plan to push changes back upstream from here).

### Routine maintenance

Pull newer changes from the upstream `master` into this repo:

```bash
git fetch ext master
git subtree pull --prefix=gedmatch-extension ext master
```

Pin to a specific tag/commit instead of tip:

```bash
git fetch ext --tags
git subtree pull --prefix=gedmatch-extension ext <tag-or-commit>
```

Keep subtree operations consistent:
- Always use the same prefix: `gedmatch-extension`
- Always use the same remote alias: `ext`
- Since we added without `--squash`, continue pulling without `--squash` to keep history pushable upstream.

### Contributing changes back to the extension

If you edit files under `gedmatch-extension/` here and want those changes in the upstream repo:

```bash
# Publish subtree changes from this repo to upstream's master
git subtree push --prefix=gedmatch-extension ext master
```

Alternatively, make changes directly in the upstream repo (recommended for larger features), then pull them here via the routine maintenance commands.

### Branching and merges in this repo

- Subtree content behaves like regular files. Merging branches works as usual.
- Best practice: perform `git subtree pull` on one branch (e.g., `master`), then merge that branch into other branches (feature/testing/production). This avoids divergent subtree histories and minimizes conflicts.
- Conflicts are handled like normal file conflicts. Resolve, commit, and proceed.

### Cloning and CI/CD

- Consumers of this repo can `git clone` normally. No submodule init is required.
- If your backend tooling (lint/tests/Docker) should ignore the extension, add `gedmatch-extension/` to relevant ignore lists (e.g., `.eslintignore`, test globs, Docker build contexts).

### Troubleshooting

- Wrong upstream branch: ensure you `git fetch ext master` (this upstream uses `master`).
- Wrong prefix or remote alias: subtree commands must match the original `--prefix=gedmatch-extension` and remote alias `ext`.
- Mixed squash/non-squash: if you add with full history (no `--squash`), keep pulling without `--squash` to preserve pushability upstream.

### Quick command reference

```bash
# Update from upstream master
git fetch ext master
git subtree pull --prefix=gedmatch-extension ext master

# Push local subtree changes back to upstream master
git subtree push --prefix=gedmatch-extension ext master

# Re-point to a tag
git fetch ext --tags
git subtree pull --prefix=gedmatch-extension ext vX.Y.Z
```


