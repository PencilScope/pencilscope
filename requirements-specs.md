# PencilScopeAI — Product Requirements Specification

**Product:** Singapore Primary School Tuition & Learning Platform  
**Document:** Requirements Specification  
**Version:** 1.0  
**Date:** 2026-10-04  
**Status:** Baseline requirements

## 1. Purpose

This specification defines the functional and non-functional requirements for an online tuition marketplace and learning platform serving Singapore primary-school students, parents/guardians, tutors and AI-assisted learning experiences.

## 2. Goals

- Make high-quality tuition and learning content discoverable online.
- Allow tutors to create, price and deliver courses.
- Let students/parents enrol in self-paced and live learning.
- Support human and AI tutoring.
- Measure learning activity and outcomes.
- Provide configurable assessments and certificates.
- Operate economically at MVP scale while allowing future growth.

## 3. User Roles

| Role | Primary capabilities |
|---|---|
| Student | Learn, attend classes, complete assessments, view progress |
| Parent/Guardian | Manage child, purchases, bookings, permissions and progress |
| Tutor | Onboard, create courses, teach, schedule classes, assess students |
| AI Tutor | Deliver configured AI learning interactions |
| Admin | Moderate, manage users/content, payments, reports and settings |

## 4. Functional Requirements

### FR-001 Authentication
The system shall support secure account registration and login for parents, students where appropriate, tutors and administrators.

### FR-002 Parent-Student Accounts
The system shall allow a parent/guardian to create or link student profiles and manage permitted student actions.

### FR-003 Tutor Registration
Tutors shall be able to register themselves.

### FR-004 Tutor Invitation
A tutor or administrator shall be able to invite another tutor using a controlled invitation workflow.

### FR-005 Tutor Verification
Administrators shall be able to review tutor profiles and approve, reject or suspend tutor accounts.

### FR-006 Course Creation
Approved tutors shall be able to create courses with:
- title
- description
- subject/category
- primary level
- learning objectives
- tutor
- delivery mode
- price
- status
- thumbnail/media
- estimated duration

### FR-007 Course Types
The system shall support at least:
- academic courses
- conversational/language-training courses
- self-paced courses
- live tutor-led courses
- AI-supported courses
- hybrid courses

### FR-008 Course Content
Tutors shall be able to create or upload:
- video
- short video
- text
- PDF/document resources
- images
- links
- exercises
- quizzes
- tests

### FR-009 Course Structure
Courses shall support hierarchical organisation such as:
Course → Module → Lesson → Activity/Assessment.

### FR-010 Course Publication
Tutors shall be able to save drafts. Publication shall require configured moderation/approval rules.

### FR-011 Pricing
Tutors/admins shall be able to define supported pricing models, including one-time purchase and recurring subscription.

### FR-012 Catalogue
Students/parents shall be able to browse, search and filter courses by level, subject, tutor, price, delivery mode and other configured attributes.

### FR-013 Enrolment
A student shall be enrolled after successful purchase/subscription and any required eligibility checks.

### FR-014 Access Control
The system shall grant course/content access according to enrolment, subscription status, scheduled booking and configured permissions.

### FR-015 Video Learning
The platform shall provide secure playback of course videos and track lesson completion.

### FR-016 Progress Tracking
The system shall track at minimum:
- course enrolment
- lesson started
- lesson completed
- assessment attempts
- assessment score
- course completion
- live attendance

### FR-017 Quizzes
Tutors shall be able to create quizzes with configurable questions, answers, scoring and attempt rules.

### FR-018 Tests
Tutors shall be able to create tests with configurable pass marks, duration, attempts and scoring.

### FR-019 Assessment Results
Students and authorised parents shall be able to view assessment results.

### FR-020 Completion Rules
Tutors/admins shall be able to configure course completion requirements, such as lesson completion, minimum score or attendance.

### FR-021 Certificates
The system shall issue a certificate when configured completion conditions are satisfied.

### FR-022 Certificate Customisation
Administrators shall be able to configure certificate templates, branding, fields and eligibility rules. Course-specific certificate settings shall be supported where permitted.

### FR-023 Certificate Verification
Certificates should contain a unique identifier and support later verification.

### FR-024 Live Class Scheduling
Tutors shall be able to define class dates, times, duration, capacity and delivery mode.

### FR-025 Booking
Students/parents shall be able to book eligible live classes.

### FR-026 Video Conferencing
The system shall integrate with an external video-conferencing provider through an abstraction layer.

### FR-027 Class Access
Authorised students and tutors shall receive a secure class-join link or provider session reference.

### FR-028 Attendance
The system shall record attendance using provider events where available and/or tutor confirmation.

### FR-029 Notifications
The platform shall send configurable notifications for:
- enrolment
- payment
- booking
- upcoming class
- class changes/cancellation
- assessment result
- course completion
- certificate issuance

### FR-030 Payments
The platform shall support secure payment processing through an external payment provider.

### FR-031 Orders
The system shall record order, payment, refund and payment-status information.

### FR-032 Tutor Revenue
The platform shall calculate tutor earnings according to configurable revenue-share/commission rules.

### FR-033 Payouts
The system shall support tutor payout records and reconciliation.

### FR-034 Refunds
Administrators shall be able to process or record refunds according to configured policies.

### FR-035 AI Tutor
The system shall support an AI tutor experience that can:
- explain course concepts
- answer course-related questions
- conduct conversational practice
- generate guided exercises
- provide formative feedback
- adapt difficulty within configured boundaries

### FR-036 AI Guardrails
AI interactions shall apply age-appropriate safety controls, course/context restrictions and escalation mechanisms.

### FR-037 AI Usage
The platform shall be able to track AI usage for operational, cost and optional billing purposes.

### FR-038 Tutor Content Ownership
The system shall associate content with its owning tutor/organisation and enforce configured permissions.

### FR-039 Moderation
Admins shall be able to review reported or flagged courses/content/users and take moderation actions.

### FR-040 Audit
Sensitive administrative actions, payment actions and major account changes shall be auditable.

### FR-041 Search
The platform shall provide searchable course and tutor metadata.

### FR-042 Reporting
Admins shall be able to view basic metrics for users, enrolments, sales, courses, attendance and learning completion.

## 5. Key User Journeys

### 5.1 Parent purchases a course
1. Parent registers/logs in.
2. Parent creates/selects a student profile.
3. Parent searches the course catalogue.
4. Parent opens a course detail page.
5. Parent reviews tutor, content, price and schedule.
6. Parent completes payment.
7. System confirms enrolment.
8. Student gains access to permitted content.
9. Parent receives confirmation.

### 5.2 Student takes a self-paced course
1. Student opens enrolled course.
2. Student watches lessons.
3. System records progress.
4. Student completes quizzes/tests.
5. System calculates results.
6. Completion conditions are evaluated.
7. Certificate is issued if eligible.

### 5.3 Student joins a live class
1. Student/parent books an available session.
2. System confirms booking.
3. Notification/reminder is sent.
4. Student joins via provider integration.
5. Attendance is recorded.
6. Tutor optionally adds notes.
7. Progress/attendance is updated.

### 5.4 Tutor publishes a course
1. Tutor registers or accepts invitation.
2. Tutor completes profile.
3. Admin verifies tutor if required.
4. Tutor creates course.
5. Tutor adds modules and lessons.
6. Tutor uploads/creates content.
7. Tutor creates assessments.
8. Tutor sets price and completion rules.
9. Tutor submits for publication.
10. Admin/moderation workflow approves it.
11. Course becomes discoverable.

### 5.5 AI tutoring session
1. Student opens an eligible AI tutoring activity.
2. System loads course/lesson context.
3. AI tutor responds within configured guardrails.
4. Interaction may generate questions/exercises.
5. Learning events are recorded.
6. Usage metrics are updated.

## 6. Core Data Model

Primary entities should include:

- User
- Role
- ParentStudentRelationship
- TutorProfile
- TutorInvitation
- Course
- CourseModule
- Lesson
- ContentAsset
- Quiz
- QuizQuestion
- QuizAttempt
- Test
- TestAttempt
- Enrolment
- Subscription
- Booking
- LiveClass
- Attendance
- Payment
- Order
- Refund
- TutorEarning
- Payout
- CertificateTemplate
- Certificate
- ProgressRecord
- AIConversation
- AIUsageRecord
- Notification
- ModerationCase
- AuditLog

## 7. Non-Functional Requirements

### NFR-001 Security
Use secure authentication, authorisation, encryption in transit, secure secret management and least-privilege access.

### NFR-002 Child Safety
The platform shall be designed for child users with parent/guardian controls, appropriate communication boundaries and moderation.

### NFR-003 Privacy
Personal data collection shall be minimised and handled according to applicable Singapore privacy requirements and platform policies.

### NFR-004 Availability
MVP services should target production-grade availability appropriate for a paid education platform, with monitoring and recovery procedures.

### NFR-005 Performance
Normal catalogue and dashboard requests should respond quickly under expected load; media delivery should use CDN/object-storage capabilities where practical.

### NFR-006 Scalability
The architecture shall permit independent scaling of application services, media delivery, AI workloads, queues and database workloads.

### NFR-007 Observability
Production services shall provide structured logs, metrics, error tracking and audit events.

### NFR-008 Maintainability
External providers for payments, video conferencing, email and AI should be behind provider interfaces/adapters.

### NFR-009 Accessibility
Student-facing experiences should target accessible navigation, readable content, keyboard support and appropriate captions/transcripts where available.

### NFR-010 Data Integrity
Payment, enrolment, assessment and certificate records shall use transactional consistency and idempotent processing where relevant.

## 8. API / Integration Requirements

External integration categories:
- Payment provider
- Video-conferencing provider
- Email provider
- Push/SMS provider
- Object storage/CDN
- AI/LLM provider
- Optional analytics/search provider

All integrations should expose internal provider-neutral interfaces.

## 9. Recommended Service Boundaries

For an initial modular monolith:
- Auth & User
- Tutor
- Course & Content
- Assessment
- Learning Progress
- Live Class
- Commerce
- Certificate
- AI Tutor
- Notification
- Admin & Moderation

The system can later extract high-load or independently scaling modules into services.

## 10. Technology Stack Baseline

The initial implementation shall use the following technology stack:

### Application and Hosting
- **Astro** for the responsive web application, server-rendered pages and application routes.
- **Cloudflare Workers** as the primary serverless application runtime.
- **Cloudflare Pages or Workers Assets** for web deployment and static asset delivery, according to the selected Astro deployment adapter.
- **Cloudflare D1** as the initial relational database for transactional application data.
- **Cloudflare R2** for course videos, documents, images, certificate files and other uploaded assets.
- **Cloudflare CDN/caching** for public and authorised content delivery where appropriate.
- **Cloudflare Queues** for asynchronous workflows such as notifications, payment follow-up, media processing and certificate generation.
- **Cloudflare KV** only for cache-like, configuration or other non-transactional data; it shall not be the source of truth for payments, enrolments or assessment records.
- **Cloudflare Turnstile** for bot protection on relevant public forms.

### Commerce
- **Stripe Checkout and/or Stripe Elements** for customer payment collection.
- **Stripe Billing** for recurring subscriptions.
- **Stripe Connect** for tutor onboarding and payouts where the confirmed marketplace and Singapore account model supports it.
- Stripe webhook events shall be signature-verified and processed idempotently before payment, enrolment, refund or subscription state is changed.
- Internal order, payment, refund, platform-fee and tutor-earning records shall remain the platform source of truth rather than relying only on Stripe dashboard data.

### Email
- **Resend** for transactional email delivery.
- Email templates shall cover account verification, invitations, enrolment, receipts, bookings, class reminders, assessment results, completion and certificate issuance.
- Email sending shall be performed asynchronously where practical, with delivery identifiers and failure status recorded for operational support.

### External Provider Boundaries
- Video conferencing and AI/LLM providers remain to be selected.
- Stripe and Resend integrations shall also be implemented behind internal service interfaces so business logic is testable and provider-specific details remain isolated.
- The initial product shall be a responsive web application; native mobile applications are deferred unless later justified.

## 11. Acceptance Criteria for MVP

The MVP is acceptable when:

- A parent can create/manage a student profile.
- A verified tutor can create and submit a course.
- An approved course can appear in the catalogue.
- A parent can purchase/subscribe to a course.
- The student can access course content after successful payment.
- Video lessons can be completed and progress recorded.
- Quizzes and tests can be attempted and scored.
- Completion rules can trigger certificate issuance.
- A tutor can schedule a live class.
- An enrolled student can book/join a live class.
- Attendance can be recorded.
- At least one payment provider and one video provider are integrated.
- Admin can manage tutors, courses, enrolments and payments.
- Core events are logged and monitored.
- Basic safeguarding and parent-control mechanisms are implemented.

## 12. Future Enhancements

- Adaptive learning paths.
- AI-generated practice plans.
- Tutor matching/recommendations.
- Gamification and badges.
- Student discussion/community features with strong moderation.
- School/tuition-centre tenants.
- Multi-language support.
- Mobile native apps.
- Advanced learning analytics.
- Marketplace ratings/reviews.
- Multi-provider video fallback.
- Automated tutor quality scoring.
- Advanced subscription bundles.
