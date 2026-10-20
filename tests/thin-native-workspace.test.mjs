import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const scratch = realpathSync(mkdtempSync("/private/tmp/grokpair-thin-native-workspace-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
for (const name of ["workspace", "native"]) await build({ entryPoints: [new URL(`../src/${name}.ts`, import.meta.url).pathname],
  outfile: join(scratch, `${name}.mjs`), bundle: true, platform: "node", format: "esm" });
await build({ entryPoints: [new URL("./fixtures/native-workspace-peer.mjs", import.meta.url).pathname],
  outfile: join(scratch, "peer.mjs"), bundle: true, platform: "node", format: "esm" });
const { preflightWorkspace, provisionWorkspace, validateNativeWorkspace, validateWorkspace } = await import(join(scratch, "workspace.mjs"));
const { NativeConnection } = await import(join(scratch, "native.mjs"));

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}
function fixture() {
  const root = mkdtempSync(join(scratch, "case-")), userHome = join(root, "home"), source = join(userHome, "repo");
  const nativeHome = join(userHome, ".grok"), otherState = join(userHome, ".codex"), bin = join(root, "bin"), trace = join(root, "trace");
  for (const path of [source, nativeHome, otherState, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(bin, "grok"), `#!${process.execPath}\nimport ${JSON.stringify(join(scratch, "peer.mjs"))};\n`); chmodSync(join(bin, "grok"), 0o755);
  return { root, source, nativeHome, otherState, trace,
    boundaries: { user_home: userHome, protected_roots: [{ path: nativeHome, label: "Grok state" }, { path: otherState, label: "Codex state" }] },
    env: { ...process.env, PATH: bin + ":" + process.env.PATH, GROKPAIR_COLLABORATOR: "test-collaborator", GROK_SANDBOX: "native-environment-choice", NATIVE_WORKSPACE_TRACE: trace } };
}
function init(f) {
  mkdirSync(join(f.source, "packages/web"), { recursive: true });
  writeFileSync(join(f.source, "packages/web/tracked.txt"), "base\n");
  git(f.source, "init", "--quiet"); git(f.source, "add", "."); git(f.source, "commit", "--quiet", "-m", "fixture");
}
function candidate(f, standalone = false, destination = join(f.nativeHome, "native-result")) {
  if (standalone) git(f.root, "clone", "--quiet", "--no-hardlinks", f.source, destination);
  else git(f.source, "worktree", "add", "--quiet", "--detach", destination);
  return destination;
}
function hooks(events = []) { return {
  starting() { events.push(["starting"]); }, started(value) { events.push(["started", value]); },
  notLaunched() { events.push(["not_launched"]); }, returned(value) { events.push(["returned", value]); }, exited(value) { events.push(["exited", value]); },
}; }
function nativeHooks(events) { return { ...hooks(events), notification() {}, attention() { throw Error("unexpected attention"); }, failure(error) { events.push(["failure", error]); } }; }

test("ordinary canonical non-Git cwd is admitted without running the creator", async () => {
  const f = fixture(), events = [], plan = preflightWorkspace(f.source, false, f.boundaries);
  assert.deepEqual(plan, { cwd: f.source, worktree: false });
  assert.deepEqual(await provisionWorkspace(plan, undefined, hooks(events), f.env, f.boundaries), { cwd: f.source });
  assert.deepEqual(events, []); assert.equal(existsSync(f.trace), false);
  assert.throws(() => preflightWorkspace(f.source, true, f.boundaries), /existing Git repository/);
});

test("native Linked and Standalone results preserve nested cwd and bypass only the admitted Grok tree boundary", async () => {
  for (const standalone of [false, true]) {
    const f = fixture(); init(f);
    const root = candidate(f, standalone), cwd = join(root, "packages/web"), sourceCwd = join(f.source, "packages/web");
    const plan = preflightWorkspace(sourceCwd, true, f.boundaries), events = [];
    const result = await provisionWorkspace(plan, undefined, hooks(events), { ...f.env, NATIVE_WORKSPACE_RETURN: cwd }, f.boundaries);
    assert.deepEqual(result, { cwd, worktree_root: root });
    assert.deepEqual(plan, { cwd: sourceCwd, worktree: true, repository: f.source, relative_cwd: "packages/web" });
    assert.deepEqual(events.map(event => event[0]), ["starting", "started", "returned", "exited"]);
    const invocation = JSON.parse(readFileSync(f.trace, "utf8"));
    assert.deepEqual(invocation.argv, ["--cwd", sourceCwd, "worktree", "create"]);
    assert.equal(invocation.cwd, sourceCwd); assert.equal(invocation.marker, "test-collaborator");
    assert.equal(invocation.sandbox_environment, "native-environment-choice");
    assert.throws(() => validateWorkspace(cwd, f.boundaries), /Grok state/);
    assert.deepEqual(validateNativeWorkspace(plan, cwd, root, f.boundaries), result);
    assert.throws(() => validateNativeWorkspace(plan, cwd, f.source, f.boundaries), /root has changed/);
  }
});

test("returned root fallback is retained before rejection, with no source fallback or retry", async () => {
  const f = fixture(); init(f); const root = candidate(f), events = [];
  const plan = preflightWorkspace(join(f.source, "packages/web"), true, f.boundaries);
  await assert.rejects(provisionWorkspace(plan, "custom profile", hooks(events), { ...f.env, NATIVE_WORKSPACE_RETURN: root, NATIVE_WORKSPACE_STDERR: "native printing the worktree root\n" }, f.boundaries), error => {
    assert.equal(error.code, "native_worktree_not_admitted"); assert.match(error.message, /root fallback/);
    assert.equal(error.details.returned_cwd, root); assert.equal(error.details.stderr, "native printing the worktree root\n"); return true;
  });
  assert.ok(events.some(event => event[0] === "returned" && event[1] === root));
  assert.equal(readFileSync(f.trace, "utf8").trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.trace, "utf8")).argv, ["--cwd", plan.cwd, "--sandbox", "custom profile", "worktree", "create"]);
  assert.equal(existsSync(root), true);
});

test("profile denial and output loss keep native diagnostics and do not grant recreation", async () => {
  const f = fixture(); init(f); const plan = preflightWorkspace(f.source, true, f.boundaries);
  const events = [];
  await assert.rejects(provisionWorkspace(plan, "strict", hooks(events), { ...f.env, NATIVE_WORKSPACE_STDERR: "denied by strict\n", NATIVE_WORKSPACE_EXIT: "19" }, f.boundaries), error => {
    assert.equal(error.code, "native_worktree_failed"); assert.equal(error.details.stderr, "denied by strict\n");
    assert.equal(error.details.process.code, 19); assert.equal(error.details.stderr_truncated, false); return true;
  });
  assert.equal(events.filter(event => event[0] === "starting").length, 1);
  await assert.rejects(provisionWorkspace(plan, undefined, hooks(), f.env, f.boundaries), { code: "native_worktree_result_unknown" });
});

test("native-result admission rejects symlinks, other private state, a source result and changed metadata", () => {
  const f = fixture(); init(f); const plan = preflightWorkspace(f.source, true, f.boundaries), root = candidate(f);
  const alias = join(f.root, "alias"); symlinkSync(root, alias);
  assert.throws(() => validateNativeWorkspace(plan, alias, undefined, f.boundaries), /symlink/);
  assert.throws(() => validateNativeWorkspace(plan, f.source, undefined, f.boundaries), /separate/);
  const protectedResult = candidate(f, true, join(f.otherState, "bad-result"));
  assert.throws(() => validateNativeWorkspace(plan, protectedResult, undefined, f.boundaries), /Codex state/);
  rmSync(join(root, ".git"));
  assert.throws(() => validateNativeWorkspace(plan, root, root, f.boundaries), /non-Git/);
});

test("native-result root cannot contain a configured Grok-home alias but may remain inside the resolved home", () => {
  const f = fixture(); init(f);
  const broadRoot = candidate(f, true, join(f.root, "work"));
  const configuredHome = join(broadRoot, "grok-link"); symlinkSync(f.nativeHome, configuredHome);
  const legitimateRoot = candidate(f, true, join(f.nativeHome, "legitimate-tree"));
  // Cover an existing home and an absent home beneath an existing alias.
  for (const suffix of ["", "future-home"]) {
    const boundaries = { ...f.boundaries, protected_roots: [...f.boundaries.protected_roots,
      { path: join(configuredHome, suffix), label: "Grok state" }] };
    const plan = preflightWorkspace(f.source, true, boundaries);
    assert.throws(() => validateNativeWorkspace(plan, broadRoot, broadRoot, boundaries), /cannot contain the Grok state home/);
    assert.deepEqual(validateNativeWorkspace(plan, legitimateRoot, legitimateRoot, boundaries),
      { cwd: legitimateRoot, worktree_root: legitimateRoot });
  }
});

test("close cancellation retains a returned directory and waits for the observed utility exit", async () => {
  const f = fixture(); init(f); const root = candidate(f), controller = new AbortController(), events = [];
  const callbacks = hooks(events);
  callbacks.returned = path => { events.push(["returned", path]); controller.abort(); };
  callbacks.signal = controller.signal;
  await assert.rejects(provisionWorkspace(preflightWorkspace(f.source, true, f.boundaries), undefined, callbacks,
    { ...f.env, NATIVE_WORKSPACE_RETURN: root, NATIVE_WORKSPACE_HOLD: "1" }, f.boundaries), { code: "native_worktree_failed" });
  const exit = events.find(event => event[0] === "exited")[1];
  assert.equal(exit.signal, "SIGTERM"); assert.equal(existsSync(root), true);
});

test("provider startup omits or preserves sandbox, uses the same process cwd and exposes denial stderr plus exit", async () => {
  for (const sandbox of [undefined, "project-profile"]) {
    const f = fixture(), events = [];
    const native = new NativeConnection(f.source, sandbox, nativeHooks(events), f.env);
    await native.initialize(); await native.session(f.source, "session-fixture", false); await native.close("session-fixture");
    const invocation = JSON.parse(readFileSync(f.trace, "utf8"));
    assert.deepEqual(invocation.argv, ["--cwd", f.source, ...(sandbox === undefined ? [] : ["--sandbox", sandbox]), "agent", "--no-leader", "stdio"]);
    assert.equal(invocation.cwd, f.source);
  }
  const f = fixture(), events = [], native = new NativeConnection(f.source, "unavailable", nativeHooks(events),
    { ...f.env, NATIVE_WORKSPACE_STDERR: "Native project profile unavailable\n", NATIVE_WORKSPACE_EXIT: "23" });
  await assert.rejects(native.initialize(), error => {
    assert.equal(error.code, "native_startup_failed"); assert.equal(error.details.stderr, "Native project profile unavailable\n");
    assert.deepEqual(error.details.process, { code: 23, signal: null }); assert.equal(error.details.stderr_truncated, false); return true;
  });
  await native.close(); assert.equal(events.some(event => event[0] === "failure"), false);
});

test("startup diagnostics report bounded truncation and are discarded after initialize", async () => {
  const f = fixture(), native = new NativeConnection(f.source, undefined, nativeHooks([]),
    { ...f.env, NATIVE_WORKSPACE_LARGE_STDERR: "1", NATIVE_WORKSPACE_EXIT: "25" });
  await assert.rejects(native.initialize(), error => {
    assert.equal(error.details.stderr_truncated, true); assert.equal(Buffer.byteLength(error.details.stderr), 64 * 1024);
    assert.match(error.details.stderr, /^native denial/); return true;
  }); await native.close();
  const g = fixture(), successful = new NativeConnection(g.source, undefined, nativeHooks([]), { ...g.env, NATIVE_WORKSPACE_STDERR: "nonfailure startup warning\n" });
  await successful.initialize(); assert.equal(successful.startupStderr.length, 0); await successful.close();
});
