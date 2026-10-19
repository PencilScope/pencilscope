import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = resolve(root, ".wrangler-operations-e2e");
const configs = {
  api: join(root, "workers", "api", "wrangler.jsonc"),
  billing: join(root, "workers", "billing", "wrangler.jsonc"),
  admin: join(root, "workers", "system-admin", "wrangler.jsonc")
};
const fixture = join(root, "scripts", "fixtures", "operations-e2e.sql");
const wranglerCli = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const origins = {
  api: "http://127.0.0.1:8801",
  billing: "http://127.0.0.1:8802",
  admin: "http://127.0.0.1:8803"
};

if (!state.startsWith(root + "\\") && !state.startsWith(root + "/")) {
  throw new Error("Refusing to use operations test state outside the repository");
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const spawnTool = (args, options) => spawn(process.execPath, [wranglerCli, ...args], options);
const removeState = async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(state, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 11) throw error;
      await delay(300);
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
};
const json = async (response, expectedStatus = 200) => {
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  return payload;
};
const request = (origin, path, { method = "GET", headers = {}, body } = {}) => fetch(origin + path, {
  method,
  headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const waitForWorker = async (worker, origin, path, output) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (worker.exitCode !== null) throw new Error("Local Worker exited early:\n" + output());
    try {
      if ((await fetch(origin + path)).status < 500) return;
    } catch {
      // The local socket is still starting.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the local Worker:\n" + output());
};
const startWorker = async (config, port, readyPath) => {
  const worker = spawnTool([
    "dev", "--config", config, "--local", "--persist-to", state,
    "--port", String(port), "--ip", "127.0.0.1"
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  worker.stdout.on("data", (chunk) => { output += chunk; });
  worker.stderr.on("data", (chunk) => { output += chunk; });
  await waitForWorker(worker, `http://127.0.0.1:${port}`, readyPath, () => output);
  return worker;
};
const stopWorker = async (worker) => {
  if (!worker || worker.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(worker.pid), "/t", "/f"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    await once(killer, "exit");
  } else {
    worker.kill("SIGTERM");
  }
  if (worker.exitCode === null) {
    await Promise.race([once(worker, "exit"), delay(5_000)]);
  }
};
const user = (id) => ({ "x-pencilscope-user-id": id });
const staff = (email) => ({ "x-pencilscope-admin-email": email });

await removeState();
await run(["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", configs.api]);
await run(["d1", "execute", "DB", "--local", "--persist-to", state, "--config", configs.api, "--file", fixture]);

let worker;
try {
  worker = await startWorker(configs.api, 8801, "/api/health");
  assert.equal((await request(origins.api, "/api/dashboard")).status, 401);

  const contactInput = {
    submissionId: crypto.randomUUID(),
    name: "E2E Contact",
    countryCode: "SG",
    countryName: "Singapore",
    callingCode: "+65",
    phone: "81234567",
    enquiryType: "creator_support",
    message: "I need help publishing my first learning product.",
    sourcePath: "/courses",
    consentVersion: "2026-10"
  };
  const contact = await json(await request(origins.api, "/api/contact-enquiries", {
    method: "POST", body: contactInput
  }), 201);
  const contactRetry = await json(await request(origins.api, "/api/contact-enquiries", {
    method: "POST", body: contactInput
  }));
  assert.equal(contactRetry.enquiry.referenceCode, contact.enquiry.referenceCode);
  const expiredContact = await json(await request(origins.api, "/api/contact-enquiries", {
    method: "POST",
    body: {
      ...contactInput,
      submissionId: crypto.randomUUID(),
      name: "Expired E2E Contact",
      message: "This enquiry verifies permanent purge after the recovery window."
    }
  }), 201);

  const created = await json(await request(origins.api, "/api/creator/learning-products", {
    method: "POST",
    headers: user("tutor-tan"),
    body: {
      title: "Tenant A private product",
      description: "A draft product used to verify creator isolation.",
      subject: "Operations testing",
      audience: "All learners",
      productType: "reading",
      estimatedMinutes: 10,
      status: "draft",
      contentUrl: "https://example.test/tenant-a"
    }
  }), 201);
  const productId = created.product.id;
  const tenantAProducts = await json(await request(origins.api, "/api/creator/learning-products", {
    headers: user("tutor-tan")
  }));
  assert.ok(tenantAProducts.products.some((product) => product.id === productId));
  const tenantBProducts = await json(await request(origins.api, "/api/creator/learning-products", {
    headers: user("tutor-lim")
  }));
  assert.ok(!tenantBProducts.products.some((product) => product.id === productId));
  assert.equal((await request(origins.api, `/api/creator/learning-products/${encodeURIComponent(productId)}`, {
    method: "PATCH", headers: user("tutor-lim"),
    body: { title: "Cross-tenant update must fail", metadataOnly: true }
  })).status, 403);
  assert.equal((await request(origins.api, `/api/creator/learning-products/${encodeURIComponent(productId)}`, {
    method: "DELETE", headers: user("tutor-lim")
  })).status, 403);

  const creatorA = await json(await request(origins.api, "/api/payments", { headers: user("tutor-tan") }));
  assert.ok(creatorA.creatorSales.some((order) => order.id === "e2e-order-a"));
  const creatorB = await json(await request(origins.api, "/api/payments", { headers: user("tutor-lim") }));
  assert.ok(!creatorB.creatorSales.some((order) => order.id === "e2e-order-a"));
  const learnerA = await json(await request(origins.api, "/api/payments", { headers: user("e2e-learner-a") }));
  assert.ok(learnerA.purchases.some((order) => order.id === "e2e-order-a"));
  assert.ok(learnerA.paymentEvents.some((event) => event.order_id === "e2e-order-a"));
  const learnerB = await json(await request(origins.api, "/api/payments", { headers: user("e2e-learner-b") }));
  assert.ok(!learnerB.purchases.some((order) => order.id === "e2e-order-a"));
  assert.ok(!learnerB.paymentEvents.some((event) => event.order_id === "e2e-order-a"));

  const operations = await json(await request(origins.api, "/api/admin/billing?q=pi_e2e_order_a", {
    headers: user("e2e-finance")
  }));
  assert.equal(operations.accessRole, "finance");
  assert.ok(operations.payments.some((payment) => payment.id === "e2e-order-a"));
  assert.equal(Number(operations.alerts.paid_without_transaction), 0);
  assert.equal((await request(origins.api, "/api/admin/billing", { headers: user("tutor-tan") })).status, 403);
  const financeNavigation = await json(await request(origins.api, "/api/navigation-state", {
    headers: user("e2e-finance")
  }));
  assert.equal(financeNavigation.user.billingAccess, true);
  const creatorNavigation = await json(await request(origins.api, "/api/navigation-state", {
    headers: user("tutor-tan")
  }));
  assert.equal(creatorNavigation.user.billingAccess, false);

  await stopWorker(worker);
  worker = null;

  worker = await startWorker(configs.billing, 8802, "/");
  assert.equal((await request(origins.billing, "/")).status, 403);
  assert.equal((await request(origins.billing, "/", { headers: staff("support@e2e.invalid") })).status, 403);
  const billingPage = await request(origins.billing, "/", { headers: staff("finance@e2e.invalid") });
  assert.equal(billingPage.status, 200);
  assert.match(await billingPage.text(), /Billing/i);
  const overview = await json(await request(origins.billing, "/api/billing/overview", {
    headers: staff("finance@e2e.invalid")
  }));
  assert.ok(Number(overview.grossCents) >= 10000);
  const orders = await json(await request(origins.billing, "/api/billing/orders", {
    headers: staff("finance@e2e.invalid")
  }));
  assert.ok(orders.orders.some((order) => order.id === "e2e-order-a"));
  const subscriptions = await json(await request(origins.billing, "/api/billing/subscriptions", {
    headers: staff("finance@e2e.invalid")
  }));
  assert.ok(subscriptions.subscriptions.some((entry) => entry.id === "e2e-enrolment-offering-a"));
  const settlements = await json(await request(origins.billing, "/api/billing/settlements", {
    headers: staff("finance@e2e.invalid")
  }));
  assert.ok(settlements.settlements.some((earning) => earning.id === "e2e-earning-a"));
  const disputes = await json(await request(origins.billing, "/api/billing/disputes", {
    headers: staff("finance@e2e.invalid")
  }));
  assert.ok(disputes.disputes.some((paymentCase) => paymentCase.id === "e2e-payment-case-a"));
  const usage = await json(await request(origins.billing, "/api/billing/meeting-usage", {
    headers: staff("finance@e2e.invalid")
  }));
  assert.ok(Array.isArray(usage.usage));
  assert.equal((await request(origins.billing, "/api/billing/overview", {
    headers: staff("auditor@e2e.invalid")
  })).status, 200);

  await stopWorker(worker);
  worker = null;

  await run([
    "d1", "execute", "DB", "--local", "--persist-to", state, "--config", configs.api,
    "--command",
    `UPDATE contact_enquiries SET status = 'deleted', deleted_at = datetime('now', '-8 days'), recoverable_until = datetime('now', '-1 day') WHERE id = '${expiredContact.enquiry.id}'`
  ]);

  worker = await startWorker(configs.admin, 8803, "/");
  assert.equal((await request(origins.admin, "/")).status, 403);
  assert.equal((await request(origins.admin, "/", { headers: staff("finance@e2e.invalid") })).status, 403);
  assert.equal((await request(origins.admin, "/api/admin/overview", {
    headers: staff("support@e2e.invalid")
  })).status, 200);
  assert.equal((await request(origins.admin, "/api/admin/notifications", {
    method: "POST", headers: staff("support@e2e.invalid"),
    body: { title: "Forbidden", body: "Support cannot publish this message." }
  })).status, 403);

  const adminPage = await request(origins.admin, "/", { headers: staff("system-admin@e2e.invalid") });
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.headers.get("cache-control") ?? "", /no-store/i);
  assert.ok(adminPage.headers.has("content-security-policy"));
  for (const endpoint of ["overview", "enquiries", "users", "notifications", "courses", "orders", "settlements", "disputes", "sessions", "audit", "health"]) {
    assert.equal((await request(origins.admin, `/api/admin/${endpoint}`, {
      headers: staff("system-admin@e2e.invalid")
    })).status, 200, endpoint);
  }
  const enquiries = await json(await request(origins.admin, "/api/admin/enquiries", {
    headers: staff("system-admin@e2e.invalid")
  }));
  assert.ok(enquiries.enquiries.some((entry) => entry.id === contact.enquiry.id));
  const enquiryDetail = await json(await request(origins.admin, `/api/admin/enquiries/${contact.enquiry.id}`, {
    headers: staff("system-admin@e2e.invalid")
  }));
  assert.equal(enquiryDetail.enquiry.payload.enquiry.message, contactInput.message);
  assert.equal(enquiryDetail.enquiry.payload.contact.phone.e164, "+6581234567");
  assert.equal((await request(origins.admin, `/api/admin/enquiries/${contact.enquiry.id}/status`, {
    method: "POST", headers: staff("auditor@e2e.invalid"),
    body: { status: "in_progress", note: "Auditor mutation must fail" }
  })).status, 403);
  await json(await request(origins.admin, `/api/admin/enquiries/${contact.enquiry.id}/status`, {
    method: "POST", headers: staff("support@e2e.invalid"),
    body: { status: "in_progress", note: "Support team started reviewing the enquiry." }
  }));
  const deletedEnquiry = await json(await request(origins.admin, `/api/admin/enquiries/${contact.enquiry.id}/status`, {
    method: "POST", headers: staff("system-admin@e2e.invalid"),
    body: { status: "deleted", note: "E2E recoverable deletion verification." }
  }));
  const recoveryMs = Date.parse(deletedEnquiry.enquiry.recoverableUntil) - Date.now();
  assert.ok(recoveryMs > 6.9 * 86_400_000 && recoveryMs <= 7.1 * 86_400_000);
  await json(await request(origins.admin, `/api/admin/enquiries/${contact.enquiry.id}/restore`, {
    method: "POST", headers: staff("system-admin@e2e.invalid")
  }));
  assert.equal((await request(origins.admin, `/api/admin/enquiries/${expiredContact.enquiry.id}`, {
    headers: staff("system-admin@e2e.invalid")
  })).status, 410);

  const health = await json(await request(origins.admin, "/api/admin/health", {
    headers: staff("system-admin@e2e.invalid")
  }));
  assert.equal(health.database?.status ?? health.database, "ready");
  const notification = await json(await request(origins.admin, "/api/admin/notifications", {
    method: "POST", headers: staff("system-admin@e2e.invalid"),
    body: {
      audienceType: "specific_users",
      audienceValue: "learner-a@e2e.invalid",
      title: "E2E operations notice",
      body: "This message verifies targeted operations delivery.",
      category: "system",
      priority: "info"
    }
  }), 201);
  assert.equal(notification.campaign.recipientCount, 1);
  await json(await request(origins.admin, "/api/admin/users/e2e-learner-b/status", {
    method: "POST", headers: staff("system-admin@e2e.invalid"),
    body: { status: "suspended", reason: "E2E access-control verification" }
  }));
  await json(await request(origins.admin, "/api/admin/users/e2e-learner-b/status", {
    method: "POST", headers: staff("system-admin@e2e.invalid"),
    body: { status: "active", reason: "E2E access restored" }
  }));
  await json(await request(origins.admin, "/api/admin/disputes/e2e-payment-case-a/status", {
    method: "POST", headers: staff("system-admin@e2e.invalid"),
    body: { status: "resolved", note: "E2E operations review complete" }
  }));
  const audit = await json(await request(origins.admin, "/api/admin/audit", {
    headers: staff("system-admin@e2e.invalid")
  }));
  const auditActions = audit.events.map((event) => event.action);
  for (const action of ["contact_enquiry.viewed", "contact_enquiry.status_changed", "contact_enquiry.restored", "notification.published", "user.deactivated", "user.activated", "payment.case_closed"]) {
    assert.ok(auditActions.includes(action), `Missing audit action: ${action}`);
  }

  process.stdout.write(
    "Operations E2E passed: tenant isolation, contact R2 catalogue and recovery, learner/creator payments, billing RBAC and reports, system-admin RBAC, mutations, health and audit.\n"
  );
} finally {
  await stopWorker(worker);
  await removeState();
}
