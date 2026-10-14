import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = resolve(root, ".wrangler-storage-integration");
const config = join(root, "workers", "api", "wrangler.jsonc");
const wranglerCli = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const origin = "http://127.0.0.1:8798";
const headers = { "x-pencilscope-user-id": "tutor-tan" };
const paidHeaders = { "x-pencilscope-user-id": "tutor-lim" };

if (!state.startsWith(root + "\\") && !state.startsWith(root + "/")) {
  throw new Error("Refusing to use integration state outside the repository");
}

const spawnTool = (args, options) => spawn(process.execPath, [wranglerCli, ...args], options);
const removeState = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(state, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
};
const run = async (args) => {
  const child = spawnTool(args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(output || `Command failed with exit code ${code}`);
  return output;
};

const json = async (response) => {
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
};

const waitForHealth = async (worker, output) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (worker.exitCode !== null) throw new Error("Local Worker exited early:\n" + output());
    try {
      const response = await fetch(origin + "/api/health");
      if (response.ok) return;
    } catch {
      // The local socket is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Timed out waiting for the local Worker:\n" + output());
};

const stopWorker = async (worker) => {
  if (worker.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(worker.pid), "/t", "/f"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    await once(killer, "exit");
  } else {
    worker.kill("SIGTERM");
  }
  if (worker.exitCode === null) {
    await Promise.race([once(worker, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
  }
};

const upload = async (path, filename, contents, mimeType = "text/plain", title = "Integration asset") => {
  const form = new FormData();
  form.append("file", new Blob([contents], { type: mimeType }), filename);
  form.append("title", title);
  return json(await fetch(origin + path, { method: "POST", headers, body: form }));
};

await removeState();
await run(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", config]);
await run([
  "d1", "execute", "DB", "--local", "--persist-to", state, "--config", config,
  "--command",
  "INSERT INTO creator_storage_subscriptions (user_id, additional_blocks, status, created_at, updated_at) VALUES ('tutor-lim', 2, 'active', datetime('now'), datetime('now')), ('tutor-koh', 3, 'canceled', datetime('now'), datetime('now'))"
]);

const worker = spawnTool([
  "dev", "--config", config, "--local", "--persist-to", state,
  "--port", "8798", "--ip", "127.0.0.1"
], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let workerOutput = "";
worker.stdout.on("data", (chunk) => { workerOutput += chunk; });
worker.stderr.on("data", (chunk) => { workerOutput += chunk; });

try {
  await waitForHealth(worker, () => workerOutput);

  const freeStorage = await json(await fetch(origin + "/api/creator/storage", { headers }));
  assert.equal(freeStorage.storage.includedBytes, 5_000_000_000);
  assert.equal(freeStorage.storage.blockBytes, 10_000_000_000);
  assert.equal(freeStorage.storage.pricePerBlockCents, 500);
  assert.equal(freeStorage.storage.additionalBlocks, 0);
  assert.equal(freeStorage.storage.quotaBytes, 5_000_000_000);

  const paidStorage = await json(await fetch(origin + "/api/creator/storage", { headers: paidHeaders }));
  assert.equal(paidStorage.storage.additionalBlocks, 2);
  assert.equal(paidStorage.storage.quotaBytes, 25_000_000_000);
  assert.equal(paidStorage.storage.currency, "SGD");

  const canceledStorage = await json(await fetch(origin + "/api/creator/storage", {
    headers: { "x-pencilscope-user-id": "tutor-koh" }
  }));
  assert.equal(canceledStorage.storage.additionalBlocks, 0);
  assert.equal(canceledStorage.storage.quotaBytes, 5_000_000_000);

  const invalidUpgrade = await fetch(origin + "/api/creator/storage/checkout", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ blocks: 21 })
  });
  assert.equal(invalidUpgrade.status, 400);
  assert.equal((await invalidUpgrade.json()).error.code, "invalid_storage_blocks");

  const firstContents = "immutable version one\n";
  const created = await upload("/api/creator/content-library", "version-one.txt", firstContents);
  const itemId = created.item.id;
  assert.equal(created.item.currentVersion, 1);
  assert.equal(created.item.versionCount, 1);

  const secondContents = "immutable version two is longer\n";
  const replaced = await upload(
    `/api/creator/content-library/items/${encodeURIComponent(itemId)}/versions`,
    "version-two.txt",
    secondContents
  );
  assert.equal(replaced.versionNumber, 2);
  assert.equal(replaced.item.currentVersion, 2);
  assert.equal(replaced.item.versionCount, 2);

  const versionPayload = await json(await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(itemId)}/versions`,
    { headers }
  ));
  assert.equal(versionPayload.versions.length, 2);
  assert.equal(versionPayload.versions[0].isCurrent, true);
  const firstVersion = versionPayload.versions.find((entry) => entry.versionNumber === 1);
  assert.ok(firstVersion);
  assert.equal("objectKey" in firstVersion, false);

  const currentContent = await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(itemId)}/content`,
    { headers }
  );
  assert.equal(await currentContent.text(), secondContents);

  const library = await json(await fetch(origin + "/api/creator/content-library", { headers }));
  assert.equal(library.storage.usedBytes, Buffer.byteLength(firstContents) + Buffer.byteLength(secondContents));
  assert.equal(library.storage.blockBytes, 10_000_000_000);

  const rolledBack = await json(await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(firstVersion.id)}/restore`,
    { method: "POST", headers }
  ));
  assert.equal(rolledBack.versionNumber, 3);
  const restoredContent = await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(itemId)}/content`,
    { headers }
  );
  assert.equal(await restoredContent.text(), firstContents);

  const removed = await json(await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(itemId)}`,
    { method: "DELETE", headers }
  ));
  const recoveryMilliseconds = Date.parse(removed.recoverableUntil) - Date.now();
  assert.ok(recoveryMilliseconds > 6.9 * 86_400_000 && recoveryMilliseconds <= 7.1 * 86_400_000);
  const inaccessible = await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(itemId)}/content`,
    { headers }
  );
  assert.equal(inaccessible.status, 404);
  const deleted = await json(await fetch(origin + "/api/creator/content-library?status=deleted", { headers }));
  assert.equal(deleted.items.some((entry) => entry.id === itemId), true);
  assert.equal(deleted.storage.usedBytes, Buffer.byteLength(firstContents) + Buffer.byteLength(secondContents));

  const recovered = await json(await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(itemId)}/restore`,
    { method: "POST", headers }
  ));
  assert.equal(recovered.restored, true);
  assert.equal(recovered.item.status, "active");
  const afterRecovery = await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(itemId)}/content`,
    { headers }
  );
  assert.equal(await afterRecovery.text(), firstContents);

  const imageVersionOne = "integration image version one";
  const imageVersionTwo = "integration image version two";
  const imageUpload = await upload(
    "/api/creator/content-library",
    "question-image.png",
    imageVersionOne,
    "image/png",
    "Assessment diagram"
  );
  const imageItemId = imageUpload.item.id;
  const questionId = "integration-media-question";
  const quiz = await json(await fetch(origin + "/api/creator/learning-products", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Integration media quiz",
      description: "Integration coverage for immutable assessment question media.",
      subject: "Storage architecture",
      audience: "Integration testers",
      productType: "quiz",
      estimatedMinutes: 5,
      passingScore: 50,
      status: "published",
      questions: [{
        id: questionId,
        prompt: "Which version of the diagram should this question retain?",
        options: ["Version one", "Version two"],
        correctIndex: 0,
        explanation: "Question media is pinned to an immutable asset version.",
        mediaLibraryItemId: imageItemId,
        mediaAltText: "A storage version diagram",
        mediaCaption: "Pinned assessment media"
      }]
    })
  }));

  await upload(
    `/api/creator/content-library/items/${encodeURIComponent(imageItemId)}/versions`,
    "question-image-v2.png",
    imageVersionTwo,
    "image/png",
    "Assessment diagram"
  );
  const products = await json(await fetch(origin + "/api/creator/learning-products", { headers }));
  const createdQuiz = products.products.find((entry) => entry.id === quiz.product.id);
  assert.equal(createdQuiz.questions[0].media.mediaType, "image");
  assert.equal(createdQuiz.questions[0].media.altText, "A storage version diagram");
  const pinnedMedia = await fetch(
    origin + `/api/learning-products/${encodeURIComponent(quiz.product.slug)}/questions/${encodeURIComponent(questionId)}/media`,
    { headers }
  );
  assert.equal(pinnedMedia.status, 200);
  assert.equal(await pinnedMedia.text(), imageVersionOne);

  const inUseDelete = await fetch(
    origin + `/api/creator/content-library/items/${encodeURIComponent(imageItemId)}`,
    { method: "DELETE", headers }
  );
  assert.equal(inUseDelete.status, 409);
  assert.equal((await inUseDelete.json()).error.code, "library_item_in_use");

  process.stdout.write("R2 storage integration passed: catalogue, immutable versions, assessment media, quota, rollback, delete and recovery.\n");
} finally {
  await stopWorker(worker);
  await removeState();
}
