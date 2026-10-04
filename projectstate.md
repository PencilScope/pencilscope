# PencilScopeAI — Project State

**Project:** Singapore Primary School Tuition & Learning Platform  
**Document:** Project State  
**Version:** 1.0  
**Date:** 2026-10-04  
**Status:** Product definition / architecture baseline

## 1. Product Vision

Build a multi-sided online tuition marketplace and learning platform for Singapore primary-school students. The platform connects students/parents with human tutors and AI tutors, supports paid courses and live online classes, and provides structured learning content, quizzes, tests, progress tracking, and optional course-completion certification.

## 2. Core Actors

- **Student** — discovers courses, subscribes/books, attends classes, studies content, completes quizzes/tests, tracks progress and earns certificates.
- **Parent/Guardian** — manages student accounts, purchases/subscriptions, schedules, payments, and learning visibility.
- **Tutor** — registers or is invited, creates courses, uploads/creates content, schedules live classes, manages students, assessments and pricing.
- **AI Tutor** — provides conversational practice, explanations, guided exercises, revision and adaptive learning within configured course boundaries.
- **Platform Admin** — manages users, tutors, courses, moderation, payments, reports, certificates, configuration and support.
- **Organization/Partner** — optional future actor for schools, tuition centres or education partners.

## 3. Product Scope

### Learning
- Course catalogue and search.
- Academic and conversational-training courses.
- Primary-school subjects and levels.
- Course modules/lessons.
- Video lessons, documents, links and downloadable resources.
- Short-form video courses.
- Quizzes and tests.
- Progress and completion tracking.
- Course completion certificates.
- Configurable certificate templates and eligibility rules.
- Human tutor and AI tutor experiences.

### Live Classes
- Online class scheduling.
- Student booking/enrolment.
- Tutor availability.
- Video conferencing provider integration.
- Class links, reminders and attendance.
- Optional recording integration subject to provider capabilities and consent.
- Group and one-to-one sessions.

### Marketplace
- Tutors can self-register.
- Tutors can be invited by other tutors/admins.
- Tutors publish courses and set prices.
- Students/parents subscribe or purchase courses.
- Platform commission / tutor payout model.
- Refund and cancellation handling.
- Reviews/ratings can be added in a later phase.

### Administration
- Tutor approval and verification.
- Course moderation/publication workflow.
- User management.
- Payment and payout reconciliation.
- Reporting and analytics.
- Audit logs.
- Content and certificate configuration.

## 4. Business Model Baseline

Support multiple monetisation models without hard-coding one:
1. One-time course purchase.
2. Recurring subscription.
3. Course bundle/package.
4. Paid live-class booking.
5. Tutor/platform revenue share.
6. Optional platform subscription for premium features.

The initial implementation should model price, currency, tax, discounts, refunds, platform fee, tutor share and payment status separately.

## 5. Key Product Principles

- Parent/guardian controls are first-class because the target users are children.
- Child accounts should not independently perform unrestricted financial or communication actions.
- Tutor-generated content requires moderation and safeguarding controls.
- AI tutoring must be bounded by age-appropriate policies and course context.
- Learning progress must be measurable and auditable.
- Provider integrations must be replaceable through an abstraction layer.
- Payments and personal data must be handled securely.
- The platform should be multi-tenant-ready even if the first release is marketplace-focused.

## 6. Suggested High-Level Architecture

```text
                    ┌───────────────────────────┐
                    │       Web / Mobile UI     │
                    │ Student / Parent / Tutor │
                    └─────────────┬─────────────┘
                                  │
                         API / Auth Gateway
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       │                          │                          │
  Identity & Roles          Learning Domain             Marketplace
       │                    Courses/Lessons              Pricing
       │                    Assessments                  Orders
       │                    Progress                     Subscriptions
       │                    Certificates                 Payments
       │
       ├───────────────┐
       │               │
  Live Class       AI Tutor
  Service          Service
       │               │
 Video Provider    LLM / AI Provider
       │
       └──────────────────────────────┐
                                      │
                              Notifications
                                      │
                            Email / Push / SMS

          ┌───────────────────────────────────────────┐
          │ Data / Infrastructure                     │
          │ Relational DB | Object Storage | Cache    │
          │ Search | Queue/Event Bus | Analytics      │
          └───────────────────────────────────────────┘
```

## 7. Major Domain Modules

- Identity & access management
- Parent/student relationship management
- Tutor onboarding and verification
- Tutor invitation/referral
- Course catalogue
- Course authoring
- Content management
- Video/content delivery
- Assessment engine
- Learning progress
- Certification
- Live class scheduling
- Video conferencing integration
- Booking/enrolment
- Payments
- Subscriptions
- Tutor payouts
- Notifications
- AI tutoring
- Moderation/safeguarding
- Reporting/analytics
- Administration/audit

## 8. Current Decisions

- The application stack is **Astro deployed on Cloudflare**.
- The Cloudflare baseline uses **Workers**, **D1**, **R2**, **Queues**, CDN/caching and **Turnstile**, with **KV** reserved for non-transactional data.
- Payments and subscriptions use **Stripe**; marketplace tutor payouts should use **Stripe Connect** subject to validation of the Singapore business and account model.
- Transactional email uses **Resend**.
- Courses may be **academic** or **conversational training**.
- Courses may be taught by a **human tutor**, supported by an **AI tutor**, or designed as an **AI-led course**.
- Tutors can **create or upload course contents**.
- Tutors can **publish courses and set prices**.
- Students can **subscribe/book and join online classes**.
- Short video courses, quizzes and tests are supported.
- Completion certification can be enabled and customized.
- Live video conferencing should be integrated through a provider abstraction so the provider can be changed later.
- Architecture should support low-cost operation and gradual scaling.

## 9. MVP Boundary

### Include
- Account/authentication and parent/student relationships.
- Tutor onboarding.
- Course creation and publication.
- Course catalogue.
- Paid enrolment/subscription.
- Content delivery.
- Video lessons.
- Quizzes/tests.
- Progress tracking.
- Basic certificates.
- Live class scheduling and one video provider.
- Notifications.
- Admin console.
- Basic payment and tutor payout workflow.

### Defer
- Advanced adaptive learning.
- Complex recommendation engine.
- Multi-provider video failover.
- Marketplace bidding.
- Extensive social/community features.
- Advanced gamification.
- Sophisticated AI agent orchestration.
- School/tuition-centre enterprise tenancy.
- International expansion.

## 10. Risks / Open Questions

1. Stripe Connect account type, onboarding, payout and platform-liability arrangement for Singapore.
2. Preferred video-conferencing provider and commercial terms.
3. Parent consent and child-safety workflow.
4. Whether tutors require identity verification before publishing.
5. Certificate verification/public URL requirements.
6. Refund/cancellation policy.
7. Whether AI tutor usage is included in course price or metered.
8. Initial target age/Primary levels and subjects.
9. Mobile app requirement versus responsive web MVP.
10. Revenue-share percentages and subscription pricing.

## 11. Next Recommended Build Sequence

1. Finalise requirements and user journeys.
2. Define domain model and API contracts.
3. Implement identity/roles and parent-child relationships.
4. Implement tutor onboarding.
5. Implement course authoring/catalogue.
6. Implement enrolment/payments.
7. Implement content delivery and assessments.
8. Implement progress/certificates.
9. Integrate live classes.
10. Add AI tutor.
11. Add analytics, moderation and production hardening.
