# @piewf/cli

Terminal commands for [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows): `piewf` operates workflows without a roles dependency.

Requires Node.js 22.19 or newer and the `pi` command on `PATH`. This is trusted host code with the same filesystem and process access as Pi.

```sh
npm install -g @piewf/cli
```

## Optional roles

`pi-role` belongs to the independent `@piewf/pi-ext-roles` package, not this CLI. Enable its Pi extension explicitly to interpret workflow `role` options; without it, those options are ignored. See the [roles guide](https://vekexasia.github.io/pi-extensible-workflows/roles.html).

## piewf

```sh
piewf --version
piewf --help
piewf doctor [--agent-options <json>] [--prompt <text>] [--json]
piewf doctor cleanup [--older-than-days <days>] [--yes]
piewf inspect [session-id] [--json|--summary] [--failed]
piewf transcript <session-file>
piewf run <workflow-name> [workflow arguments]
piewf run --script <workflow.js> [--name <workflow-name>] [--input <json>]
piewf export <workflow-name> [--name <command>] [--output <path>] [--force]
piewf bundle <workflow-name> [--name <command>] [--output <directory>] [--force]
piewf share <run-id>
```

Use `piewf --help` for structured command help. Every command also supports `--help` and `-h`.

`piewf inspect <session-id> --json` includes a completed run's optional `result`: `{ "status": "available", "value": ... }` for valid `result.json` files up to 64 KB (including formatting), or `{ "status": "truncated", "preview": "...", "previewBytes": 4096, "totalBytes": ... }` with a UTF-8-safe preview of at most 4096 bytes and explicit file size metadata. A preview is text, not necessarily complete JSON; use `artifacts.resultPath` for the full file. Missing results omit the field; unreadable, non-regular, symlinked, or malformed files report `status: "unavailable"` without hiding the run. Values are not redacted: treat inspect JSON like the original result file.

`--summary` adds `result=available`, `result=truncated`, or `result=unavailable` without printing the value. Inspect JSON without a session ID includes the same field in each session's runs. Business outcomes such as `{ "pass": false }` do not change `completed` to `failed`; `--failed` still selects execution failures only.

See [CLI operations](https://vekexasia.github.io/pi-extensible-workflows/developers.html#operations).

## License

MIT
