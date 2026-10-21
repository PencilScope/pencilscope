import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = resolve(root, `.chrome-browser-e2e-${process.pid}`);
const chrome = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const debugOrigin = "http://127.0.0.1:9225";
const site = process.env.BROWSER_SITE ?? "http://127.0.0.1:4321";
const billingSite = process.env.BROWSER_BILLING_SITE ?? "http://127.0.0.1:8788";
const adminSite = process.env.BROWSER_ADMIN_SITE ?? "http://127.0.0.1:8789";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const issues = [];
if (!profile.startsWith(root + "\\") && !profile.startsWith(root + "/")) {
  throw new Error("Refusing to use a Chrome profile outside the repository");
}
await rm(profile, { recursive: true, force: true });

const browser = spawn(chrome, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  "--no-first-run", "--no-default-browser-check", "--disable-crash-reporter", "--disable-breakpad",
  "--disable-extensions", "--remote-debugging-port=9225", "--user-data-dir=" + profile, "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let browserErrors = "";
browser.stderr.on("data", (chunk) => { browserErrors += chunk; });
async function waitForDebug() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (browser.exitCode !== null) throw new Error("Chrome exited early:\n" + browserErrors);
    try {
      const tabs = await (await fetch(debugOrigin + "/json/list")).json();
      const page = tabs.find((tab) => tab.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools:\n" + browserErrors);
}

const socket = new WebSocket(await waitForDebug());
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener("error", rejectOpen, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const call = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) call.reject(new Error(JSON.stringify(message.error)));
  else call.resolve(message.result);
});
const command = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve: resolveCall, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await command("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const waitUntil = async (expression, label) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for " + label);
};
const viewSettled = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate("!document.querySelector('#content')?.innerText.includes('Loading')")) return true;
    await delay(100);
  }
  return false;
};
const navigate = async (url) => {
  await command("Page.navigate", { url });
  await waitUntil("document.readyState === 'complete'", url);
};
const bodyText = () => evaluate("document.body?.innerText || ''");
const assertHealthyPage = async (label) => {
  const state = await evaluate("({title:document.title,text:document.body?.innerText||'',href:location.href})");
  assert.ok(state.title, label + ": missing title");
  assert.ok(!/Internal Server Error|Application error|Cannot read properties/i.test(state.text), label + ": " + state.text);
  return state;
};
const login = async (email, password) => {
  await navigate(site + "/sign-in");
  assert.ok(await evaluate("Boolean(document.querySelector('.cf-turnstile'))"), "sign-in is missing Turnstile");
  await waitUntil("Boolean(document.querySelector('[name=\"cf-turnstile-response\"]')?.value)", "Turnstile verification");
  const expression = "(() => {const form=document.querySelector('form[action=\"/api/auth/login\"]');" +
    "form.elements.email.value=" + JSON.stringify(email) + ";" +
    "form.elements.password.value=" + JSON.stringify(password) + ";" +
    "form.requestSubmit();return true})()";
  await evaluate(expression);
  await waitUntil("!location.pathname.startsWith('/sign-in')", "sign-in redirect");
  await waitUntil("document.readyState === 'complete'", "signed-in page");
  if (await evaluate("location.pathname === '/onboarding'")) {
    await evaluate("document.querySelector('a.text-link:last-of-type')?.click()");
    await waitUntil("location.pathname === '/dashboard'", "onboarding skip");
  }
};

try {
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Network.enable");
  await navigate(site + "/");
  const home = await assertHealthyPage("landing page");
  if (!/Knowledge Platform for everyone/i.test(home.text)) {
    issues.push('Landing page is missing the approved "Knowledge Platform for everyone" heading.');
  }
  assert.match(home.text, /experts|experience/i);
  assert.match(await evaluate("document.querySelector('meta[property=\"og:title\"]')?.content || ''"), /Knowledge Shared by Experts/i, "Homepage Open Graph title is missing the tagline");
  assert.match(await evaluate("document.querySelector('meta[property=\"og:image\"]')?.content || ''"), /\/social-card-knowledge\.png$/, "Homepage Open Graph image is not the cache-busted branded PNG");
  assert.equal(await evaluate("document.querySelector('meta[property=\"og:image:width\"]')?.content"), "1200", "Homepage social image width is missing");
  assert.equal(await evaluate("document.querySelector('meta[property=\"og:image:height\"]')?.content"), "630", "Homepage social image height is missing");
  assert.equal(await evaluate("document.documentElement.lang"), "en", "Portal should default to English");
  assert.equal(await evaluate("document.querySelectorAll('.language-switcher select[name=\"locale\"] option').length"), 4, "Portal language selector must offer four launch languages");
  assert.ok(await evaluate("Boolean(document.querySelector('a[href^=\"/sign-in\"]'))"));
  assert.ok(await evaluate("Boolean(document.querySelector('[data-contact-open]'))"), "landing page is missing the contact assistant");
  await evaluate("document.querySelector('[data-contact-open]').click()");
  assert.ok(await evaluate("document.querySelector('[data-contact-dialog]').open"), "contact assistant did not open");
  assert.equal(await evaluate("document.querySelector('.cf-turnstile')?.dataset.action"), "contact");
  assert.equal(await evaluate("document.querySelectorAll('[data-contact-step]').length"), 3);
  await navigate(site + "/sign-in");
  await assertHealthyPage("sign-in page");
  assert.equal(await evaluate("document.querySelector('.cf-turnstile')?.dataset.action"), "login");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-contact-open]'))"), false);
  await navigate(site + "/register");
  await assertHealthyPage("registration page");
  assert.equal(await evaluate("document.querySelector('.cf-turnstile')?.dataset.action"), "register");
  for (const route of ["/offers", "/courses", "/library"]) {
    await navigate(site + route);
    const marketplace = await assertHealthyPage("public marketplace " + route);
    assert.match(marketplace.text, /offer|learning/i, route + " is missing offer-first marketplace content");
    assert.equal(await evaluate("[...document.querySelectorAll('.offer-card-link')].every((link)=>link.getAttribute('href')?.startsWith('/offers/'))"), true, route + " contains a product-first enrolment card");
  }
  await navigate(site + "/offers");
  assert.ok(await evaluate("[...document.querySelectorAll('.catalogue-filter-groups strong')].some((item)=>item.textContent.trim()==='Learning type')"), "Catalogue must separate learning type from category");
  assert.ok(await evaluate("[...document.querySelectorAll('.catalogue-filters a')].some((item)=>item.textContent.includes('Single resources'))"), "Catalogue is missing the learner-friendly single-resource type");
  assert.equal(await evaluate("document.querySelector('#offer-search')?.getAttribute('placeholder')"), "Search by topic, skill, format or expert…");
  assert.ok(await evaluate("Boolean(document.querySelector('.catalogue-refine [name=\"topic\"]')) && Boolean(document.querySelector('.catalogue-refine [name=\"language\"]')) && Boolean(document.querySelector('.catalogue-refine [name=\"delivery\"]')) && Boolean(document.querySelector('.catalogue-refine [name=\"availability\"]')) && Boolean(document.querySelector('.catalogue-refine [name=\"sort\"]'))"), "Catalogue is missing refinement controls");
  const firstLearningPack = await evaluate("document.querySelector('.offer-card-link')?.href || ''");
  if (firstLearningPack) {
    await navigate(firstLearningPack);
    await assertHealthyPage("learning pack detail");
    assert.equal(await evaluate("document.querySelectorAll('[data-share-panel] .share-icon').length >= 6"), true, "Learning pack is missing social sharing icons");
    assert.ok(await evaluate("Boolean(document.querySelector('[data-share-panel] .share-whatsapp'))"), "Learning pack is missing WhatsApp sharing");
    assert.ok(await evaluate("Boolean(document.querySelector('[data-share-panel] .share-facebook'))"), "Learning pack is missing Facebook sharing");
    assert.ok(await evaluate("Boolean(document.querySelector('[data-share-panel] .share-linkedin'))"), "Learning pack is missing LinkedIn sharing");
  }
  await evaluate("fetch('/api/preferences/language',{method:'POST',body:new URLSearchParams({locale:'ms',returnTo:'/'})}).then((response)=>response.text())");
  await navigate(site + "/");
  assert.equal(await evaluate("document.documentElement.lang"), "ms", "Selected portal language did not persist");
  assert.match(await bodyText(), /Platform Ilmu untuk semua/i, "Malay landing translation did not render");
  await command("Network.clearBrowserCookies");
  await navigate(site + "/");

  if (process.env.BROWSER_LANDING_ONLY !== "1") {
  await login("browser-learner-20261014@example.com", "BrowserTest!2026");
  assert.equal(await evaluate("location.pathname"), "/dashboard");
  assert.ok(await evaluate("Boolean(document.querySelector('a[href*=\"state=active\"]'))"), "learner overview is missing active-learning drill-down");
  assert.ok(await evaluate("Boolean(document.querySelector('a[href*=\"state=completed\"]'))"), "learner overview is missing completed-learning drill-down");
  for (const route of ["/courses", "/library", "/my-learning", "/my-results", "/payments", "/profile"]) {
    await navigate(site + route);
    const page = await assertHealthyPage("learner " + route);
    assert.ok(!page.href.includes("/sign-in"), "learner was signed out at " + route);
  }
  assert.match(await bodyText(), /profile|account/i);
  await navigate(site + "/admin/billing");
  const denied = await assertHealthyPage("learner billing denial");
  assert.ok(denied.href.includes("/dashboard") || /access|permission|authori[sz]ed/i.test(denied.text));

  await command("Network.clearBrowserCookies");
  await login("browser-creator-20261014@example.com", "BrowserTest!2026");
  assert.equal(await evaluate("location.pathname"), "/dashboard");
  await navigate(site + "/dashboard?workspace=creation&section=content");
  assert.equal(await evaluate("[...document.querySelectorAll('summary')].filter((item)=>item.textContent.includes('+ Create product')).length"), 1, "Creator Studio must show one Create product control");
  assert.ok(await evaluate("Boolean(document.querySelector('[data-ai-creator]'))"), "Creator Studio is missing Connect and create with AI");
  const productDashboardHref = await evaluate("document.querySelector('.content-title-link[href*=\"section=product\"]')?.href || ''");
  assert.ok(productDashboardHref, "Creator Studio product list is missing a product dashboard link");
  await navigate(productDashboardHref);
  assert.ok(await evaluate("[...document.querySelectorAll('.dashboard-context-nav a')].some((link)=>link.textContent.includes('Pricing & Publish'))"), "Selected product left menu is missing Pricing & Publish");
  assert.ok(await evaluate("[...document.querySelectorAll('.dashboard-context-nav a')].some((link)=>link.textContent.includes('Settings'))"), "Selected product left menu is missing Settings");
  assert.equal(await evaluate("document.querySelectorAll('.product-dashboard-tabs').length"), 0, "Selected product still shows duplicate top tabs");
  await navigate(site + "/dashboard?workspace=creation&section=content");
  const standalonePricingHref = await evaluate("document.querySelector('.content-manager-item:not([data-content-type=\"course\"]) .content-title-link')?.href || ''");
  assert.ok(standalonePricingHref, "Creator Studio needs a standalone product for pricing journey coverage");
  await navigate(standalonePricingHref + "&tab=offers");
  assert.equal(await evaluate("document.querySelectorAll('.offer-stepper li').length"), 4, "Pricing & Publish must show four guided steps");
  assert.ok(await evaluate("Boolean(document.querySelector('[data-offer-step-panel=\"1\"]:not([hidden])'))"), "Pricing & Publish must begin with product selection");
  assert.ok(await evaluate("Boolean(document.querySelector('[data-offer-action=\"draft\"]')) && Boolean(document.querySelector('[data-offer-action=\"publish\"]'))"), "Pricing & Publish is missing draft and publish choices");
  await navigate(site + "/dashboard?workspace=creation&section=overview");
  assert.ok(await evaluate("Boolean(document.querySelector('a[href*=\"status=published\"]'))"), "creator overview is missing published drill-down");
  assert.ok(await evaluate("Boolean(document.querySelector('a[href*=\"booked=yes\"]'))"), "creator overview is missing products-with-bookings drill-down");
  for (const route of ["/tutor", "/create", "/content-library", "/payments", "/action-history"]) {
    await navigate(site + route);
    const page = await assertHealthyPage("creator " + route);
    assert.ok(!page.href.includes("/sign-in"), "creator was signed out at " + route);
  }
  await navigate(site + "/dashboard?workspace=creation&section=course-studio");
  assert.ok(await evaluate("Boolean(document.querySelector('#price-enrolment [name=\"priceSGD\"]'))"), "Inline Course Studio is missing creator tuition");
  assert.ok(await evaluate("Boolean(document.querySelector('#price-enrolment [name=\"enrolmentOpensAt\"]'))"), "Inline Course Studio is missing bookings-open date");
  assert.ok(await evaluate("[...document.querySelectorAll('.inline-course-studio>.dashboard-section-heading a')].some((link)=>link.href.includes('section=offerings'))"), "Full-screen pricing link does not open Price & enrolment");
  assert.ok(await evaluate("[...document.querySelectorAll('.inline-course-studio>.dashboard-section-heading a')].some((link)=>link.href.includes('/tutor'))"), "Inline Creator Studio is missing the full-screen workspace action");
  assert.match(await bodyText(), /Learner price calculation/i);
  await navigate(site + "/tutor");
  assert.match(await bodyText(), /Create what you know\. Empower others\./i);
  assert.ok(await evaluate("Boolean(document.querySelector('.creator-breadcrumb'))"), "Creator Studio is missing the Creator Hub breadcrumb");
  assert.ok(await evaluate("Boolean(document.querySelector('.studio-product-list'))"), "Creator Studio is missing the My Products list");
  const courseStudioHref = await evaluate("document.querySelector('.studio-product-list a[href*=\"courseId=\"]')?.href || ''");
  assert.ok(courseStudioHref, "My Products does not include a course workspace link");
  await navigate(courseStudioHref);
  assert.ok(await evaluate("Boolean(document.querySelector('.course-editor-topbar'))"), "Course Studio is missing the standardized product header");
  assert.equal(await evaluate("document.querySelectorAll('.course-editor-progress a').length"), 5, "Course Studio must show five creation stages");
  assert.ok(await evaluate("Boolean(document.querySelector('.course-editor-identity .studio-status'))"), "Course Studio header is missing product status");
  assert.ok(await evaluate("Boolean(document.querySelector('.studio-products-back'))"), "Selected course is missing the My Products return action");
  assert.ok(await evaluate("Boolean(document.querySelector('.studio-bottom-actions'))"), "Selected course is missing standardized bottom actions");
  assert.ok(await evaluate("Boolean(document.querySelector('button[data-next-section=\"curriculum\"]'))"), "Course details are missing Save draft and continue");
  assert.ok(await evaluate("Boolean(document.querySelector('[name=\"enrolmentOpensAt\"]'))"), "Course Studio is missing bookings-open date");
  assert.ok(await evaluate("Boolean(document.querySelector('[name=\"enrolmentClosesAt\"]'))"), "Course Studio is missing bookings-close date");
  assert.ok(await evaluate("Boolean(document.querySelector('[name=\"accessEndsAt\"]'))"), "Course Studio is missing access-end date");
  await navigate(site + "/create");
  assert.match(await bodyText(), /Connect and create with AI/i);
  assert.equal(await evaluate("document.querySelectorAll('[data-step-item]').length"), 4, "Product creation must show four guided steps");
  assert.equal(await evaluate("document.querySelectorAll('input[name=\"productType\"]').length"), 7, "Product creation must offer all seven standalone formats");
  assert.ok(await evaluate("Boolean(document.querySelector('[data-step-panel=\"1\"]:not([hidden])'))"), "Product creation must begin at the format step");
  assert.ok(await evaluate("Boolean(document.querySelector('[data-pricing-next]'))"), "Product creation is missing the separate pricing continuation");
  assert.equal(await evaluate("document.querySelectorAll('.product-step-panel input[name=\"priceDollars\"]').length"), 0, "Product creation must not include pricing");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].filter((button)=>button.textContent.includes('Publish now')).length"), 0, "Product creation must not require direct publication");
  await evaluate("document.querySelector('[data-step-next]').click()");
  assert.ok(await evaluate("Boolean(document.querySelector('[data-step-panel=\"2\"]:not([hidden])'))"), "Product creation cannot continue to details");
  assert.ok(await evaluate("Boolean(document.querySelector('[data-save-exit]'))"), "Product stepper is missing Save and exit");
  await navigate(site + "/content-library");
  assert.match(await bodyText(), /5 GB|storage/i);
  await navigate(site + "/payments");
  assert.match(await bodyText(), /payout|payment/i);

  await command("Network.clearBrowserCookies");
  await command("Network.setExtraHTTPHeaders", { headers: { "x-pencilscope-admin-email": "finance@e2e.invalid" } });
  await navigate(billingSite + "/");
  assert.match(await bodyText(), /PencilScope · Billing/i);
  for (const view of ["overview", "orders", "subscriptions", "settlements", "disputes", "meeting-usage"]) {
    await evaluate("document.querySelector('[data-view=\"" + view + "\"]').click()");
    if (!await viewSettled()) {
      issues.push("Billing " + view + " remains stuck on Loading.");
      continue;
    }
    assert.ok(!/Access denied|Not found/i.test(await bodyText()), "billing " + view + " failed");
  }

  await command("Network.setExtraHTTPHeaders", { headers: { "x-pencilscope-admin-email": "system-admin@e2e.invalid" } });
  await navigate(adminSite + "/");
  assert.match(await bodyText(), /System administration/i);
  for (const view of ["overview", "activity", "users", "notifications", "courses", "orders", "settlements", "disputes", "sessions", "audit", "health"]) {
    await evaluate("document.querySelector('[data-view=\"" + view + "\"]').click()");
    if (!await viewSettled()) {
      issues.push("System administration " + view + " remains stuck on Loading.");
      continue;
    }
    assert.ok(!/Access denied|Not found/i.test(await bodyText()), "admin " + view + " failed");
  }
  await evaluate("document.querySelector('[data-view=\"notifications\"]').click()");
  await waitUntil("Boolean(document.querySelector('#notification-composer'))", "notification composer");
  assert.ok(await evaluate("Boolean(document.querySelector('#notification-composer button[type=\"submit\"]'))"));
  }
  if (issues.length) {
    throw new Error("Browser journey defects:\n- " + issues.join("\n- "));
  }
  process.stdout.write(process.env.BROWSER_LANDING_ONLY === "1"
    ? "Browser public pages passed: landing contact assistant, sign-in and registration render with Turnstile protection.\n"
    : "Browser journeys passed: public landing, learner sign-in and protected pages, creator tools, billing dashboard tabs, and system-admin dashboards.\n");
} finally {
  try { socket.close(); } catch {}
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(browser.pid), "/t", "/f"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    await once(killer, "exit");
  } else if (browser.exitCode === null) {
    browser.kill();
  }
  if (browser.exitCode === null) await Promise.race([once(browser, "exit"), delay(5_000)]);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error?.code !== "EBUSY") throw error;
      if (attempt === 39) {
        process.stderr.write(`Browser profile cleanup deferred because a Chromium file is still locked: ${profile}\n`);
        break;
      }
      await delay(500);
    }
  }
}
