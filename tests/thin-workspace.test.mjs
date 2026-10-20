import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import fs, { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "grokpair-thin-workspace-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
await build({ entryPoints: [new URL("../src/workspace.ts", import.meta.url).pathname], outfile: join(scratch, "workspace.mjs"), bundle: true, platform: "node", format: "esm" });
const { preflightWorkspace, preflightAttachments, prepareAttachments, validateWorkspace, assertQueuedEditInput } = await import(join(scratch, "workspace.mjs"));
function fixture() {
  const root = mkdtempSync(join(scratch, "case-")), home = join(root, "home"), cwd = join(home, "repo"), state = join(home, ".state");
  mkdirSync(cwd, { recursive: true }); mkdirSync(state);
  return { root, cwd, home, state, boundaries: { user_home: home, protected_roots: [{ path: state, label: "private state" }] } };
}
function git(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}
function init(cwd) {
  git(cwd, "init", "--quiet"); writeFileSync(join(cwd, "tracked.txt"), "base\n");
  writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
  git(cwd, "add", "."); git(cwd, "commit", "--quiet", "-m", "fixture");
}
test("canonical non-Git cwd is accepted; aliases, missing paths, root, home and private state are rejected", () => {
  const f = fixture();
  assert.equal(validateWorkspace(f.cwd, f.boundaries), f.cwd);
  assert.deepEqual(preflightWorkspace(f.cwd, false, f.boundaries), { cwd: f.cwd, worktree: false });
  symlinkSync(f.cwd, join(f.root, "alias"));
  writeFileSync(join(f.root, "file"), "x");
  for (const path of ["/", f.home, f.state, join(f.root, "missing"), join(f.root, "file"), join(f.root, "alias"), `${f.cwd}/../repo`, `${f.cwd}/`, "relative"]) {
    assert.throws(() => validateWorkspace(path, f.boundaries), undefined, path);
  }
});
test("ordinary directory execution never discovers Git; worktree preflight rejects unsafe derived roots", () => {
  for (const target of ["home", "root"]) {
    const f = fixture(); init(f[target]);
    assert.deepEqual(preflightWorkspace(f.cwd, false, f.boundaries), { cwd: f.cwd, worktree: false });
    assert.throws(() => preflightWorkspace(f.cwd, true, f.boundaries), /contain|overlap/);
  }
  const f = fixture(); init(f.cwd); mkdirSync(join(f.cwd, "private"));
  f.boundaries.protected_roots.push({ path: join(f.cwd, "private"), label: "nested private state" });
  assert.deepEqual(preflightWorkspace(f.cwd, false, f.boundaries), { cwd: f.cwd, worktree: false });
  assert.throws(() => preflightWorkspace(f.cwd, true, f.boundaries), /overlap/);
});
test("ordinary directory execution remains valid when Git is unavailable", () => {
  const f = fixture(), original = process.env.PATH;
  try {
    process.env.PATH = join(f.root, "no-executables");
    assert.deepEqual(preflightWorkspace(f.cwd, false, f.boundaries), { cwd: f.cwd, worktree: false });
  } finally { if (original === undefined) delete process.env.PATH; else process.env.PATH = original; }
});
test("worktree preflight retains the source-relative position without creating a custom candidate or capturing a commit", () => {
  const f = fixture(); init(f.cwd);
  const nested = join(f.cwd, "packages", "web"); mkdirSync(nested, { recursive: true });
  const before = git(f.cwd, "worktree", "list", "--porcelain");
  const plan = preflightWorkspace(nested, true, f.boundaries);
  assert.deepEqual(plan, { cwd: nested, worktree: true, repository: f.cwd, relative_cwd: "packages/web" });
  assert.equal(git(f.cwd, "worktree", "list", "--porcelain"), before);
  assert.equal(Object.hasOwn(plan, "candidate"), false);
  assert.equal(Object.hasOwn(plan, "base_sha"), false);
});
test("worktree preflight refuses non-Git input without changing it or falling back to direct execution", () => {
  const f = fixture(); writeFileSync(join(f.cwd, "input.txt"), "unchanged");
  assert.throws(() => preflightWorkspace(f.cwd, true, f.boundaries), /Git|repository/);
  assert.deepEqual(readdirSync(f.cwd), ["input.txt"]);
  assert.equal(readFileSync(join(f.cwd, "input.txt"), "utf8"), "unchanged");
});
test("worktree preflight preserves canonical paths with trailing spaces", () => {
  const f = fixture(), cwd = join(f.home, "repo with space "); mkdirSync(cwd); init(cwd);
  const nested = join(cwd, "subdirectory "); mkdirSync(nested);
  const plan = preflightWorkspace(nested, true, f.boundaries);
  assert.equal(plan.cwd, nested); assert.equal(plan.repository, cwd); assert.equal(plan.relative_cwd, "subdirectory ");
});
test("references preserve exact path data without reading, embedding or depositing any content", async () => {
  const f = fixture(), external = join(f.root, "native-output"); mkdirSync(external);
  const fixtures = [
    ["note.md", Buffer.from("\ufeff# Original\r\nline\r\n")],
    ["doc.pdf", Buffer.from("%PDF-1.7\noriginal\n%%EOF")],
    ["audio.wav", Buffer.from("RIFF0000WAVEpayload")],
    ["video.mp4", Buffer.from([0, 255, 254])],
    ['quoted"\\line\n<>&😀e\u0301.bin', Buffer.from([0, 1, 255])],
    ["empty", Buffer.alloc(0)],
  ];
  const inputs = fixtures.map(([name, data]) => {
    const path = join(external, name); writeFileSync(path, data); return { path, kind: "reference" };
  });
  const before = readdirSync(external);
  const probe = await fsPromises.open(inputs[0].path, "r"), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = mock.method(prototype, "read", () => { throw Error("reference payload read is forbidden"); });
  let output;
  try { preflightAttachments(inputs); output = await prepareAttachments(inputs); }
  finally { read.mock.restore(); }
  assert.equal(output.blocks.length, fixtures.length);
  for (let i = 0; i < fixtures.length; i++) {
    const block = output.blocks[i], path = inputs[i].path;
    assert.deepEqual(output.inputs[i], { path, kind: "reference", bytes: fixtures[i][1].length });
    const escaped = JSON.stringify(path).replace(/[<>&]/gu, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
    assert.deepEqual(block, { type: "resource_link", uri: pathToFileURL(path).href,
      name: "Local file path (JSON string): " + escaped, _meta: {} });
    assert.equal(JSON.parse(block.name.slice("Local file path (JSON string): ".length)), path);
    assert.deepEqual(readFileSync(path), fixtures[i][1]);
  }
  assert.deepEqual(readdirSync(external), before);
});
test("image bytes select all seven formats regardless of extensions, with no conversion or capability gates", async () => {
  const f = fixture();
  const images = [
    [Buffer.from([137,80,78,71,13,10,26,10]), "image/png"],
    [Buffer.from([255,216,255,224]), "image/jpeg"],
    [Buffer.from("GIF89aoriginal"), "image/gif"],
    [Buffer.from("RIFF0000WEBPoriginal"), "image/webp"],
    [Buffer.from("BM000000000000original"), "image/bmp"],
    [Buffer.from([73,73,42,0,0,0,0,0]), "image/tiff"],
    [Buffer.from([77,77,0,42,0,0,0,0]), "image/tiff"],
    [Buffer.from([0,0,1,0,1,0]), "image/x-icon"],
  ];
  for (const [index, [bytes, mimeType]] of images.entries()) {
    const path = join(f.root, index + ".not-an-image"); writeFileSync(path, bytes);
    const inputs = [{ path, kind: "image" }]; preflightAttachments(inputs);
    const result = await prepareAttachments(inputs);
    assert.deepEqual(result.blocks, [{ type: "image", mimeType, data: bytes.toString("base64") }]);
    assert.deepEqual(result.inputs, [{ path, kind: "image", mime_type: mimeType, bytes: bytes.length }]);
  }
});
test("image encoding is asynchronous, reuses bounded binary storage and preserves partial-read boundaries", async () => {
  const f = fixture(), path = join(f.root, "large.image");
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 173);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); writeFileSync(path, bytes);
  const probe = await fsPromises.open(path, "r"), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close();
  const buffers = new Set(); let reads = 0, timerRan = false;
  const read = mock.method(prototype, "read", async function(buffer, offset, length, position) {
    buffers.add(buffer); reads++;
    return originalRead.call(this, buffer, offset, Math.min(length, 7919), position);
  });
  const timer = setTimeout(() => { timerRan = true; }, 0);
  let result;
  try { result = await prepareAttachments([{ path, kind: "image" }]); }
  finally { read.mock.restore(); clearTimeout(timer); }
  assert.ok(timerRan); assert.ok(reads > 20); assert.equal(buffers.size, 1);
  assert.ok([...buffers][0].length < bytes.length);
  assert.deepEqual(Buffer.from(result.blocks[0].data, "base64"), bytes);
});
test("image preflight rejects mistyped payloads before admission and never falls back", async () => {
  const f = fixture(), path = join(f.root, "actually-not-image.png");
  writeFileSync(path, "RIFF0000WAVEoriginal");
  const inputs = [{ path, kind: "image" }];
  assert.throws(() => preflightAttachments(inputs), error => {
    assert.match(error.message, /attachments\[0\].*kind="image".*Unrecognized image bytes/);
    return true;
  });
  await assert.rejects(prepareAttachments(inputs), error => {
    assert.match(error.message, /attachments\[0\].*kind="image".*Unrecognized image bytes/);
    assert.ok(error.message.includes(JSON.stringify(path)));
    return true;
  });
  assert.equal((await prepareAttachments([{ path, kind: "reference" }])).blocks[0].type, "resource_link");
});
test("image preflight reads only its signature, handles short reads, and references read no payload", () => {
  const f = fixture(), path = join(f.root, "image.png");
  writeFileSync(path, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(100000)]));
  const original = fs.readSync;
  let readBytes = 0;
  const read = mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
    const count = original(fd, buffer, offset, Math.min(length, 3), position);
    readBytes += count; return count;
  });
  syncBuiltinESMExports();
  try {
    preflightAttachments([{ path, kind: "image" }]); assert.equal(readBytes, 14);
    preflightAttachments([{ path, kind: "reference" }]); assert.equal(readBytes, 14);
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
});
test("references have no attachment-count or byte budget and allow a root-level file parent", async () => {
  const f = fixture(), path = join(f.root, "sparse.file");
  writeFileSync(path, ""); truncateSync(path, 256 * 1024 * 1024);
  const inputs = Array.from({ length: 20 }, () => ({ path, kind: "reference" }));
  preflightAttachments(inputs);
  const result = await prepareAttachments(inputs);
  assert.equal(result.blocks.length, 20); assert.equal(result.inputs[0].bytes, 256 * 1024 * 1024);
  assert.throws(() => preflightAttachments([{ path: "/grokpair-nonexistent-input-file", kind: "reference" }]), error => {
    assert.match(error.message, /ENOENT/); assert.doesNotMatch(error.message, /Filesystem root cannot/); return true;
  });
  assert.deepEqual(await prepareAttachments([]), { blocks: [], inputs: [] });
});
test("inputs reject aliases, non-regular files, malformed paths and unknown kind with indexed diagnostics", async () => {
  const f = fixture(), path = join(f.root, "file"); writeFileSync(path, "x");
  const alias = join(f.root, "alias"); symlinkSync(path, alias);
  const parentAlias = join(f.root, "alias-dir"); symlinkSync(f.cwd, parentAlias);
  writeFileSync(join(f.cwd, "nested"), "x");
  const invalid = [
    { path: alias, kind: "reference" }, { path: join(parentAlias, "nested"), kind: "reference" },
    { path: f.cwd, kind: "reference" }, { path: "relative", kind: "reference" },
    { path: path + "/", kind: "reference" }, { path: path + "\0", kind: "reference" },
    { path: path + "\ud800", kind: "reference" }, { path: path + "\udc00", kind: "reference" },
    { path, kind: "audio" }, { path },
  ];
  for (const input of invalid) {
    const diagnostic = error => {
      assert.ok(error.message.includes("attachments[0]"));
      assert.ok(error.message.includes(JSON.stringify(input.path)));
      assert.ok(error.message.includes("kind=")); return true;
    };
    assert.throws(() => preflightAttachments([input]), diagnostic);
    await assert.rejects(prepareAttachments([input]), diagnostic);
  }
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
});
test("image preparation rejects file mutation rather than returning mixed bytes", async () => {
  const f = fixture(), path = join(f.root, "changing.png");
  writeFileSync(path, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(300000)]));
  const probe = await fsPromises.open(path, "r"), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close(); let changed = false;
  const read = mock.method(prototype, "read", async function(...args) {
    const result = await originalRead.apply(this, args);
    if (!changed) { changed = true; appendFileSync(path, "mutation"); }
    return result;
  });
  try { await assert.rejects(prepareAttachments([{ path, kind: "image" }]), /identity or metadata changed/); }
  finally { read.mock.restore(); }
});
test("queued edits preserve only known no-input or image-only metadata without rereading files", () => {
  const image = { path: "/no-longer-existing/image.png", kind: "image", mime_type: "image/png", bytes: 8 };
  const reference = { path: "/workspace/document", kind: "reference", bytes: 20 };
  for (const attachments of [[], [image], Array.from({ length: 20 }, () => ({ ...image, bytes: 256 * 1024 * 1024 }))]) {
    assert.doesNotThrow(() => assertQueuedEditInput({ task: "retained", attachments }));
  }
  for (const attachments of [[reference], [image, reference]]) {
    assert.throws(() => assertQueuedEditInput({ task: "retained", attachments }), /non-image or unknown.*new follow_up/);
  }
  for (const value of [undefined, null, [], {}, { attachments: null }, { attachments: {} },
    { attachments: [null] }, { attachments: [{}] }, { attachments: [{ ...image, bytes: -1 }] },
    { attachments: [{ ...image, mime_type: "text/plain" }] }, { attachments: [{ ...image, path: "relative" }] },
    { attachments: [{ ...image, extra: true }] }, { attachments: [{ ...image, kind: "document" }] }]) {
    assert.throws(() => assertQueuedEditInput(value), undefined, JSON.stringify(value));
  }
});
