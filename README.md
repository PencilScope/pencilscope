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
- R2, Queue and D1 bindings for local development
- Health endpoint at `/api/health`

## Local setup

Requirements: Node.js 22.12 or newer and pnpm.

1. Install dependencies with `pnpm install`.
2. Copy `.dev.vars.example` to `.dev.vars` and add test credentials.
3. Apply the local migration with `pnpm db:migrate:local`.
4. Start the application with `pnpm dev`.

The catalogue renders sample content before D1 is initialised. Checkout requires migrated D1 data, a Stripe test secret and Stripe price IDs added to course records.

## Cloudflare setup

Create the D1 database, R2 bucket and Queue named in `wrangler.jsonc`, then replace the placeholder D1 `database_id`. Store production secrets with Wrangler rather than committing them: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, and `EMAIL_FROM`.

Configure Stripe to send events to `/api/webhooks/stripe` and set `APP_URL` to the production origin.

## Current boundary

### Tutor course pricing API

All tutor endpoints require an authenticated approved tutor (or admin) session.

- `POST /api/tutor/courses` creates a draft. Send `publish: true` to create its Stripe Product and first one-time Price immediately.
- `POST /api/tutor/courses/:id/publish` publishes an existing draft and provisions its Stripe pricing.
- `PATCH /api/tutor/courses/:id/pricing` creates a new versioned Stripe Price for a published course and archives the previous Price.

Stripe creation calls use stable idempotency keys. A failed sync leaves the course unpublished with `pricing_status = 'failed'`, allowing a safe retry. Drafts do not create Stripe resources until publication.

This is the implementation foundation, not a production-ready release. Parent/student linking, tutor authoring UI, enrolment assignment after checkout, assessments, live-class integration and the admin console are subsequent milestones.
