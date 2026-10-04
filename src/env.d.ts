/// <reference path="../.astro/types.d.ts" />

type AppEnvironment = {
  ASSETS: Fetcher;
  API: Fetcher;
  APP_URL: string;
  ENVIRONMENT: string;
};

declare namespace App {
  interface Locals {
    cfContext: ExecutionContext;
  }
}
