/**
 * The core server that runs on a Cloudflare worker.
 */

import { Router } from "itty-router";
import { AuthErrorResponse, InternalError } from "./src/errors";
import v2Router from "./src/router";
import { authenticationMethodFromEnv } from "./src/authentication-method";
import { Registry } from "./src/registry/registry";
import { R2Registry } from "./src/registry/r2";
import { adminHandler } from "./src/admin";

// A full compatibility mode means that the r2 registry will try its best to
// help the client on the layer push. See how we let the client push layers with chunked uploads for more information.
type PushCompatibilityMode = "full" | "none";

export interface Env {
  REGISTRY: R2Bucket;
  ENVIRONMENT: string;
  JWT_REGISTRY_TOKENS_PUBLIC_KEY?: string;
  USERNAME?: string;
  PASSWORD?: string;
  READONLY_USERNAME?: string;
  READONLY_PASSWORD?: string;
  PUSH_COMPATIBILITY_MODE?: PushCompatibilityMode;
  REGISTRIES_JSON?: string; // should be in the format of RegistryConfiguration[];
  REGISTRY_CLIENT: Registry;
  // Set to "true" to allow anonymous pull requests (GET/HEAD) without credentials.
  ALLOW_ANONYMOUS_PULL?: string;
  // D1 database for access stats (hot resources / stale cleanup).
  STATS?: D1Database;
}

const router = Router();

// Admin dashboard. Auth is handled below for all routes, so /admin requires
// valid credentials (anonymous pull whitelist does not include /admin).
router.get("/admin", () => adminHandler());

/**
 * V2 Api
 */
router.all("/v2/*", v2Router.fetch);

router.all("*", () => new Response("Not Found.", { status: 404 }));

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext) {
    if (!ensureConfig(env)) {
      return new AuthErrorResponse(request);
    }

    const authMethod = await authenticationMethodFromEnv(env);
    if (!authMethod) {
      return new AuthErrorResponse(request);
    }

    const credentials = await authMethod.checkCredentials(request);
    if (!credentials.verified) {
      if (!isAnonymousPullAllowed(env, request)) {
        console.warn(`Not Authorized. authmode=${authMethod.authmode}. verified=false`);
        return new AuthErrorResponse(request);
      }
    }

    env.REGISTRY_CLIENT = new R2Registry(env);
    try {
      // Dispatch the request to the appropriate route
      const res = await router.fetch(request, env, context);
      return res;
    } catch (err) {
      if (err instanceof Response) {
        console.warn(`${request.method} ${err.status} ${err.url}`);
        return err;
      }

      // Unexpected error
      if (err instanceof Error) {
        console.error(
          "An error has been thrown by the router:\n",
          `${err.name}: ${err.message}: ${err.cause}: ${err.stack}`,
        );
        return new InternalError();
      }

      console.error(
        "An error has been thrown and is neither a Response or an Error, JSON.stringify() =",
        JSON.stringify(err),
      );
      return new InternalError();
    }
  },
} satisfies ExportedHandler<Env>;

const ensureConfig = (env: Env): boolean => {
  if (!env.REGISTRY) {
    console.error(
      "env.REGISTRY is not setup. Please setup an R2 bucket and add the binding in your wrangler config file. Try 'npx wrangler --env production r2 bucket create r2-registry'",
    );
    return false;
  }

  return true;
};

// Allow anonymous pull requests (GET/HEAD) when ALLOW_ANONYMOUS_PULL is set to "true".
// Write operations (POST/PUT/PATCH/DELETE) still require credentials.
function isAnonymousPullAllowed(env: Env, request: Request): boolean {
  if (env.ALLOW_ANONYMOUS_PULL !== "true") {
    return false;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // Version check
  if (path === "/v2" || path === "/v2/") {
    return true;
  }

  // Pull endpoints
  if (path.includes("/blobs/uploads/")) {
    return false;
  }
  if (path.includes("/manifests/") || path.includes("/blobs/") || path.includes("/tags/list")) {
    return true;
  }

  return false;
}
