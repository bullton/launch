# Launch Tracker · Public API

Real-time global rocket launch data, served from a local SQLite cache that
refreshes every 30 minutes from [Launch Library 2](https://thespacedevs.com).

---

## Base URL

```
https://launch.choice-hongkong.com/api/ll
```

All endpoints are `GET` unless otherwise noted. CORS is enabled (`*`).

---

## Health check

```
GET /health
```

```json
{
  "ok": true,
  "lastRefresh": "2026-10-15T12:48:55.151Z",
  "totalRows": 84,
  "serverTime": "2026-10-15T12:50:01.000Z"
}
```

---

## Next launch · 下一发

The single closest upcoming launch (full summary).

```
GET /next
```

### Response

```json
{
  "id": "df88cfbf-f504-4e11-8370-e33dd6280b5b",
  "slug": "falcon-9-block-5-ussf-481",
  "name": "Falcon 9 Block 5 | USSF-481",
  "url": "https://ll.thespacedevs.com/2.2.0/launch/df88cfbf-...",
  "image": "https://thespacedevs-prod.nyc3.digitaloceanspaces.com/.../falcon_9_liftof_image_...jpg",
  "status": { "id": 1, "name": "Go for Launch", "abbrev": "Go" },
  "net": "2026-10-15T23:57:05Z",
  "net_precision": "SEC",
  "window_start": "2026-10-15T23:44:00Z",
  "window_end":   "2026-10-16T03:44:00Z",
  "probability": null,
  "rocket": {
    "name": "Falcon 9 Block 5",
    "family": "Falcon",
    "variant": "Block 5",
    "manufacturer": "SpaceX"
  },
  "payload": {
    "name": "USSF-481",
    "type": "Government/Top Secret",
    "orbit": "Polar Orbit",
    "orbit_abbrev": "PO",
    "description": "A classified mission for the United States Space Force...",
    "customers": ["United States Space Force"]
  },
  "location": {
    "country_code": "USA",
    "country_name": "United States",
    "site": "Vandenberg SFB, CA, USA",
    "pad":  "Space Launch Complex 4E",
    "region": "America/Los_Angeles",
    "latitude":  "34.632",
    "longitude": "-120.611"
  },
  "operator": "SpaceX",
  "countdown": {
    "server_time":        "2026-10-15T12:50:01.000Z",
    "remaining_ms":       40024000,
    "remaining_seconds":  40024,
    "is_future":          true
  },
  "last_updated": "2026-10-15T11:07:53Z"
}
```

### Field reference

| Field | Type | Description |
|---|---|---|
| `id` | string | UUID, stable identifier |
| `slug` | string | URL slug (`falcon-9-block-5-ussf-481`) |
| `name` | string | Display name (`Rocket \| Mission`) |
| `url` | string | Original source URL on thespacedevs.com |
| `image` | string \| null | Hero image URL |
| `status` | object | `{ id, name, abbrev }` — see status IDs below |
| `net` | string (ISO 8601) | No Earlier Than — planned liftoff time (UTC) |
| `net_precision` | string | `SEC` / `MIN` / `HR` / `DAY` |
| `window_start` | string \| null | Launch window open (UTC) |
| `window_end`   | string \| null | Launch window close (UTC) |
| `probability` | int \| null | Go-for-launch probability (0–100) |
| `rocket.name` | string | Full configuration name |
| `rocket.family` | string | Family (e.g. `Falcon`) |
| `rocket.variant` | string | Variant (e.g. `Block 5`) |
| `rocket.manufacturer` | string | Manufacturer name |
| `payload.name` | string | Mission name |
| `payload.type` | string | Mission type (e.g. `Government/Top Secret`) |
| `payload.orbit` | string | Target orbit name |
| `payload.orbit_abbrev` | string | Target orbit abbreviation |
| `payload.description` | string | Mission description |
| `payload.customers` | string[] | Customer agencies |
| `location.country_code` | string | ISO 3166-1 alpha-3 (e.g. `USA`, `CHN`, `RUS`) |
| `location.country_name` | string | English country name |
| `location.site` | string | Launch site / base name |
| `location.pad`  | string | Specific pad name |
| `location.region` | string | IANA timezone |
| `location.latitude` | string | Decimal degrees |
| `location.longitude` | string | Decimal degrees |
| `operator` | string | Launch service provider name |
| `countdown.server_time` | string (ISO 8601) | Server clock at calculation — use this, not your local clock |
| `countdown.remaining_ms` | int | Milliseconds until `net` (negative if past) |
| `countdown.remaining_seconds` | int | Seconds until `net` (negative if past) |
| `countdown.is_future` | bool | `true` if launch is in the future |
| `last_updated` | string (ISO 8601) | When source data was last changed upstream |

### Status IDs

| id | name | abbrev |
|---|---|---|
| 1 | Go for Launch | Go |
| 2 | To Be Determined | TBD |
| 3 | Launch Success | Success |
| 4 | Launch Failure | Failure |
| 5 | Hold | Hold |
| 6 | In Flight | In Flight |
| 7 | Partial Failure | Partial Failure |
| 8 | To Be Confirmed | TBC |

---

## Latest launch · 最近已发射

The most recent past launch (full summary, same shape as `/next`).

```
GET /latest
```

---

## Upcoming list · 即将发射列表

```
GET /upcoming?limit=10
```

| Query | Type | Default | Max |
|---|---|---|---|
| `limit` | int | 10 | 60 |

```json
{
  "count": 2,
  "results": [
    { "id": "...", "name": "Falcon 9 Block 5 | USSF-481", "rocket": { "name": "Falcon 9 Block 5" }, "...": "..." },
    { "id": "...", "name": "Falcon 9 Block 5 | Bandwagon 5",  "rocket": { "name": "Falcon 9 Block 5" }, "...": "..." }
  ]
}
```

Each item has the same shape as the `/next` response.

---

## Past list · 历史发射列表

```
GET /past?limit=10
```

| Query | Type | Default | Max |
|---|---|---|---|
| `limit` | int | 10 | 60 |

Same response shape as `/upcoming`.

---

## Launch by id · 单条查询

```
GET /launch/:id
```

`:id` is either the UUID (`id`) or the URL slug.

```bash
curl https://launch.choice-hongkong.com/api/ll/launch/falcon-9-block-5-ussf-481
```

Returns the **full** upstream launch record (not the summary) — every field
including `rocket.launcher_stage`, `mission.agencies`, `timeline`, `updates`,
`vidURLs`, `infoURLs`, `program`, etc. The full schema is documented at
[ll.thespacedevs.com](https://ll.thespacedevs.com/swagger).

---

## Errors

All errors return JSON with an `error` field.

| Status | Body | When |
|---|---|---|
| 404 | `{ "error": "no upcoming launch" }` | DB has no upcoming rows (very rare) |
| 404 | `{ "error": "not found" }` | `/launch/:id` — id/slug not in cache |
| 500 | `{ "error": "corrupt data" }` | Cached JSON is unparseable |
| 502 | `{ "error": "refresh failed" }` | Upstream refresh endpoint failed |

---

## Rate limits

None enforced by this server. The underlying data source
(ll.thespacedevs.com) refreshes internally every 30 minutes, so polling more
often than that is wasted.

---

## Examples

### cURL

```bash
# next launch
curl https://launch.choice-hongkong.com/api/ll/next | jq

# top 3 upcoming
curl 'https://launch.choice-hongkong.com/api/ll/upcoming?limit=3' | jq '.results[].name'
```

### JavaScript (browser / Node 18+)

```js
const r = await fetch('https://launch.choice-hongkong.com/api/ll/next');
const l = await r.json();
console.log(`${l.name} — T-${Math.floor(l.countdown.remaining_seconds / 60)}m`);
// → "Falcon 9 Block 5 | USSF-481 — T-667m"
```

### Live countdown (browser)

```js
async function tick() {
  const r = await fetch('https://launch.choice-hongkong.com/api/ll/next');
  const l = await r.json();
  if (!l.countdown.is_future) return console.log('launched');
  const s = Math.max(0, l.countdown.remaining_seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  console.log(`T-${d}d ${h}h ${m}m ${sec}s`);
}
setInterval(tick, 1000);
```

### Python

```python
import requests
r = requests.get('https://launch.choice-hongkong.com/api/ll/next', timeout=5).json()
print(f"{r['name']} from {r['location']['site']} ({r['location']['country_name']})")
```

---

## Data freshness

- Cache refresh interval: **30 minutes**
- Manual refresh: `POST /refresh` (returns the updated cache payload)
- `last_updated` in each launch = upstream update time, not cache time
- `countdown.server_time` always reflects the current server clock
