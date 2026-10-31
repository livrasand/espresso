# Espresso API Documentation

This directory documents the HTTP API of the Espresso control plane that **gitGost** (`https://github.com/livrasand/gitGost`) can consume to display repositories and explore their code, branches, tags, and commits.

## Structure

- [`api.md`](./api.md) — complete endpoint reference, authentication, responses, and examples.

## Overview

Espresso exposes a repository browsing API under the **`/api/gg`** prefix (served through the paired storage node) and the Git smart-HTTP protocol under `/:owner/:repo.git/...`.

| Group | Prefix | Purpose |
|-------|--------|---------|
| Repository browsing | `/api/gg/repos/:owner/:repo/...` | directory tree, raw files, info, branches, tags, topics, commits |
| Short alias | `/:owner/:repo/...` | same as `/api/gg/repos/...` without the prefix |
| Git smart-HTTP | `/:owner/:repo.git/info/refs` and `/.../git-upload-pack` | `git clone` / `git fetch` / `git push` |
| Node/repo management | `/api/nodes/...` | list nodes, create/delete repos (requires session) |

Deployment base URL: `https://espresso.livrasand.com` (may vary for self-hosted instances).
