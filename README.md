# admira-live-worker

Cloudflare Worker que actúa de puente entre **admira.live** (sitio público) y **yarig.ai** (plataforma operativa, auth con email + password).

## Arquitectura

```
[ navegador del visitante ] --(fetch)--> [ admira-live-worker ] --(login + JSON)--> [ yarig.ai ]
        (sin auth)                       (cisession en memoria,                   (Apache 2.2 + PHP 5.3,
                                          micro-cache 10s)                          CodeIgniter session)
```

- **Service account fijo** en secrets (`YARIG_EMAIL`, `YARIG_PASSWORD`). Un único usuario de Yarig consume el API en nombre de los visitantes anónimos del dashboard.
- **Login on-demand**: el worker hace `GET /registration/login` para sembrar la cookie `cisession`, luego `POST` con credenciales y verifica que la URL final sea `/tasks`.
- **Sesión reutilizada** dentro del isolate. Si Yarig redirige a `/registration/login` (sesión caducada) → re-login automático y reintento único.
- **Micro-cache 10s** (Cache API de Cloudflare) para deduplicar visitas concurrentes y proteger el backend antiguo de Yarig.

## Endpoints

| Ruta | Origen Yarig | Notas |
|---|---|---|
| `GET /api/health` | n/a | Estado del worker (login activo, secrets configurados) |
| `GET /api/team/ranking` | `/productivity/json_get_team_by_order_or_rank` | Ranking de productividad del equipo |
| `GET /api/tasks/today` | `/tasks/json_get_current_day_tasks_and_journey_info` | Tareas + jornada del service account |
| `GET /api/score/total` | `/score/json_user_score` | Puntuación (entero crudo en Yarig) |
| `GET /api/wall` | `/system_notification/json_get_user_notifications` | Muro / notificaciones |
| `GET /api/company/tasks` | `/tasks/json_get_newer_company_tasks` | Tareas recientes de la compañía |

CORS abierto solo para `admira.live`, `www.admira.live` y localhost de desarrollo.

## Desarrollo local

```bash
npm install
cp .dev.vars.example .dev.vars
# editar .dev.vars con creds reales del usuario admira-live-bot
npm run dev
# → http://localhost:8787/api/health
```

## Despliegue

```bash
# 1. Login en Cloudflare la primera vez
npx wrangler login

# 2. Subir secrets (te los pedirá por stdin, no quedan en el repo)
npm run secret:email
npm run secret:password

# 3. Deploy
npm run deploy

# 4. Logs en tiempo real
npm run tail
```

Para servir bajo `api.admira.live`, añadir el dominio a la zona Cloudflare y descomentar el bloque `[[routes]]` en `wrangler.toml`.

## Seguridad

- Las credenciales **nunca** se commitean. Viven solo en secrets de Cloudflare (prod) o `.dev.vars` (local, gitignored).
- Service account con permisos mínimos en Yarig (usuario dedicado `admira-live-bot`, no la cuenta personal).
- CORS allowlist explícito — el worker no responde a orígenes desconocidos.
- Solo lectura: no se exponen endpoints de escritura (crear tareas, fichar, etc.) aunque el cliente los soporte.
