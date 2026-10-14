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
};

declare namespace App {
  interface Locals {
    cfContext: ExecutionContext;
  }
}
