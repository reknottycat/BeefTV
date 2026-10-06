# Production asset catalog: first-phase contract

Status: source contract and API adapter implemented; catalog UI and browser preview
pending the dependency/preview approval. Upstream baseline is
`db82831593544314f454c519e098c19aa6b1d0e9`.

## Data boundary

The independent `asset_bridge` reads the registered project files in place. Its
SQLite, journal and thumbnail cache are separate from production source files.
It neither imports the upstream Go runtime nor registers media as owned BeefTV
Resources. Existing historical footage software remains an independent source.

All business calls use `services/api/production-asset-index.ts` and the existing
`http` envelope adapter. Actual routes are under `/api/asset-index/v1`:

| Method | Route | Response |
| --- | --- | --- |
| GET | `/projects` | Project collection, count scope, states, scan health |
| GET | `/assets` | Filtered offset page, revision and source health |
| GET | `/assets/{id}` | Logical asset UUID, versions, locations and evidence |
| GET | `/shots/{native_id}` | Recorded shot/unit, related assets and coverage label |
| GET/HEAD | `/media/{location_id}` | Allowlisted indexed media, Range support |
| GET | `/thumbnail/{location_id}` | Image or cached CPU video thumbnail |

No frontend endpoint creates, edits, uploads, deletes, approves, retries or submits
generation jobs. Remote DGX locations remain recorded evidence until an explicitly
authorized resolver is added. This first adapter does not poll ComfyUI.

## User journeys

The first page is an asset browser with Chinese search, kind and conflict filters,
media cards, version count and explicit count scope. Search and filters persist in
the URL together with page size and page. Detail links preserve the return URL.

The detail page shows the original preview, logical ID, each version, content hash
state, physical locations, availability, source receipts and five independent
quality dimensions. A shot/unit detail additionally lists recorded references,
prompt/workflow files, provider request IDs and outputs. Unrecorded links are
reported as unknown; they are not guessed from neighboring filenames.

## Observable states

| Trigger | Pending | Success | Failure / recovery |
| --- | --- | --- | --- |
| Open list | Stable labeled loading region | Finite result page and total | Inline connection error with Retry |
| Change search | Keep readable prior page, cancel superseded request | Reset page and show matching result count | Preserve query and previous results with freshness warning |
| Clear search | Immediate clear, return focus to input | Unfiltered first page | Same retry behavior |
| Open detail | Stable media/evidence region | Asset or shot evidence | Resource-not-found with return-to-list link |
| Play media | Native player loading state | Same-origin indexed media | Missing/offline/changed-file explanation; other evidence remains visible |
| Background refresh | Preserve controls and scroll | Refresh source observations | Keep last successful snapshot, show degraded source health |

Search must respect IME composition, use a 300ms debounce, and submit immediately
on Enter. Detail navigation moves focus to the page title. Buttons, links and
select popups retain visible keyboard focus. The active locale is `zh-CN`.

## Identity and quality invariants

Logical UUIDs are persisted aliases, separate from mutable physical paths. File
fallback identities are observational until an authoritative native asset ID is
available. Versions and content blobs are separate; a shared SHA can identify
content used by distinct logical assets. Manifest-declared hashes do not establish
local verification. Stable small JSON reads are hashed; large media is not copied
or comprehensively rehashed by the scanner.

Review changes preserve history. Removed source records and earlier versions are
retained with explicit historical states. A replaced or changed media path cannot
serve the bytes of its earlier version. Partial/invalid JSON retains the previous
successful source snapshot and produces a scan error.

Generation completion, technical QA, visual review, user acceptance and location
availability are independent. A source disagreement remains visible. A technical
PASS does not accept a candidate; old V1/V2 rejection must remain bound to the
identified candidate content and not spread to unrelated future versions.

## Preview and verification

Use an isolated frontend entry with only the shared theme, Ant provider, Query
provider and catalog routes. Bind preview and sidecar to loopback, check existing
ports first, and proxy only the asset-index API. Do not run the upstream Go startup
or Wails scripts. Keep upstream license notices in the checkout.

Acceptance requires API fixture tests, real-project read-only evidence samples,
typecheck/build, strict design audit and a real Windows browser. Test loading,
failure, no-results, pagination, back/refresh restoration, keyboard, Chinese IME,
narrow layout, long paths, conflict display and media seeking. An API status check
alone does not establish that the page or player works.
