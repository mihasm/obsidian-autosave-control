## Contributing

Thanks for contributing to Autosave Control.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Build the plugin:

```bash
npm run build
```

## Development

- Main plugin code lives in `main.ts`.
- UI and settings helpers live under `ui/` and `settings/`.
- End-to-end tests live under `test/`.

## Testing

Run the full test suite:

```bash
npm run wdio
```

Run desktop tests only:

```bash
npm run wdio:desktop
```

Run Android tests only:

```bash
npm run wdio:android
```

Before opening a pull request, run the relevant tests for your change and make sure `npm run build` succeeds.

## Pull Requests

- Keep changes focused and minimal.
- Add or update tests when behavior changes.
- Update `README.md` if user-facing behavior or setup changes.
- Explain the problem and the fix clearly in the pull request description.

## Releases

- Plugin releases are created from pushed Git tags through GitHub Actions.
- If a change should ship to users, make sure `manifest.json` and `versions.json` are updated as part of the release flow.
