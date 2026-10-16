/// <reference path="../.astro/types.d.ts" />

type AppEnvironment = {
  ASSETS: Fetcher;
  API: Fetcher;
  APP_URL: string;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID?: string;
  FACEBOOK_APP_ID?: string;
  FACEBOOK_GRAPH_VERSION?: string;
  MCP_SERVER_URL: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
};

declare namespace App {
  interface Locals {
    cfContext: ExecutionContext;
  }
}
