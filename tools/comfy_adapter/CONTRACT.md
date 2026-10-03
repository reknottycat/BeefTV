# BeefTV 本地 ComfyUI 适配合同

本服务是独立、可选的标准库 sidecar。它保留 BeefTV 原有项目编辑和云渠道，不修改上游数据库。项目、文本剧本、角色／场景／道具参考图、镜头和生成血缘保存于独立 SQLite；`upstream_*_id` 是人工或调用方提供的关联标识，不表示对象已经写入 BeefTV。

项目的 `upstream_project_id` 关联 BeefTV 原生 domain project ID；可选 `canvas_project_id` 独立关联画布项目 ID。两种 ID 不能互相替代。它们仅保存关联元数据，不自动创建或修改 Go 服务中的项目、画布、剧本或镜头。

## 配置与运行

Python 3.10+，仅使用标准库，不安装依赖。状态目录必须显式指定并持久挂载，源码和镜像不能含个人素材、大模型、密钥或真实私网配置。

```sh
python tools/comfy_adapter/server.py --host 127.0.0.1 --port 6007 --state-dir .local/comfy-state
python -m unittest discover -s tools/comfy_adapter -p test_adapter.py -v
```

| 环境变量 | 含义 |
| --- | --- |
| `BEEFTV_COMFY_URL` | 运营者配置的固定 Comfy HTTP(S) origin；不能含账号、查询参数或路径；客户端不能覆盖 |
| `BEEFTV_COMFY_RECIPES` | 私有配方清单的文件路径；配方中的相对路径以清单目录为基准 |
| `BEEFTV_COMFY_ENABLE_GENERATION` | 仅精确值 `1` 开启生成，默认 `0` |
| `BEEFTV_COMFY_STATE_DIR` | 独立持久状态目录；命令行 `--state-dir` 优先 |
| `BEEFTV_COMFY_HOST` / `BEEFTV_COMFY_PORT` | 默认 `127.0.0.1` / `6007`；容器可在内部网络监听，主机端口由部署层控制 |
| `BEEFTV_COMFY_ALLOWED_ORIGINS` | 可选、逗号分隔的精确浏览器 origin；不返回任意 CORS 头，默认只允许同 origin JSON 写请求 |

反向代理将 `/api/local-comfy/v1/` 保留完整路径送到 sidecar。不得将该服务裸露到公网。sidecar 不安装 Comfy、不加载模型、不启动 GPU worker，不读 BeefTV 云渠道凭据。生成前检查共享 `/queue`，遇到正在运行／等待的任务直接拒绝；这个检查不能替代与其他 GPU 服务的资源协调。

### 私有配方清单

以下仅为字段结构示例，真实配方放 Git 忽略的配置目录；工作流必须是已验证的 Comfy API JSON，而非 editor `nodes` 图。服务只修改显式绑定，保留原 steps、sampler、CFG 和模型输入。

```json
{
  "recipes": [
    {
      "id": "confirmed_image_recipe",
      "name": "Confirmed Image Recipe",
      "mode": "t2i",
      "workflow_path": "confirmed-image-api.private.json",
      "bindings": {
        "prompt": { "node": "1", "field": "prompt" },
        "seed": { "node": "2", "field": "seed" },
        "references": [],
        "output_prefix": { "node": "3", "field": "filename_prefix" }
      },
      "output_nodes": ["3"]
    }
  ]
}
```

`references` 是有序 `{node,field:"image"}` 列表。镜头参考图数量必须与槽数完全相等。无参考绑定的配方收到参考图即拒绝；不忽略参考图。媒体加载节点中的固定 image/video/audio/filename 必须有显式绑定；本版本仅支持图片参考，因此含视频或音频输入的配方不能注册。`output_prefix` 可选，绑定后写入安全值 `BeefTV/<job_id>`。`ready` 只表示文件和绑定静态校验成功，不代表模型或 GPU 生成验收通过。

I2V 首帧配方可增加 `reference_constraints:[{"role":"first_frame","width":目标宽,"height":目标高,"mime_types":["image/png"]}]`，数组与 reference 槽逐个对应。本版本以标准库解析 PNG IHDR 校验尺寸，要求源尺寸不小于目标且宽高比完全相同；其他格式在此约束下拒绝，不猜测尺寸。人物身份图应先用于构图成场景首帧，再提交 I2V，不能将灰底人物档案照直接拉伸。约束仅是图像格式与尺寸校验，不识别人脸或验证场景语义。

## HTTP 合同

前缀 `/api/local-comfy/v1`。JSON 写请求必须是 `Content-Type: application/json` 的对象，大小上限 15 MiB。未知字段拒绝。成功 HTTP 200：

```json
{"code":0,"data":{},"msg":"ok","reason":null}
```

失败 HTTP 4xx/5xx 与 `code` 相同，`reason` 是机器可读原因。列表的 `data` 是裸数组。只有 `/assets/{id}/content` 返回原始媒体，不使用 JSON 信封。API 不接受客户端 URL、磁盘路径或任意 Comfy 工作流。

| 方法／路径 | 请求／返回 |
| --- | --- |
| GET `/config` | `{generation_enabled,storage_scope:"sidecar",concurrency:1,max_reference_bytes,recipe_count}`；不返回私有 URL、模型或路径 |
| GET `/health` | `{adapter:"ok",comfy_reachable,queue_running,queue_pending,generation_enabled}`；只读 `/queue`，不可达时 counts 为 null |
| GET `/recipes` | `Recipe[]` |
| GET `/projects` | `Project[]` |
| POST `/projects` | `{name,upstream_project_id?,canvas_project_id?}` → `Project`；canvas ID 为最长 200 字符的字符串，省略或空字符串表示未关联 |
| GET `/projects/{id}` | `Project` |
| POST `/projects/{id}/script` | `{script,format?:"text"}` → `Project`；支持空字符串清空，最大 1 MiB 字符 |
| GET `/assets?project_id=&kind=` | `Asset[]`；筛选器可省略 |
| POST `/assets` | `{project_id,name,kind,mime_type,data_base64,upstream_asset_id?}` → `Asset` |
| GET `/assets/{id}` | `Asset` |
| GET `/assets/{id}/content` | 图片／视频 bytes；带 Content-Length 和 nosniff |
| GET `/shots?project_id=` | `Shot[]` |
| POST `/shots` | `{project_id,name,upstream_shot_id?,reference_asset_ids?:[]}` → `Shot` |
| GET `/shots/{id}` | `Shot` |
| POST `/shots/{id}/references` | `{asset_ids:[]}` → `Shot`；替换完整参考列表，验证同项目和图片类型 |
| GET `/jobs?project_id=&shot_id=` | `Job[]` |
| POST `/jobs` | `{project_id,shot_id,recipe_id,prompt,seed,reference_asset_ids?,request_key}` → `Job`；仅首次 attempt 1 |
| GET `/jobs/{id}` | 已保存的 `Job`；不会隐式请求 Comfy |
| POST `/jobs/{id}/poll` | `{}` → 更新后的 `Job`；查询 `/history/{prompt_id}`，必要时只读 `/queue` |
| POST `/jobs/{id}/archive` | `{}` → 更新后的 `Job`；完整下载结果并登记资产 |
| POST `/jobs/{id}/retry` | `{request_key,prompt?,seed?}` → 新 attempt `Job`；仅 failed/completed 允许，completed 对应显式单镜重做 |

没有取消接口，避免操作共享 Comfy 队列而中断其他任务。停止 UI／CLI 刷新不会取消 Comfy 作业。返回 `Job.status=failed/submission_unknown` 的提交请求仍为 HTTP 200：它表达已持久保存的真实作业结果；调用方必须检查状态，不能将 HTTP 200 当作生成成功。

### DTO

```ts
type Recipe = {id:string; name:string; mode:string; reference_slots:number; ready:boolean;
  reference_constraints?:{role:'first_frame';width:number;height:number;mime_types:['image/png']}[]};
type Project = {
  id:string; name:string; upstream_project_id:string|null; canvas_project_id:string;
  storage_scope:'sidecar'; script:string; script_format:'text'; created_at:string;
};
type Asset = {
  id:string; project_id:string; name:string;
  kind:'character'|'scene'|'prop'|'reference'|'result'; mime_type:string;
  size:number; sha256:string; source:'reference_upload'|'comfy_result';
  upstream_asset_id:string|null; job_id:string|null; shot_id:string|null;
  result_index?:number; width?:number; height?:number; content_url:string; created_at:string;
};
type Shot = {
  id:string; project_id:string; name:string; upstream_shot_id:string|null;
  reference_asset_ids:string[]; created_at:string;
};
type Result = {node_id:string; filename:string; subfolder:string; type:'output'|'temp'};
type Job = {
  id:string; project_id:string; shot_id:string; recipe_id:string; prompt:string; seed:number;
  reference_asset_ids:string[]; request_key:string; attempt:number; parent_job_id:string|null;
  workflow_sha256:string; recipe_sha256:string; output_nodes:string[]; prompt_id:string|null;
  status:'submitting'|'submitted'|'running'|'completed'|'failed'|'submission_unknown';
  error:string|null; results:Result[]; archived_asset_ids:string[];
  created_at:string; updated_at:string; deduplicated?:boolean;
};
```

上传 kind 仅允许 character/scene/prop/reference。PNG/JPEG/WebP 解码后最大 10 MiB，校验文件魔术；不接受 data URL 前缀或视频参考。上传文件名由资产 ID 生成，原 name 仅为标签。生成结果允许 PNG/JPEG/WebP/GIF/MP4/WebM，按实际后缀和文件魔术校验；Comfy `images[]` 中的 MP4 仍登记为视频。`seed` 必须是 0..9007199254740991 的安全整数。prompt 最长 30000 字符；各 ID/key 有长度限制。

### 去重、错误与归档

`request_key` 对同一精确请求返回原作业，变化 payload 返回 409 `request_key_conflict`。SQLite 同时约束 project/shot/attempt，并保存包含配方 hash 的 fingerprint；新的 key 重复同一 attempt 的相同参数仍返回原作业。改参数不能隐式生成新 attempt，必须通过 retry。针对同一父作业重做多次请求不会创建多个后继。配方内容变化会拒绝复用旧首次请求；显式新 attempt 才能使用新配方。每个 Job 保存 output_nodes，后续配方变化不改变旧作业取回规则。

提交去重信息在任何网络写请求之前 commit；对 `/prompt` 的断连、超时、缺 prompt_id、服务错误，记录 `submission_unknown`，阻止自动重试和新的本地生成。重启时未完成的 submitting 同样变成未知。需要人工核对 Comfy 现有 history/queue，当前 API 没有强制清除未知状态的接口。GET 和 poll 可以重复；archive 下载失败可再次 archive，不能因此重投生成。参考上传失败和明确 Comfy 参数拒绝分别为 `failed/reference_upload_failed`、`failed/comfy_validation_rejected`；history 明确执行失败为 `comfy_execution_failed`；明确完成但无结果为 `comfy_completed_without_results`。

主要 HTTP 原因：403 `generation_disabled`；409 `upstream_busy`、`local_concurrency_limit`、`request_key_conflict`、`shot_attempt_conflict`、`retry_not_safe`、`job_not_completed`；400 `recipe_not_available`、`reference_count_mismatch`、`recipe_has_no_reference_binding`、`reference_project_mismatch`、`shot_project_mismatch`；503 `comfy_unavailable`。poll 断网保存原 submitted/running 状态并记录 `comfy_poll_unavailable`，缺 history 为 `history_not_available`，不会据此自动重试。

上传参考图后会再次只读检查 queue；若队列变忙，保存 `failed/upstream_became_busy`，若第二次 queue 校验不可用，保存 `failed/comfy_queue_check_failed`；这两种情况都没有发出 `/prompt`。缺失／非数组的 queue 字段不能视作空闲。首帧约束失败的 HTTP 400 原因为 `reference_mime_not_supported`、`reference_aspect_mismatch` 或 `reference_resolution_too_small`。

archive 从固定 Comfy `/view` 流式下载，限每个结果 256 MiB、每作业最多 16 个媒体，校验 Content-Length 完整性，SHA-256 完成后移动到独立 state/results 并登记 project/shot/job 血缘。文件名和 subfolder 防路径穿越，磁盘路径必须解析到状态目录中；失败不登记不完整资产。归档幂等，以 job/result_index 找到已登记资产；批量某项失败时已完整保存的前项保留，下次继续缺项。这是生成资产归档，不是视频发布后的生产归档，不写最终成片 `output/`。

## 状态目录与备份

状态目录有 `adapter.sqlite3`（WAL 模式）、`references/`、`results/`、`staging/`。SQLite schema v1 仅三表：objects 保存 kind/id/project_id/payload；job_keys 保存 request_key/job_id/fingerprint；job_identity 保存唯一 project/shot/attempt/fingerprint/job_id。独立数据库不承载上游项目事务。

`canvas_project_id` 是 objects.payload 中新增的可选项目 JSON 字段，不新增 SQL 列、不升级 schema。旧请求继续可用；旧项目 GET／列表缺少字段时只在返回值补 `""`，不写回旧 payload。既有项目、剧本、资产、镜头和 jobs 保留。旧 v1 程序仍可读取包含额外元数据的项目 JSON；该字段不改变生成或去重合同。

不要直接复制运行中的 SQLite 单文件。用 Python `sqlite3.Connection.backup()` 创建一致数据库副本，或在停止 sidecar 后复制整个状态目录（包含数据库和资源）。升级前备份状态、保留旧镜像／commit，先在备份副本运行同一版本合同测试与静态配方校验；未知 schema 版本服务拒绝启动，不降级覆盖。数据库快照和资产备份需要同一停写窗口，确保两者一致。不得删除或搬走原个人素材进行初始化。

## 验证范围

`test_adapter.py` 用仅 localhost 的 HTTP mock 覆盖默认禁生成、上传/绑定、跨项目防误关联、参数保持、去重/重启、共享队列占用、提交未知、显式重做、history 错误、完整下载/尺寸/路径、SHA 与资产血缘、HTTP 信封与 origin。mock 通过不代表真实模型生成通过。只读 `/health`、项目和资产冒烟也不证明真实生成成功；生成联调需另行协调 Spark GPU 资源后提交小样例。
