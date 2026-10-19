import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = resolve(root, ".wrangler-mcp-products");
const apiConfig = join(root, "workers", "api", "wrangler.jsonc");
const mcpConfig = join(root, "workers", "mcp", "wrangler.jsonc");
const wranglerCli = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const apiOrigin = "http://127.0.0.1:8797";
const mcpOrigin = "http://localhost:8790";
const accessToken = "pencilscope-mcp-products-integration-token";
const accessTokenHash = createHash("sha256").update(accessToken).digest("base64url");

if (!state.startsWith(root + "\\") && !state.startsWith(root + "/")) {
  throw new Error("Refusing to use MCP test state outside the repository");
}

const spawnTool = (args) => spawn(process.execPath, [wranglerCli, ...args], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"]
});

const run = async (args) => {
  const child = spawnTool(args);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(output || `Command failed with exit code ${code}`);
  return output;
};

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

const waitForHealth = async (worker, origin, healthPath, output) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (worker.exitCode !== null) throw new Error(`Local Worker exited early:\n${output()}`);
    try {
      if ((await fetch(origin + healthPath, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // The local Worker socket is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${origin}:\n${output()}`);
};

const startWorker = async (config, port, healthOrigin, healthPath) => {
  const worker = spawnTool([
    "dev", "--config", config, "--local", "--persist-to", state,
    "--port", String(port), "--ip", port === 8790 ? "localhost" : "127.0.0.1"
  ]);
  let output = "";
  worker.stdout.on("data", (chunk) => { output += chunk; });
  worker.stderr.on("data", (chunk) => { output += chunk; });
  await waitForHealth(worker, healthOrigin, healthPath, () => output);
  return worker;
};

const stopWorker = async (worker) => {
  if (!worker || worker.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(worker.pid), "/t", "/f"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    await Promise.race([once(killer, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000))]);
  } else {
    worker.kill("SIGTERM");
  }
  if (worker.exitCode === null) {
    await Promise.race([once(worker, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
  }
};

const callTool = async (name, args = {}) => {
  const response = await fetch(mcpOrigin + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args }
    })
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error(`${name} returned ${response.status}: ${raw.slice(0, 2000)}`); }
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.error, undefined, JSON.stringify(payload));
  return payload.result;
};

console.log("Preparing isolated MCP test database...");
await removeState();
await run([
  "d1", "migrations", "apply", "DB", "--local", "--persist-to", state,
  "--config", apiConfig
]);
console.log("Local migrations applied.");

const now = new Date().toISOString();
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const refreshFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const seedSql = [
  `INSERT INTO mcp_oauth_clients (client_id,client_name,redirect_uris_json,created_at,updated_at) VALUES ('mcp-products-test','MCP products test','["http://localhost/callback"]','${now}','${now}')`,
  `INSERT INTO mcp_oauth_tokens (id,access_token_hash,refresh_token_hash,client_id,user_id,scopes_json,resource,access_expires_at,refresh_expires_at,created_at,updated_at) VALUES ('mcp-products-token','${accessTokenHash}','unused-refresh-hash','mcp-products-test','tutor-tan','["products:read","products:write","products:publish","courses:write"]','${mcpOrigin}/mcp','${future}','${refreshFuture}','${now}','${now}')`,
  `INSERT INTO learning_products (id,creator_id,slug,product_type,title,description,subject,audience,estimated_minutes,status,published_at,created_at,updated_at,listing_status) VALUES ('mcp-republish-product','tutor-tan','mcp-republish-product','ebook','MCP Republish Product','A published product used to verify the MCP republishing journey.','Testing','Creators',30,'published','${now}','${now}','${now}','unpublished')`,
  `INSERT INTO courses (id,tutor_id,slug,title,description,subject,primary_level,delivery_mode,price_cents,creator_price_cents,currency,status,created_at,updated_at) VALUES ('mcp-python-course','tutor-tan','mcp-python-course','Python Course Draft','A complete Python course draft used to verify MCP course discovery.','Programming','Beginners','live',0,0,'SGD','draft','${now}','${now}')`,
  `INSERT INTO course_modules (id,course_id,title,position,created_at) VALUES ('mcp-python-module','mcp-python-course','Python foundations',1,'${now}')`,
  `INSERT INTO lessons (id,module_id,title,lesson_type,content_json,position,estimated_minutes,created_at,updated_at) VALUES ('mcp-python-lesson','mcp-python-module','Your first Python program','text','{"summary":"Create and run a small Python program."}',1,20,'${now}','${now}')`,
  `INSERT INTO courses (id,tutor_id,slug,title,description,subject,primary_level,delivery_mode,price_cents,creator_price_cents,currency,status,created_at,updated_at) VALUES ('mcp-other-course','tutor-lim','mcp-other-course','Other Creator Course','A private draft that must not be visible to another creator.','Testing','Creators','self-paced',0,0,'SGD','draft','${now}','${now}')`
].join(";");
await run([
  "d1", "execute", "DB", "--local", "--persist-to", state,
  "--config", apiConfig, "--command", seedSql
]);
console.log("MCP test fixtures created.");

let apiWorker;
let mcpWorker;
try {
  console.log("Starting the local API Worker...");
  apiWorker = await startWorker(apiConfig, 8797, apiOrigin, "/api/health");
  console.log("Starting the local MCP Worker...");
  mcpWorker = await startWorker(mcpConfig, 8790, mcpOrigin, "/health");
  console.log("Local Workers are ready.");

  const toolsResponse = await fetch(mcpOrigin + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" })
  });
  const toolsRaw = await toolsResponse.text();
  let toolsPayload;
  try { toolsPayload = JSON.parse(toolsRaw); } catch { throw new Error(`tools/list returned ${toolsResponse.status}: ${toolsRaw.slice(0, 2000)}`); }
  assert.equal(toolsResponse.status, 200, JSON.stringify(toolsPayload));
  assert.ok(toolsPayload.result.tools.some((tool) => tool.name === "republish_product"));
  assert.ok(toolsPayload.result.tools.some((tool) => tool.name === "create_product_offer"));
  assert.ok(toolsPayload.result.tools.some((tool) => tool.name === "publish_product_offer"));

  const listTool = toolsPayload.result.tools.find((tool) => tool.name === "list_my_products");
  assert.ok(listTool.inputSchema.properties.productType.enum.includes("online_course"));
  assert.ok(listTool.inputSchema.properties.productType.enum.includes("in_person_course"));
  assert.ok(listTool.inputSchema.properties.productType.enum.includes("video_course"));
  assert.ok(listTool.inputSchema.properties.query);
  assert.ok(listTool.inputSchema.properties.cursor);

  const courseDrafts = await callTool("list_my_products", { status: "draft" });
  assert.equal(courseDrafts.isError, undefined, JSON.stringify(courseDrafts));
  assert.equal(courseDrafts.structuredContent.total, 1);
  assert.equal(courseDrafts.structuredContent.products[0].id, "mcp-python-course");
  assert.equal(courseDrafts.structuredContent.products[0].productType, "online_course");
  assert.equal(courseDrafts.structuredContent.products[0].entityKind, "course");
  assert.match(courseDrafts.structuredContent.products[0].studioUrl, /courseId=mcp-python-course/);
  assert.doesNotMatch(courseDrafts.content[0].text, /Other Creator Course/);

  const courseByTitle = await callTool("list_my_products", { query: "python course" });
  assert.equal(courseByTitle.structuredContent.total, 1);
  assert.equal(courseByTitle.structuredContent.products[0].id, "mcp-python-course");

  const firstPage = await callTool("list_my_products", { status: "all", limit: 1 });
  assert.equal(firstPage.structuredContent.products.length, 1);
  assert.ok(firstPage.structuredContent.nextCursor);
  const secondPage = await callTool("list_my_products", {
    status: "all", limit: 1, cursor: firstPage.structuredContent.nextCursor
  });
  assert.equal(secondPage.structuredContent.products.length, 1);
  assert.notEqual(secondPage.structuredContent.products[0].id, firstPage.structuredContent.products[0].id);

  const courseDetails = await callTool("get_my_product", { productId: "mcp-python-course" });
  assert.equal(courseDetails.isError, undefined);
  assert.equal(courseDetails.structuredContent.product.id, "mcp-python-course");
  assert.equal(courseDetails.structuredContent.product.productType, "online_course");
  assert.equal(courseDetails.structuredContent.modules.length, 1);
  assert.equal(courseDetails.structuredContent.lessons.length, 1);

  const courseReadiness = await callTool("validate_product_for_publication", { productId: "mcp-python-course" });
  assert.equal(courseReadiness.isError, undefined);
  assert.equal(courseReadiness.structuredContent.ready, true);
  assert.match(courseReadiness.structuredContent.nextStep, /course offering/i);

  const wrongPublishTool = await callTool("publish_product", {
    productId: "mcp-python-course", confirm: true
  });
  assert.equal(wrongPublishTool.isError, true);
  assert.equal(wrongPublishTool.structuredContent.error, "course_offering_required");
  assert.deepEqual(wrongPublishTool.structuredContent.nextTools, [
    "create_course_offering", "assign_offering_content", "publish_course_offering"
  ]);

  const unpublished = await callTool("list_my_products", { status: "unpublished" });
  assert.equal(unpublished.structuredContent.total, 1);
  assert.match(unpublished.content[0].text, /MCP Republish Product/);
  assert.match(unpublished.content[0].text, /type=ebook/);
  assert.match(unpublished.content[0].text, /status=unpublished/);
  assert.match(unpublished.content[0].text, /id=mcp-republish-product/);

  const refused = await callTool("republish_product", {
    productId: "mcp-republish-product",
    confirm: false
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error, "confirmation_required");

  const stillUnpublished = await callTool("list_my_products", { status: "unpublished" });
  assert.equal(stillUnpublished.structuredContent.total, 1);

  const republished = await callTool("republish_product", {
    productId: "mcp-republish-product",
    confirm: true
  });
  assert.equal(republished.isError, undefined);
  assert.equal(republished.structuredContent.product.listingStatus, "listed");
  assert.match(republished.content[0].text, /Product republished/);

  const published = await callTool("list_my_products", { status: "published", productType: "ebook" });
  assert.equal(published.structuredContent.total, 1);
  assert.match(published.content[0].text, /MCP Republish Product/);
  assert.match(published.content[0].text, /status=published/);

  const noLongerUnpublished = await callTool("list_my_products", { status: "unpublished" });
  assert.equal(noLongerUnpublished.structuredContent.total, 0);
  assert.equal(noLongerUnpublished.content[0].text, "No matching products found.");

  const createdOffer = await callTool("create_product_offer", {
    title: "MCP Independent Offer",
    description: "An independently priced product offer created by the MCP integration test.",
    priceCents: 500,
    currency: "SGD",
    productIds: ["mcp-republish-product"]
  });
  assert.equal(createdOffer.isError, undefined);
  assert.equal(createdOffer.structuredContent.offer.status, "draft");
  assert.equal(createdOffer.structuredContent.offer.product_count, 1);
  assert.equal(createdOffer.structuredContent.offer.items[0].id, "mcp-republish-product");

  const offers = await callTool("list_product_offers", { productId: "mcp-republish-product" });
  assert.equal(offers.structuredContent.offers.length, 1);
  assert.match(offers.content[0].text, /MCP Independent Offer/);
  assert.match(offers.content[0].text, /independent/);

  const publishRefused = await callTool("publish_product_offer", {
    offerId: createdOffer.structuredContent.offer.id,
    confirm: false
  });
  assert.equal(publishRefused.isError, true);
  assert.equal(publishRefused.structuredContent.error, "confirmation_required");

  console.log("MCP product lifecycle and independent offer integration checks passed.");
} finally {
  await stopWorker(mcpWorker);
  await stopWorker(apiWorker);
  await removeState();
}
