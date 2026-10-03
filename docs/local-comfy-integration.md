# Local ComfyUI integration

The optional sidecar preserves BeefTV's script editor, canvas, character/scene/
prop library, providers, custom channels and declarative plugins. It adds a
separate `/local-comfy` workspace and one canvas link. No existing channel is
replaced. The API prefix is `/api/local-comfy/v1`.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| BeefTV | Script editing, canvas/director references, project and asset UI, original cloud channels |
| Comfy adapter | Registered local projects/shots, fixed recipe bindings, durable jobs, archived generation assets |
| ComfyUI | Execute an approved API workflow on the existing model installation |
| OpenMontage | Director planning, production manifests, generation routing and delivery orchestration |
| video_workbench | Launch/observe/recover OpenMontage work, retain historical production data |

The sidecar project/asset registry is a separate persistent ledger. A matching
BeefTV project ID records a relationship; it does not establish that the
upstream project, script or resource database was updated. UI import into the
BeefTV resource store is an explicit operation and must report its own result.

## Channels and workflows

BeefTV providers map unified image/video/audio requests to external APIs. Custom
channels use the existing backend relay. Declarative plugins preserve provider
specific authentication, payload mappings, polling and temporary result URLs.
Examples include OpenAI video, Gemini Veo, MiniMax, Seedance, Novita and the
AutoDL ComfyUI plugin. The AutoDL plugin uses its hosted workflow ID API,
Authorization token and public media URLs; it is not the native ComfyUI API.

This adapter sends an entire approved node graph to native `/prompt`, polls
`/history/{prompt_id}` and `/queue`, uploads references through `/upload/image`,
and archives completed output bytes from `/view`. It does not call a paid cloud
fallback. Workflow bindings specify actual node IDs and input fields. Qwen and
H3 are separate recipes; a four-step H3 graph must contain its verified LoRA,
sampler and guider, not merely a changed `steps` value.

## Configuration and validation

Real service URLs, workflow JSONs, personal paths, generated files and logs
belong under ignored `.local/` or persistent deployment directories. Public
examples contain placeholders. Generation is disabled by default and the
adapter does not start or reconfigure ComfyUI. The API client skill reads local
configuration and requires an explicit generation option.

Tests use local mock ComfyUI responses. A mock success establishes request,
state and archive behavior, not image quality or real model execution. A
successful health/read-only query establishes connectivity only. Record live
generation evidence separately when GPU resources have been coordinated.

Deployment and update procedures are maintained in `deploy/spark/`. The source
branch remains based on the pinned upstream commit; updating source, building
images and upgrading persistent databases are separate reviewable operations.

## Read-only recipe and model directories

The local Comfy workspace has three directory sources: registered Comfy
recipes (`comfy.recipes`), RunningHub's official standard-endpoint snapshot
(`rh.standard`) and its public LLM directory (`rh.llm`). Directory GET requests
read the cache; an explicit refresh reads only the selected source. The two
RunningHub sources use fixed anonymous public GETs without keys or cookies.
Comfy recipe refresh inspects registered node classes, without submitting a
GPU job or automatically registering every installed checkpoint.

The standard catalog first uses its fixed
[official raw file](https://raw.githubusercontent.com/HM-RunningHub/OpenClaw_RH_Skills/main/runninghub/data/capabilities.json).
Only a network/read error or HTTP 5xx permits one attempt at the fixed
[GitHub REST Contents URL for the same file](https://api.github.com/repos/HM-RunningHub/OpenClaw_RH_Skills/contents/runninghub/data/capabilities.json?ref=main),
with `Accept: application/vnd.github.raw+json` and
`User-Agent: BeefTV-read-only-catalog`. HTTP 4xx, redirect, response-size or JSON/schema
failures do not select this fallback. Each GET retains a 15-second timeout and
5 MiB response limit; a standard catalog refresh makes at most two GETs. The
LLM directory retains its single fixed URL. No client URL, key, cookie or proxy
environment is used, and system proxy, environment and TLS settings are not
changed.

In this read-only check, Spark's raw request encountered a connection reset
(error 104). The anonymous REST read returned HTTP 200 and 754082 bytes,
parsed as 420 entries at version `2026-08-18`. The Web LLM directory showed 80
entries with a fresh cache. These observations establish public directory
reads, not a connected account or callable models. Deployment of the new
reader and its Web refresh require separate acceptance.

The static checker recognizes the observed V3 node schemas: an empty
`min:0` autogrow input may be omitted, supported single-select `COMBO` values
are checked, and selected dynamic-combo branches are expanded into fields.
Unknown or incomplete schemas remain unavailable for verification. The three
registered Qwen-Image 2.1, H3 I2V and 512 preview recipes passed static checks
in this round; that does not establish `gpuVerified` or real generation.

Discovery and static checks do not establish account access, billing
authorization or successful generation. Directory rows do not populate native
cloud model selectors or take over unified generation dispatch. Registered
recipes have a separate local workflow default configuration described below.
Community AI apps, workflow-ID import and weight/resource listings are separate
capabilities.
See [Channel connection options](channel-connection-options.md) for the three
non-secret connection fields, public text-provider presets and directory
boundaries; the adapter's detailed API remains in
[CONTRACT.md](../tools/comfy_adapter/CONTRACT.md).

## Local workflow defaults and entry points

The settings panel reads the instance's actual `/recipes` response and stores
separate image/video `{recipeId, seed}` values in `config.localComfyDefaults`.
Only registered recipes are offered; Qwen-Image 2.1, H3 I2V and the 512 preview
appear when registered on that instance. Missing, mismatched or unready saved
recipes stay visible and require correction. There is no automatic fallback
to another recipe or cloud channel. Seeds are integers from 0 to 4294967295;
static readiness does not establish a successful GPU execution.

These non-secret defaults use the existing model configuration repository,
including a workspace with no cloud channels. Save and return wait for that
repository's persistence result; failures retain the draft for retry. Saving
does not require a cloud API Key and does not enable generation.

Image/video nodes and the creation page provide a separate local workflow
entry. Mode and available project/node/shot IDs travel in the query; prompt and
reference asset IDs travel in router state. The workspace loads the saved
recipe and seed for that mode. Users must select or register the local project
and shot, review the prompt and select or upload the actual reference images.
Source asset IDs alone do not copy images into the sidecar.

Opening the workspace does not submit `/prompt`. Generation remains a manual
workspace action governed by the existing generation switch, recipe/reference
validation, deduplication and queue checks. The current deployment keeps
generation disabled. The original cloud model enums, protocols and TaskCenter
dispatch remain separate. Local image/video defaults do not configure image
recognition, TTS or automatic review; Ref2VA video/audio references remain
unsupported.
