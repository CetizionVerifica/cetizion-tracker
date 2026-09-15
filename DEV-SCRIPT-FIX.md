# Fix: `npm run dev` crashed on Windows

## The problem

Running `npm run dev` from the repo root on Windows failed straight away:

```
Error: spawn npm ENOENT
  code: 'ENOENT', syscall: 'spawn npm', spawnargs: [ 'run', 'dev' ]
```

It also printed a warning first:

```
[MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of scripts/dev.js is not specified ...
```

### Why it happened

`scripts/dev.js` starts the API and the web app by running `npm run dev` in
`server/` and `web/`. On Windows, `npm` is not a real program, it is a
`npm.cmd` script. The dev script launched it with `shell: false`, so Windows
could not find anything called `npm` (ENOENT). Recent Node versions also refuse
to run `.cmd` files unless a shell is used.

The warning appeared because `dev.js` uses `import` syntax, but the root
`package.json` did not say the project uses ES modules.

## What was changed

### 1. `scripts/dev.js`

- **Starting the servers:** on Windows, `npm` is now run through the shell,
  with the command passed as a single string (`npm run dev`). Passing it as one
  string also avoids Node's DEP0190 deprecation warning about shell arguments.
  On macOS and Linux it still runs `npm` directly, exactly as before.
- **Stopping the servers:** on Windows, Ctrl-C (or either server exiting) now
  uses `taskkill /T /F` to stop the whole process tree. Without this, only the
  shell would be killed and the API/Vite servers would keep running in the
  background, holding ports 4000 and 5173. macOS and Linux still use `SIGTERM`
  as before.

```diff
+// On Windows npm is a .cmd shim, which Node can only launch through a shell.
+const isWindows = process.platform === 'win32';
+
 function stopAll(code = 0) {
   if (stopping) return;
   stopping = true;
-  for (const child of children) child.kill('SIGTERM');
+  for (const child of children) {
+    // Killing the shell alone would leave the dev servers running on Windows.
+    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
+    else child.kill('SIGTERM');
+  }
   setTimeout(() => process.exit(code), 200);
 }

 for (const target of TARGETS) {
-  const child = spawn('npm', target.args, { cwd: target.cwd, shell: false });
+  const child = isWindows
+    ? spawn(`npm ${target.args.join(' ')}`, { cwd: target.cwd, shell: true })
+    : spawn('npm', target.args, { cwd: target.cwd });
```

### 2. `package.json` (repo root)

Added `"type": "module"` so Node knows `scripts/dev.js` is an ES module. This
removes the `MODULE_TYPELESS_PACKAGE_JSON` warning.

```diff
   "private": true,
+  "type": "module",
```

`scripts/dev.js` is the only JavaScript file at the repo root. `server/` and
`web/` each have their own `package.json`, and Node uses the nearest one, so
this setting does not change how the API or the web app code is loaded.

## How it was tested

`npm run dev` was run on Windows 11 (Node v24.20.0):

- The API started: `Cetizion API listening on http://localhost:4000`
- The web app started: `VITE v6.4.3 ready`, at `http://localhost:5173/`
- No errors or warnings from the dev script itself.
- After stopping it, no `node` processes were left running.

## Does this affect production?

**No.** Production runs from the `Dockerfile`, which never uses either changed
file:

| What production does | Uses the changed files? |
| --- | --- |
| Builds the web app with `npm ci` + `npm run build` inside `web/` | No, uses `web/package.json` |
| Installs server dependencies inside `server/` | No, uses `server/package.json` |
| Copies only `server/` and the built `web/dist` into the final image | No, the root `package.json` and `scripts/` are not copied |
| Starts with `node server/src/index.js` | No, `scripts/dev.js` is never run |

`scripts/dev.js` is a local development helper only. The Dokploy deployment,
the Docker image, the API code and the database are all unchanged.
