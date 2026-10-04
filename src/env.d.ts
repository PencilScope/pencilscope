/// <reference path="../.astro/types.d.ts" />

type AppEnvironment = {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA: R2Bucket;
  JOBS: Queue;
  APP_URL: string;
  ENVIRONMENT: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
};

declare namespace App {
  interface Locals {
    cfContext: ExecutionContext;
  }
}
