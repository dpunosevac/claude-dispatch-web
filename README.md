# claude-dispatch-web

Phone page for claude-dispatch: send Claude Code jobs to your Macs and follow their results. Static HTML and ES modules with no build step and no dependencies, meant for GitHub Pages.

Everything is end-to-end encrypted (AES-256-GCM, see [PROTOCOL.md](PROTOCOL.md)). The page contains no keys, topics or machine details; you enter the server, topics and key on first use. The key is stored on the device as a non-extractable WebCrypto key in IndexedDB.

## Use

1. Open the Pages URL and add it to the home screen.
2. On a Mac run `cdispatch pair` and scan the QR: on iPhone from inside the home-screen app (Settings > Scan setup QR), elsewhere with the camera. Confirm the server and topics, tap Import. The values can also be pasted or typed under Settings.
3. Compose `<prompt> <work> [@machine]`, e.g. `/ship ABC-123 myrepo`.

## Develop

```sh
node tests/test-vectors.mjs   # crypto.js against the shared protocol vectors
node tests/command.mjs        # compose-line parser
node tests/setup.mjs          # setup-code parser
```

Serve the directory over `http://localhost` (a secure context, so WebCrypto works) with any static server.

`vendor/jsQR.js` is [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (Apache-2.0, see `vendor/jsQR.LICENSE`), unmodified from the npm package, loaded only when scanning.

`tests/test-vectors.json` and `PROTOCOL.md` are copies of the canonical files; don't edit them here.
