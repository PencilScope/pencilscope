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

## Cloudflare environments

The repository has two isolated named Cloudflare environments:

| Git branch | Worker | D1 | R2 | Queue |
| --- | --- | --- | --- | --- |
| `uat` | `pencilscope-uat` | `pencilscope-db-uat` | `pencilscope-media-uat` | `pencilscope-jobs-uat` |
| `production` | `pencilscope-production` | `pencilscope-db-production` | `pencilscope-media-production` | `pencilscope-jobs-production` |

Use `pnpm db:migrate:uat` and `pnpm deploy:uat` for UAT. Use `pnpm db:migrate:production` and `pnpm deploy:production` for production. The build commands select the matching Wrangler environment before Astro generates its deployment manifest.

Store secrets separately in each environment; never commit them:

```powershell
pnpm exec wrangler secret put STRIPE_SECRET_KEY --env uat
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env uat
pnpm exec wrangler secret put RESEND_API_KEY --env uat
pnpm exec wrangler secret put EMAIL_FROM --env uat

pnpm exec wrangler secret put STRIPE_SECRET_KEY --env production
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env production
pnpm exec wrangler secret put RESEND_API_KEY --env production
pnpm exec wrangler secret put EMAIL_FROM --env production
```

Configure separate Stripe webhook endpoints for:

- `https://pencilscope-uat.rdproducts-adm1.workers.dev/api/webhooks/stripe`
- `https://pencilscope-production.rdproducts-adm1.workers.dev/api/webhooks/stripe`

## Current boundary

### Tutor course pricing API

All tutor endpoints require an authenticated approved tutor (or admin) session.

- `POST /api/tutor/courses` creates a draft. Send `publish: true` to create its Stripe Product and first one-time Price immediately.
- `POST /api/tutor/courses/:id/publish` publishes an existing draft and provisions its Stripe pricing.
- `PATCH /api/tutor/courses/:id/pricing` creates a new versioned Stripe Price for a published course and archives the previous Price.

Stripe creation calls use stable idempotency keys. A failed sync leaves the course unpublished with `pricing_status = 'failed'`, allowing a safe retry. Drafts do not create Stripe resources until publication.

This is the implementation foundation, not a production-ready release. Parent/student linking, tutor authoring UI, enrolment assignment after checkout, assessments, live-class integration and the admin console are subsequent milestones.
