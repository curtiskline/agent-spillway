---
name: setup
description: Check the pre-alpha Spillway CLI and foreground service, and guide private configuration.
disable-model-invocation: true
---

This is a Phase 0/1 scaffold. There is no released package or automated launchd/systemd installer. Do not claim this installs or manages a background service.

Check `spillway --version` and queue_status. If unavailable, direct the owner to the repository README development setup: Node >=22.13, npm ci, npm run check, npm link, then private config under ~/.config/spillway/config.yaml and foreground `spillway serve`. Explain npm link changes the local npm executable links; get the owner's approval before installing software or writing service configuration. Do not launch paid providers, provision infrastructure or invent profile qualification. OpenCode is provisional; profiles require an exact installed harness version and real endpoint testing. Private config, endpoints, tokens and logs stay outside source repositories. A checks-only opt-in can demonstrate the pipeline; the default local/frontier review gate holds until the later review implementation exists.
