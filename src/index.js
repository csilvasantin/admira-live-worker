/**
 * admira-live-worker
 * Bridge entre admira.live (público, sin auth) y yarig.ai (CodeIgniter, auth con email+password).
 *
 * Service account fijo en secrets (YARIG_EMAIL / YARIG_PASSWORD). El worker:
 *   1. Hace login contra yarig.ai cuando hace falta y mantiene la cookie cisession.
 *   2. Llama endpoints JSON de Yarig en nombre del visitante anónimo.
 *   3. Devuelve JSON al frontend con CORS restringido a admira.live.
 *   4. Cachea respuestas ~10s para deduplicar tráfico concurrente (Apache 2.2 + PHP 5.3 de Yarig).
 */

const YARIG_BASE = "https://yarig.ai";
const LOGIN_PATH = "/registration/login";
const DASHBOARD_PATH = "/tasks";

const ALLOWED_ORIGINS = new Set([
  "https://admira.live",
  "https://www.admira.live",
  "https://csilvasantin.github.io",
  "http://localhost:8080",
  "http://localhost:5173",
  "http://localhost:8814",
  "http://localhost:8815",
  "http://127.0.0.1:8080",
]);

const ENDPOINTS = {
  ranking: "/productivity/json_get_team_by_order_or_rank",
  tasksToday: "/tasks/json_get_current_day_tasks_and_journey_info",
  score: "/score/json_user_score",
  notifications: "/system_notification/json_get_user_notifications",
  userDays: "/personal/json_get_user_days",
  scoring: "/personal/json_get_scoring",
  companyTasks: "/tasks/json_get_newer_company_tasks",
};

// ---------------------------------------------------------------------------
// YarigClient — singleton por isolate. Maneja login, cookie cisession y reintentos.
// ---------------------------------------------------------------------------

let clientInstance = null;
let loginPromise = null;

function getClient(env) {
  if (!clientInstance) clientInstance = new YarigClient(env.YARIG_EMAIL, env.YARIG_PASSWORD);
  return clientInstance;
}

class YarigClient {
  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.cookie = null;
    this.loggedIn = false;
    this.lastLoginAt = 0;
  }

  /**
   * Garantiza que tenemos sesión válida. Deduplica logins concurrentes con un promise lock.
   */
  async ensureLogin() {
    if (this.loggedIn) return true;
    if (!loginPromise) {
      loginPromise = this.login().finally(() => {
        loginPromise = null;
      });
    }
    return loginPromise;
  }

  /**
   * Flujo de login portado de src/yarig.py:
   *   1. GET /registration/login para sembrar cisession inicial
   *   2. POST /registration/login con email + password + submit=Entrar
   *   3. Si la URL final contiene /tasks → login OK
   */
  async login() {
    if (!this.email || !this.password) {
      throw new Error("YARIG_EMAIL / YARIG_PASSWORD no configurados");
    }

    // 1. Seed cisession
    const seedRes = await this._raw(YARIG_BASE + LOGIN_PATH, { method: "GET" });
    this._absorbCookies(seedRes);

    // 2. Submit credentials, sigue redirecciones manualmente para mantener cookie
    const body = new URLSearchParams({
      email: this.email,
      password: this.password,
      submit: "Entrar",
    });

    const { response, finalUrl } = await this._followRedirects(YARIG_BASE + LOGIN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const url = new URL(finalUrl);
    if (response.status === 200 && url.pathname.startsWith(DASHBOARD_PATH)) {
      this.loggedIn = true;
      this.lastLoginAt = Date.now();
      return true;
    }

    this.loggedIn = false;
    throw new Error(`Yarig login fallido (status=${response.status}, url=${finalUrl})`);
  }

  /**
   * Llamada autenticada a un endpoint JSON de Yarig.
   * Si la respuesta redirige a /registration/login (sesión expirada), re-login y reintenta una vez.
   */
  async requestJson(path, { method = "POST", form } = {}) {
    await this.ensureLogin();

    const tryOnce = async () => {
      const init = { method };
      if (form) {
        init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
        init.body = new URLSearchParams(form);
      }
      return this._followRedirects(YARIG_BASE + path, init);
    };

    let { response, finalUrl } = await tryOnce();

    // Sesión expirada → Yarig redirige a login. Detectamos por URL final.
    if (new URL(finalUrl).pathname.startsWith(LOGIN_PATH)) {
      this.loggedIn = false;
      await this.ensureLogin();
      ({ response, finalUrl } = await tryOnce());
    }

    if (response.status !== 200) {
      throw new Error(`Yarig ${path} → status ${response.status}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      // Algunos endpoints devuelven un int crudo (ej. /score/json_user_score)
      const n = Number(text.trim());
      if (!Number.isNaN(n)) return n;
      throw new Error(`Yarig ${path} → respuesta no-JSON: ${text.slice(0, 80)}`);
    }
  }

  // ---- internos ----------------------------------------------------------

  _absorbCookies(res) {
    // En Workers, getSetCookie() devuelve array de Set-Cookie crudos.
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of raw) {
      const m = /^cisession=([^;]+)/i.exec(sc);
      if (m) this.cookie = `cisession=${m[1]}`;
    }
  }

  _raw(url, init = {}) {
    const headers = new Headers(init.headers || {});
    if (this.cookie) headers.set("Cookie", this.cookie);
    headers.set("User-Agent", "admira-live-worker/0.1 (+https://admira.live)");
    return fetch(url, { ...init, headers, redirect: "manual" });
  }

  /**
   * Sigue redirecciones manualmente reenviando la cookie cisession actualizada en cada salto.
   * Necesario porque fetch() de Workers no propaga cookies a través de redirects.
   * Devuelve { response, finalUrl }.
   */
  async _followRedirects(url, init, maxHops = 5) {
    let current = url;
    let currentInit = init;
    for (let i = 0; i < maxHops; i++) {
      const res = await this._raw(current, currentInit);
      this._absorbCookies(res);

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { response: res, finalUrl: current };
        current = new URL(loc, current).toString();
        currentInit = { method: "GET" };
        continue;
      }

      return { response: res, finalUrl: current };
    }
    throw new Error(`Demasiadas redirecciones desde ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = {
  "/api/health": handleHealth,
  "/api/team/ranking": (req, env) => handleProxy(req, env, ENDPOINTS.ranking),
  "/api/tasks/today": (req, env) => handleProxy(req, env, ENDPOINTS.tasksToday),
  "/api/score/total": (req, env) => handleProxy(req, env, ENDPOINTS.score),
  "/api/wall": (req, env) => handleProxy(req, env, ENDPOINTS.notifications),
  "/api/company/tasks": (req, env) => handleProxy(req, env, ENDPOINTS.companyTasks),
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const handler = ROUTES[url.pathname];
    if (!handler) {
      return json({ error: "not_found", path: url.pathname }, 404, request);
    }

    try {
      // Micro-cache 10s para deduplicar peticiones concurrentes
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      let cached = await cache.match(cacheKey);
      if (cached && request.method === "GET") {
        return withCors(cached, request);
      }

      const res = await handler(request, env);
      const cacheable = res.status === 200 && request.method === "GET";
      if (cacheable) {
        const toCache = res.clone();
        toCache.headers.set("Cache-Control", "public, max-age=10");
        ctx.waitUntil(cache.put(cacheKey, toCache));
      }
      return withCors(res, request);
    } catch (err) {
      return json({ error: "upstream_failed", message: String(err?.message || err) }, 502, request);
    }
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleHealth(request, env) {
  const client = getClient(env);
  const hasCreds = Boolean(env.YARIG_EMAIL && env.YARIG_PASSWORD);
  return json(
    {
      ok: true,
      service: "admira-live-worker",
      version: "0.1.0",
      creds_configured: hasCreds,
      yarig_logged_in: client.loggedIn,
      last_login_at: client.lastLoginAt || null,
      timestamp: new Date().toISOString(),
    },
    200,
    request,
  );
}

async function handleProxy(request, env, yarigPath) {
  const client = getClient(env);
  const data = await client.requestJson(yarigPath, { method: "POST" });
  return json({ ok: true, source: yarigPath, data, fetched_at: new Date().toISOString() }, 200, request);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://admira.live";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function withCors(res, request) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function json(payload, status, request) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) },
  });
}
