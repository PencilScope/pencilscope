import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = resolve(root, ".wrangler-product-journeys");
const config = join(root, "workers", "api", "wrangler.jsonc");
const wranglerCli = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const origin = "http://127.0.0.1:8797";
const creatorHeaders = { "x-pencilscope-user-id": "tutor-tan" };
const learnerHeaders = { "x-pencilscope-user-id": "journey-learner" };

if (!state.startsWith(root + "\\") && !state.startsWith(root + "/")) {
  throw new Error("Refusing to use journey state outside the repository");
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
const runLocalMigrations = async () => {
  const args = ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", config];
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return await run(args);
    } catch (error) {
      lastError = error;
      if (!/internal error|SQLITE_IOERR|runtime failed to start/i.test(String(error?.message ?? error)) || attempt === 10) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    }
  }
  throw lastError;
};
const json = async (response, expectedStatus) => {
  const payload = await response.json().catch(() => ({}));
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  else assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
};
const api = (path, { method = "GET", headers = creatorHeaders, body } = {}) => fetch(origin + path, {
  method,
  headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const upload = async (filename, contents, mimeType, title) => {
  const form = new FormData();
  form.append("file", new Blob([contents], { type: mimeType }), filename);
  form.append("title", title);
  return json(await fetch(origin + "/api/creator/content-library", {
    method: "POST", headers: creatorHeaders, body: form
  }), 201);
};
const waitForHealth = async (worker, output) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (worker.exitCode !== null) throw new Error("Local Worker exited early:\n" + output());
    try {
      if ((await fetch(origin + "/api/health")).ok) return;
    } catch {
      // Worker socket is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Timed out waiting for the local Worker:\n" + output());
};
const startWorker = async () => {
  const worker = spawnTool([
    "dev", "--config", config, "--local", "--persist-to", state,
    "--port", "8797", "--ip", "127.0.0.1"
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  worker.stdout.on("data", (chunk) => { output += chunk; });
  worker.stderr.on("data", (chunk) => { output += chunk; });
  await waitForHealth(worker, () => output);
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

await removeState();
await runLocalMigrations();
await run([
  "d1", "execute", "DB", "--local", "--persist-to", state, "--config", config,
  "--command",
  "UPDATE courses SET status='published',listing_status='listed' WHERE id='course-maths-5';UPDATE course_offerings SET status='published',pricing_status='ready',stripe_price_id='price_journey_course' WHERE id='offering-course-maths-5';INSERT INTO users (id,email,display_name,role,status,created_at,updated_at) VALUES ('journey-learner','journey@example.invalid','Journey Learner','student','active',datetime('now'),datetime('now'));INSERT OR REPLACE INTO platform_roles (user_id,role,granted_by,granted_at,revoked_at) VALUES ('tutor-tan','finance','tutor-tan',datetime('now'),NULL);INSERT INTO orders (id,student_user_id,course_id,course_offering_id,stripe_checkout_session_id,stripe_payment_intent_id,amount_cents,currency,status,created_at,updated_at) VALUES ('journey-payout-order','journey-learner','course-maths-5','offering-course-maths-5','cs_journey_payout','pi_journey_payout',10000,'SGD','paid',datetime('now','-8 days'),datetime('now','-8 days'));INSERT INTO creator_earnings (id,order_id,course_id,course_offering_id,creator_user_id,currency,gross_cents,platform_fee_cents,payable_cents,status,created_at,updated_at) VALUES ('journey-payout-earning','journey-payout-order','course-maths-5','offering-course-maths-5','tutor-tan','SGD',10000,1050,8950,'pending_course',datetime('now','-8 days'),datetime('now','-8 days'));INSERT INTO payment_transactions (id,order_id,provider,provider_transaction_id,transaction_type,amount_cents,currency,status,metadata_json,occurred_at,created_at) VALUES ('journey-payment-transaction','journey-payout-order','stripe','pi_journey_payout','payment',10000,'SGD','paid','{}',datetime('now','-8 days'),datetime('now','-8 days'));INSERT INTO payment_lifecycle_events (id,order_id,event_type,status,title,detail,provider_event_id,metadata_json,occurred_at,created_at) VALUES ('journey-payment-confirmed','journey-payout-order','payment_confirmed','paid','Payment confirmed','Your payment was received securely.','pi_journey_payout','{}',datetime('now','-8 days'),datetime('now','-8 days'));"
]);

let worker;
const publishedProducts = [];
try {
  worker = await startWorker();

  const payoutAccount = await json(await api("/api/creator/payout-account"));
  assert.equal(payoutAccount.payoutAccount.status, "not_configured");
  const creatorPayments = await json(await api("/api/payments"));
  const evergreenEarning = creatorPayments.creatorSales.find((sale) => sale.id === "journey-payout-order");
  assert.equal(evergreenEarning.settlement_status, "eligible");
  assert.ok(Date.parse(evergreenEarning.review_ends_at) <= Date.now());
  assert.ok(creatorPayments.paymentEvents.some((event) =>
    event.order_id === "journey-payout-order" && event.event_type === "payment_confirmed"
  ));
  assert.ok(Array.isArray(creatorPayments.payoutBatches));
  const billingOperations = await json(await api("/api/admin/billing?q=pi_journey_payout"));
  assert.equal(billingOperations.accessRole, "finance");
  assert.equal(billingOperations.payments.length, 1);
  assert.equal(billingOperations.payments[0].id, "journey-payout-order");
  assert.equal(Number(billingOperations.alerts.paid_without_transaction), 0);
  const blockedRelease = await api("/api/creator/payouts/release", { method: "POST", body: {} });
  assert.equal(blockedRelease.status, 409);
  assert.equal((await blockedRelease.json()).error.code, "payout_setup_required");

  const publicCourses = await json(await api("/api/courses", { headers: {} }));
  assert.ok(Array.isArray(publicCourses.courses), "The public course catalogue should return a course list");

  let unpricedCourseId = "";
  let inPersonCourseId = "";
  const courseMatrix = [
    { key: "online_course", deliveryMode: "live" },
    { key: "in_person_course", deliveryMode: "hybrid" },
    { key: "video_course", deliveryMode: "self-paced" }
  ];
  for (const entry of courseMatrix) {
    const title = `Journey ${entry.key.replaceAll("_", " ")}`;
    const created = await json(await api("/api/tutor/courses", {
      method: "POST",
      body: {
        title,
        description: `A complete local journey test for the ${entry.key} creator workflow.`,
        subject: "Journey testing",
        primaryLevel: "All learners",
        deliveryMode: entry.deliveryMode,
        currency: "SGD",
        publish: false,
        categorySlugs: []
      }
    }), 201);
    assert.equal(created.course.status, "draft");
    if (!unpricedCourseId) unpricedCourseId = created.course.id;
    if (entry.key === "in_person_course") inPersonCourseId = created.course.id;
    const studio = await json(await api(`/api/tutor/courses/${encodeURIComponent(created.course.id)}/studio`));
    assert.equal(studio.course.delivery_mode, entry.deliveryMode);
    assert.equal(studio.course.price_cents, 0);
    const edited = await json(await api(`/api/tutor/courses/${encodeURIComponent(created.course.id)}`, {
      method: "PATCH",
      body: {
        title: `${title} edited`,
        description: `An edited local journey test for the ${entry.key} creator workflow.`,
        subject: "Journey testing",
        primaryLevel: "All learners",
        deliveryMode: entry.deliveryMode
      }
    }));
    assert.equal(edited.course.title, `${title} edited`);
  }

  const scheduledOffering = await json(await api(`/api/tutor/courses/${encodeURIComponent(inPersonCourseId)}/offerings`, {
    method: "POST",
    body: {
      title: "Singapore weekend cohort", offeringType: "cohort", deliveryMode: "in_person",
      priceCents: 5000, startsAt: "2027-02-06T01:00:00.000Z", endsAt: "2027-02-07T09:00:00.000Z",
      enrolmentOpensAt: "2026-12-01T00:00:00.000Z", enrolmentClosesAt: "2027-02-05T12:00:00.000Z",
      accessEndsAt: "2027-03-07T09:00:00.000Z", timezone: "Asia/Singapore", capacity: 20
    }
  }), 201);
  assert.equal(scheduledOffering.offering.status, "draft");
  const updatedOffering = await json(await api(`/api/tutor/offerings/${encodeURIComponent(scheduledOffering.offering.id)}`, {
    method: "PATCH",
    body: { enrolmentClosesAt: "2027-02-04T12:00:00.000Z", accessEndsAt: "2027-03-14T09:00:00.000Z", capacity: 18 }
  }));
  assert.equal(updatedOffering.offering.capacity, 18);
  assert.equal(updatedOffering.offering.accessEndsAt, "2027-03-14T09:00:00.000Z");
  const scheduledSession = await json(await api(`/api/tutor/offerings/${encodeURIComponent(scheduledOffering.offering.id)}/sessions`, {
    method: "POST",
    body: {
      title: "Workshop day one", deliveryMode: "in_person",
      startsAt: "2027-02-06T01:00:00.000Z", endsAt: "2027-02-06T09:00:00.000Z",
      timezone: "Asia/Singapore", capacity: 18, venueName: "Learning Hall",
      venueAddress: "1 Knowledge Road", city: "Singapore", arrivalInstructions: "Report at reception."
    }
  }), 201);
  const updatedSession = await json(await api(`/api/tutor/sessions/${encodeURIComponent(scheduledSession.session.id)}`, {
    method: "PATCH",
    body: {
      startsAt: "2027-02-06T01:30:00.000Z", endsAt: "2027-02-06T09:30:00.000Z",
      venueName: "Learning Hall Annex", venueAddress: "2 Knowledge Road", arrivalInstructions: "Use the east entrance."
    }
  }));
  assert.equal(updatedSession.session.venueName, "Learning Hall Annex");
  assert.equal(updatedSession.session.startsAt, "2027-02-06T01:30:00.000Z");
  const imageItem = (await upload("journey-cover.png", "journey image", "image/png", "Journey cover")).item;
  const documentItem = (await upload("journey-guide.pdf", "%PDF journey guide", "application/pdf", "Journey guide")).item;
  const audioItem = (await upload("journey-audio.mp3", "journey audio", "audio/mpeg", "Journey audio")).item;
  const videoItem = (await upload("journey-video.mp4", "journey video", "video/mp4", "Journey video")).item;
  await json(await api(`/api/creator/content-library/items/${encodeURIComponent(imageItem.id)}/attachments`, {
    method: "POST",
    body: { entityType: "course", entityId: unpricedCourseId, role: "cover", position: 1 }
  }));
  const courseWithCover = await json(await api(`/api/tutor/courses/${encodeURIComponent(unpricedCourseId)}/studio`));
  assert.ok(courseWithCover.course.cover_asset_id);

  const questions = [{
    id: "journey-question-1",
    prompt: "Which answer completes this product journey?",
    options: ["The verified answer", "An unverified answer"],
    correctIndex: 0,
    explanation: "The verified answer completes the journey.",
    mediaLibraryItemId: imageItem.id,
    mediaAltText: "A visual marker for the verified answer.",
    mediaCaption: "Question illustration"
  }];
  const incompleteDraft = await json(await api("/api/creator/learning-products", {
    method: "POST",
    body: {
      title: "Resumable stepper draft",
      description: "A private draft saved before the creator adds the learning content.",
      subject: "Journey testing",
      audience: "All learners",
      productType: "reading",
      estimatedMinutes: 10,
      status: "draft",
      metadataOnly: true
    }
  }), 201);
  assert.equal(incompleteDraft.product.status, "draft");
  const prematurePublish = await api(`/api/creator/learning-products/${encodeURIComponent(incompleteDraft.product.id)}/publish`, {
    method: "POST", body: {}
  });
  assert.equal(prematurePublish.status, 409);
  assert.equal((await prematurePublish.json()).error.code, "product_content_required");
  await json(await api(`/api/creator/learning-products/${encodeURIComponent(incompleteDraft.product.id)}`, { method: "DELETE" }));

  const productMatrix = [
    { type: "ebook", source: { primaryLibraryItemId: documentItem.id } },
    { type: "reading", source: { contentUrl: "https://example.test/journey-reading" } },
    { type: "video", source: { primaryLibraryItemId: videoItem.id } },
    { type: "audio", source: { primaryLibraryItemId: audioItem.id } },
    { type: "quiz", assessment: true },
    { type: "test", assessment: true },
    { type: "mock_exam", assessment: true }
  ];

  for (const entry of productMatrix) {
    const payload = {
      title: `Journey ${entry.type.replaceAll("_", " ")}`,
      description: `A complete creator and learner journey for the ${entry.type} product.`,
      subject: "Journey testing",
      audience: "All learners",
      productType: entry.type,
      estimatedMinutes: 10,
      status: "draft",
      ...(entry.source ?? {}),
      ...(entry.assessment ? { questions, passingScore: 60, timeLimitMinutes: 15 } : {})
    };
    const created = await json(await api("/api/creator/learning-products", {
      method: "POST", body: payload
    }), 201);
    assert.equal(created.product.status, "draft");

    const updatedPayload = { ...payload, title: `${payload.title} edited`, metadataOnly: false };
    const updated = await json(await api(`/api/creator/learning-products/${encodeURIComponent(created.product.id)}`, {
      method: "PATCH", body: updatedPayload
    }));
    assert.equal(updated.product.status, "draft");

    const published = await json(await api(`/api/creator/learning-products/${encodeURIComponent(created.product.id)}/publish`, {
      method: "POST", body: {}
    }));
    assert.equal(published.product.status, "published");
    const detail = await json(await api(`/api/learning-products/${encodeURIComponent(created.product.slug)}`));
    assert.equal(detail.product.has_access, true);
    if (entry.assessment) {
      assert.equal(detail.product.questions.length, 1);
      assert.equal(detail.product.questions[0].media.mediaType, "image");
      const attempt = await json(await api(`/api/learning-products/${encodeURIComponent(created.product.slug)}/attempts`, {
        method: "POST", body: { answers: [0] }
      }));
      assert.equal(attempt.result.scorePercent, 100);
      assert.equal(attempt.result.passed, true);
    } else {
      const saved = await json(await api(`/api/learning-products/${encodeURIComponent(created.product.slug)}/progress`, {
        method: "PATCH",
        body: { status: "completed", progressPercent: 100, positionSeconds: 60, durationSeconds: 60, secondsSpent: 60, activityType: "completed" }
      }));
      assert.equal(saved.status, "completed");
    }
    const unpublished = await json(await api(`/api/creator/learning-products/${encodeURIComponent(created.product.id)}/unpublish`, {
      method: "POST", body: {}
    }));
    assert.equal(unpublished.product.listingStatus, "unpublished");
    const republished = await json(await api(`/api/creator/learning-products/${encodeURIComponent(created.product.id)}/republish`, {
      method: "POST", body: {}
    }));
    assert.equal(republished.product.listingStatus, "listed");
    const copied = await json(await api(`/api/creator/learning-products/${encodeURIComponent(created.product.id)}/copy`, {
      method: "POST", body: {}
    }), 201);
    assert.equal(copied.product.contentVersion, 2);
    await json(await api(`/api/creator/learning-products/${encodeURIComponent(copied.product.id)}`, {
      method: "DELETE"
    }));
    publishedProducts.push({ id: created.product.id, slug: created.product.slug, type: entry.type, assessment: Boolean(entry.assessment) });
  }

  const ebookDraft = await json(await api("/api/creator/ebooks", {
    method: "POST",
    body: {
      title: "Native journey ebook",
      subtitle: "A complete chapter workflow",
      description: "A native ebook used to verify the authoring and reader journey.",
      subject: "Journey testing",
      audience: "All learners"
    }
  }), 201);
  const chapter = await json(await api(`/api/creator/ebooks/${encodeURIComponent(ebookDraft.ebook.id)}/chapters`, {
    method: "POST",
    body: { title: "First chapter", content: "The first paragraph.\n\nThe second paragraph." }
  }), 201);
  await json(await api(`/api/creator/ebook-chapters/${encodeURIComponent(chapter.chapter.id)}`, {
    method: "PATCH",
    body: { title: "First chapter edited", content: "The edited first paragraph.\n\nThe edited second paragraph." }
  }));
  const nativePublished = await json(await api(`/api/creator/ebooks/${encodeURIComponent(ebookDraft.ebook.id)}/publish`, {
    method: "POST", body: {}
  }));
  assert.equal(nativePublished.ebook.status, "published");
  const reader = await json(await api(`/api/ebooks/${encodeURIComponent(ebookDraft.ebook.id)}`, { headers: {} }));
  assert.equal(reader.chapters.length, 1);
  const nativeCopy = await json(await api(`/api/creator/ebooks/${encodeURIComponent(ebookDraft.ebook.id)}/copy`, {
    method: "POST", body: {}
  }), 201);
  assert.equal(nativeCopy.ebook.contentVersion, 2);

  const creatorOfferCatalogue = await json(await api("/api/creator/product-offers"));
  const bundleCourse = creatorOfferCatalogue.courseOfferings.find((offering) => offering.course_id === "course-maths-5")
    ?? creatorOfferCatalogue.courseOfferings[0];
  assert.ok(bundleCourse, "A published course offering should be available for bundling");
  const courseBundle = await json(await api("/api/creator/product-offers", {
    method: "POST",
    body: {
      title: "Course and ebook journey bundle",
      description: "A course sold together with an independently authored learning product.",
      priceCents: 12900,
      currency: "SGD",
      productIds: [publishedProducts[0].id],
      courseOfferingIds: [bundleCourse.id]
    }
  }), 201);
  assert.equal(courseBundle.offer.product_count, 2);
  assert.equal(courseBundle.offer.courseItems.length, 1);
  const courseRelatedOffers = await json(await api(`/api/creator/product-offers?courseId=${encodeURIComponent(bundleCourse.course_id)}`));
  assert.ok(courseRelatedOffers.offers.some((offer) => offer.id === courseBundle.offer.id));
  const publicOffers = await json(await api("/api/offers", { headers: {} }));
  assert.ok(publicOffers.offers.some((offer) => offer.offerKind === "course"), "The public marketplace should expose priced course offers");
  const publicCourseOffer = publicOffers.offers.find((offer) => offer.offerKind === "course");
  assert.ok(Array.isArray(publicCourseOffer.topics) && publicCourseOffer.topics.length > 0, "Public offers should expose searchable topics");
  assert.ok(Array.isArray(publicCourseOffer.includedTitles) && publicCourseOffer.includedTitles.length > 0, "Public offers should preview included titles");
  const searchedOffers = await json(await api(`/api/offers?q=${encodeURIComponent(publicCourseOffer.includedTitles[0])}`, { headers: {} }));
  assert.ok(searchedOffers.offers.some((offer) => offer.id === publicCourseOffer.id), "Search should match titles inside an offer");
  const availableOffers = await json(await api("/api/offers?availability=available&sort=price_low", { headers: {} }));
  assert.ok(availableOffers.offers.every((offer) => offer.availability === "available"));
  assert.deepEqual(availableOffers.offers.map((offer) => offer.priceCents), availableOffers.offers.map((offer) => offer.priceCents).toSorted((left, right) => left - right));
  assert.ok(!publicOffers.offers.some((offer) => offer.id === courseBundle.offer.id), "Draft bundles must stay out of the public marketplace");

  await stopWorker(worker);
  worker = null;

  const entitlementSql = publishedProducts.map((product, index) =>
    `INSERT INTO learning_product_entitlements (id,learning_product_id,user_id,status,granted_at) VALUES ('journey-entitlement-${index}','${product.id}','journey-learner','active',datetime('now'));`
  ).join("");
  await run([
    "d1", "execute", "DB", "--local", "--persist-to", state, "--config", config,
    "--command",
    `${entitlementSql}INSERT INTO enrolments (id,order_id,course_id,student_user_id,status,enrolled_at) VALUES ('journey-enrolment','journey-payout-order','course-maths-5','journey-learner','active',datetime('now'));INSERT INTO enrolment_offerings (id,order_id,enrolment_id,course_offering_id,student_user_id,status,enrolled_at) VALUES ('journey-enrolment-offering','journey-payout-order','journey-enrolment','offering-course-maths-5','journey-learner','active',datetime('now'));`
  ]);

  worker = await startWorker();
  const checkoutConfirmation = await json(await api("/api/checkout/status?sessionId=cs_journey_payout", { headers: learnerHeaders }));
  assert.equal(checkoutConfirmation.status, "confirmed");
  assert.equal(checkoutConfirmation.courseId, "course-maths-5");
  assert.equal(checkoutConfirmation.offeringId, "offering-course-maths-5");
  const myLearning = await json(await api("/api/my-learning-products", { headers: learnerHeaders }));
  assert.equal(myLearning.products.length, publishedProducts.length);
  for (const product of publishedProducts) {
    const detail = await json(await api(`/api/learning-products/${encodeURIComponent(product.slug)}`, { headers: learnerHeaders }));
    assert.equal(detail.product.has_access, true);
    if (product.assessment) {
      const attempt = await json(await api(`/api/learning-products/${encodeURIComponent(product.slug)}/attempts`, {
        method: "POST", headers: learnerHeaders, body: { answers: [0] }
      }));
      assert.equal(attempt.result.passed, true);
    } else {
      await json(await api(`/api/learning-products/${encodeURIComponent(product.slug)}/progress`, {
        method: "PATCH",
        headers: learnerHeaders,
        body: { status: "in_progress", progressPercent: 50, positionSeconds: 30, durationSeconds: 60, secondsSpent: 30, activityType: "progressed" }
      }));
      const progress = await json(await api(`/api/learning-products/${encodeURIComponent(product.slug)}/progress`, { headers: learnerHeaders }));
      assert.equal(progress.progress.progress_percent, 50);
    }
  }

  const courseLearning = await json(await api("/api/learning/courses/course-maths-5", { headers: learnerHeaders }));
  assert.equal(courseLearning.course.id, "course-maths-5");
  assert.ok(courseLearning.modules.length > 0);
  assert.ok(courseLearning.assessments.some((assessment) => assessment.assessment_type === "quiz"));
  const assessment = await json(await api("/api/assessments/assessment-maths-quiz", { headers: learnerHeaders }));
  assert.equal(assessment.assessment.assessment_type, "quiz");
  const started = await json(await api("/api/assessments/assessment-maths-quiz/attempts", {
    method: "POST", headers: learnerHeaders, body: {}
  }), 201);
  await json(await api(`/api/assessment-attempts/${encodeURIComponent(started.attempt.id)}/responses/question-quiz-1`, {
    method: "PUT", headers: learnerHeaders, body: { selectedOptionId: "option-quiz-1-b" }
  }));
  const submitted = await json(await api(`/api/assessment-attempts/${encodeURIComponent(started.attempt.id)}/submit`, {
    method: "POST", headers: learnerHeaders, body: {}
  }));
  assert.equal(submitted.result.passed, true);

  process.stdout.write("Product journeys passed: 3 course formats, audio book, uploaded and native ebooks, reading, video, quiz, test and mock exam.\n");
} finally {
  await stopWorker(worker);
  await removeState();
}
