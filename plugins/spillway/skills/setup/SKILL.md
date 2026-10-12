---
name: setup
description: Set up the pre-alpha Spillway CLI and private per-user service from source.
disable-model-invocation: true
---

Phase 2 supports per-user launchd on macOS and systemd --user on Linux. There is no published npm release; build from source. Do not claim clean-machine onboarding or broad model qualification is complete.

Check `spillway --version`, `spillway service status` and queue_status. Source setup uses Node >=22.13, npm ci, npm run check, and optional npm link, which changes local npm executable links. Honor existing human authorization for these reversible local setup steps and service installation; do not ask repeatedly. Obtain authorization only for a new action outside the request, such as credentials, provider enrollment or infrastructure.

Use private config under ~/.config/spillway/config.yaml, with registered repositories and explicit data policy. Private config/data stay outside all Git repositories. After validating config and stopping an existing foreground service, run `spillway --config ABSOLUTE_CONFIG_PATH service install` to install/start under the current user. `--no-start` renders/writes the private service definition without starting it. Use service start/stop/status/uninstall for lifecycle; uninstall retains config, queue and evidence. Reinstall after moving/upgrading the pinned Node or built CLI path. Linux uses the logged-in user manager; lingering/login persistence is an owner OS decision and is not enabled by Spillway.

Daemon environment contains PATH only, with manager-inherited provider keys removed. For an authenticated configured endpoint, use the private api_key_file reference documented in the README; never copy keys into plist/unit files or enroll frontier credentials. Foreground api_key_env remains available where explicitly configured. Exact harness version and profile qualification remain operator assertions requiring real endpoint testing. Default local review now runs on the approved local/review profile; frontier work runs only in explicitly authorized Claude Code sessions. Do not launch paid providers, provision infrastructure, enable frontier, change repository approval or invent model qualification during setup.
