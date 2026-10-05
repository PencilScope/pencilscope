# PencilScope

PencilScope is an open learning marketplace for recorded courses, live online learning and in-person training. It supports academic and enrichment courses, professional and personal development, masterclasses, workshops, seminars and community knowledge sharing.

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
- Parent and creator registration with session-backed sign-in
- Parent-managed learner profiles and role-aware dashboards
- Stripe payment-to-enrolment entitlement assignment
- Protected course modules, lessons and progress tracking
- A shared quiz, test and mock-exam engine with automatic choice grading
- Spaced-repetition flashcard review
- Creator studio available to every active account
- Configurable course categories and creator memberships
- Self-paced, cohort, event and academic-term offerings with independent Stripe prices
- Recorded lessons, live online sessions, in-person venues, attendance and capacity
- Offering-specific modules, materials, quizzes, tests, mock exams and flashcards

## Local setup

Requirements: Node.js 22.12 or newer and pnpm.

1. Install dependencies with `pnpm install`.
2. Copy `.dev.vars.example` to `.dev.vars` and add test credentials.
3. Apply the local migration with `pnpm db:migrate:local`.
4. Start the API Worker with `pnpm api:dev`.
5. In a second terminal, start the Astro web Worker with `pnpm dev`.

The catalogue renders sample content before D1 is initialised. Publishing a paid offering from the creator studio creates or reuses the course's Stripe Product and creates an immutable one-time Price for that offering. Checkout requires migrated D1 data and Stripe test credentials.

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

### Creator

Every active account can use `/tutor` (the current creator-studio URL) to create a course. A creator can add:

- self-paced, cohort, event and academic-term offerings;
- recorded, live online and in-person lessons;
- scheduled online sessions, venues and capacity limits;
- ordered modules, materials and lessons;
- quizzes, tests and mock exams with choice questions;
- flashcard decks and cards.

Academic term details are required only for an `academic_term` offering. Each published offering has its own price and entitlement. Assessments and decks must contain content before they can be published.

### Creator pricing API

Creator endpoints require an active authenticated account that owns the course. The `/api/tutor/*` path is retained for backward compatibility while the user interface calls it the Creator Studio.

- `POST /api/tutor/courses` creates a draft. Send `publish: true` to create its Stripe Product and first one-time Price immediately.
- `POST /api/tutor/courses/:id/publish` publishes an existing draft and provisions its Stripe pricing.
- `PATCH /api/tutor/courses/:id/pricing` creates a new versioned Stripe Price for a published course and archives the previous Price.
- `POST /api/tutor/courses/:id/offerings` creates a bookable course offering.
- `POST /api/tutor/offerings/:id/publish` publishes an offering and provisions its Stripe Price.
- `POST /api/tutor/offerings/:id/sessions` schedules a live online or in-person session.

Stripe creation calls use stable idempotency keys. A failed sync leaves the course unpublished with `pricing_status = 'failed'`, allowing a safe retry. Drafts do not create Stripe resources until publication.

## Remaining production work

The implemented journeys are an MVP. Before a public marketplace launch, add creator identity and course moderation, Stripe Connect payouts, password reset and email verification, refunds and cancellation policies, manual grading, certificates, calendar/meeting-provider integration, reminder emails and a full automated browser test suite.
