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
