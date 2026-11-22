# claude-dispatch-web

Phone page for claude-dispatch: send Claude Code jobs to your Macs and follow their results. Static HTML and ES modules with no build step and no dependencies, meant for GitHub Pages.

Everything is end-to-end encrypted (AES-256-GCM, see [PROTOCOL.md](PROTOCOL.md)). The page contains no keys, topics or machine details; you enter the server, topics and key on first use. The key is stored on the device as a non-extractable WebCrypto key in IndexedDB.

## Use

1. Open the Pages URL, enter the server (`https://ntfy.sh`), request topic, response topic and key.
2. Add to home screen.
3. Compose `<prompt> <work> [@machine]`, e.g. `/ship ABC-123 myrepo`.

## Develop

```sh
node tests/test-vectors.mjs   # crypto.js against the shared protocol vectors
node tests/command.mjs        # compose-line parser
```

Serve the directory over `http://localhost` (a secure context, so WebCrypto works) with any static server.

`tests/test-vectors.json` and `PROTOCOL.md` are copies of the canonical files; don't edit them here.
