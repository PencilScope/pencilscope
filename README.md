# PencilScope

PencilScope is a child-friendly online tuition marketplace for Singapore primary-school learners. This repository contains the first Astro + Cloudflare implementation foundation.

## Included

- Astro server-rendered application targeting Cloudflare Workers
- Public landing page, course catalogue and course details
- D1 migration for the initial learning and commerce domains
- Stripe Checkout and signature-verified, idempotent webhook processing
- Automatic Stripe Product and Price creation when a course is published
- Versioned course pricing that preserves the Stripe Price used by each order
- Resend email service boundary
- Private API Worker connected to the Astro web Worker with a Service Binding
- API-owned R2, Queue, D1, Stripe and Resend bindings
- Health endpoint at `/api/health`
- Parent and tutor registration with session-backed sign-in
- Parent-managed learner profiles and role-aware dashboards
- Stripe payment-to-enrolment entitlement assignment
- Protected course modules, lessons and progress tracking
- A shared quiz, test and mock-exam engine with automatic choice grading
- Spaced-repetition flashcard review
- Tutor studio for courses, modules, lessons, assessments and flashcards

## Local setup

Requirements: Node.js 22.12 or newer and pnpm.

1. Install dependencies with `pnpm install`.
2. Copy `.dev.vars.example` to `.dev.vars` and add test credentials.
3. Apply the local migration with `pnpm db:migrate:local`.
4. Start the API Worker with `pnpm api:dev`.
5. In a second terminal, start the Astro web Worker with `pnpm dev`.

The catalogue renders sample content before D1 is initialised. Publishing a course from the tutor studio creates its Stripe Product and one-time Price. Checkout requires migrated D1 data, Stripe test credentials and an approved tutor account.

## Cloudflare environments

The repository has two isolated named Cloudflare environments. Each environment contains a public Astro web Worker and a private API Worker:

| Git branch | Public web Worker | Private API Worker | D1 | R2 | Queue |
| --- | --- | --- | --- | --- | --- |
| `uat` | `pencilscope-uat` | `pencilscope-api-uat` | `pencilscope-db-uat` | `pencilscope-media-uat` | `pencilscope-jobs-uat` |
| `production` | `pencilscope-production` | `pencilscope-api-production` | `pencilscope-db-production` | `pencilscope-media-production` | `pencilscope-jobs-production` |

The web Worker owns assets, Astro sessions and the `API` service binding. The API Worker exclusively owns D1, R2, Queue, Stripe and Resend. Public `/api/*` requests enter through the web origin and are forwarded privately; the API Workers have `workers_dev` disabled.

Use `pnpm db:migrate:uat` and `pnpm deploy:uat` for UAT. Use `pnpm db:migrate:production` and `pnpm deploy:production` for production. Deployment always publishes the API first and then builds and publishes the web Worker.

Store secrets separately in each environment; never commit them:

```powershell
pnpm exec wrangler secret put STRIPE_SECRET_KEY --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put RESEND_API_KEY --config workers/api/wrangler.jsonc --env uat
pnpm exec wrangler secret put EMAIL_FROM --config workers/api/wrangler.jsonc --env uat

pnpm exec wrangler secret put STRIPE_SECRET_KEY --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put RESEND_API_KEY --config workers/api/wrangler.jsonc --env production
pnpm exec wrangler secret put EMAIL_FROM --config workers/api/wrangler.jsonc --env production
```

Configure separate Stripe webhook endpoints for:

- `https://pencilscope-uat.rdproducts-adm1.workers.dev/api/webhooks/stripe`
- `https://pencilscope-production.rdproducts-adm1.workers.dev/api/webhooks/stripe`

## Learning journeys

### Parent and student

1. A parent registers, signs in and creates one or more learner profiles.
2. The parent chooses a learner on a course page and completes Stripe Checkout.
3. The verified Stripe webhook records the order and activates that learner's enrolment.
4. The dashboard links to the protected course player, which records lesson progress.
5. Quizzes, tests and mock exams share the same versioned attempt and response model.
6. Flashcard confidence ratings schedule each learner's next review.

Student accounts can use the same learning endpoints directly. Parent access to progress, assessments and flashcards is limited to linked learner profiles.

### Tutor

New tutor registrations are pending until `tutor_profiles.verification_status` is changed to `approved` by an administrator. Approved tutors use `/tutor` to create draft courses and add:

- ordered modules and lessons;
- quizzes, tests and mock exams with choice questions;
- flashcard decks and cards.

Assessments and decks must contain content before they can be published. Course publication provisions Stripe pricing automatically.

### Tutor course pricing API

All tutor endpoints require an authenticated approved tutor (or admin) session.

- `POST /api/tutor/courses` creates a draft. Send `publish: true` to create its Stripe Product and first one-time Price immediately.
- `POST /api/tutor/courses/:id/publish` publishes an existing draft and provisions its Stripe pricing.
- `PATCH /api/tutor/courses/:id/pricing` creates a new versioned Stripe Price for a published course and archives the previous Price.

Stripe creation calls use stable idempotency keys. A failed sync leaves the course unpublished with `pricing_status = 'failed'`, allowing a safe retry. Drafts do not create Stripe resources until publication.

## Remaining production work

The implemented journeys are an MVP. Before a public launch, add an administrator approval console, password reset and email verification, tutor review/moderation, manual grading for written responses, certificates, live-class provider integration, notification emails and a full automated browser test suite.
