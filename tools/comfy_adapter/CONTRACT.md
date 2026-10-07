# ComfyUI 内部适配合同

本服务是可选的 Python 标准库 sidecar。作品、画布、任务和素材的产品入口由 Go 工作区管理；这里的 project/shot/asset 仅是内部身份映射和持久作业账本，不提供第二套剧本或项目工作台。

部署和私有配方格式见 [本地生成部署](../../docs/content/docs/backend/local-comfy.mdx)。

## 服务边界

- Python 3.10+；独占一个持久状态目录，单个 adapter 进程管理该目录。
- `BEEFTV_COMFY_URL` 固定 Comfy HTTP(S) origin，禁止凭据、query、fragment 和路径；请求不接受覆盖地址或任意工作流。
- `BEEFTV_COMFY_RECIPES` 指向私有配方清单；`BEEFTV_COMFY_ENABLE_GENERATION=1` 才准入新生成。
- `BEEFTV_COMFY_ADAPTER_TOKEN` 为服务间 Bearer token，非 loopback 监听强制至少 32 个非空白 ASCII 字符。Go 端使用同一 token，不发送给浏览器。
- 只允许 Go 服务端访问；携带 Origin 的浏览器请求被拒绝。无 token 的 loopback 模式还校验 Host，阻止 DNS rebinding。
- 不读取公网模型目录，不检查云账户，不启动或安装 GPU worker，不实现共享队列 interrupt/clear。
- 默认监听 `127.0.0.1:6007`；容器使用内部网络并配置 token，不能把 adapter 代理为公共 Web 路由。

## HTTP

前缀 `/api/local-comfy/v1`。成功 `{code:0,data:...,msg:"ok",reason:null}`；失败同时返回真实 HTTP 4xx/5xx 与 reason。媒体 content 返回 bytes。POST 必须为 JSON 对象（15 MiB 上限），未知字段拒绝。

| 方法/路径 | 合同 |
| --- | --- |
| GET /config | generation_enabled, recipe_count, max_reference_bytes；无私有地址 |
| GET /health | 只读共享 queue；不可达时 counts 为 null |
| GET /recipes | id, name, mode, recipe_version, output, reference_slots, reference_constraints, ready |
| GET/POST /projects | 内部映射；POST name, upstream_project_id?, canvas_project_id? |
| GET /projects/:id | 保存的内部映射 |
| GET/POST /shots | POST project_id, name, upstream_shot_id?, reference_asset_ids? |
| POST /shots/:id/references | 完整 asset_ids；只接受同项目图片 |
| GET /shots/:id | 保存的镜头映射 |
| GET/POST /assets | POST project_id, name, kind, mime_type, data_base64, upstream_asset_id? |
| GET /assets/:id/content | 已校验媒体 bytes |
| GET /assets/:id | 资产元数据，包含 size/sha256/归属，无磁盘路径 |
| GET /jobs | project_id/shot_id 过滤；恢复提交只读查询 |
| POST /jobs | project_id, shot_id, recipe_id, recipe_version, prompt, seed, reference_asset_ids?, request_key |
| GET /jobs/:id | 读取保存状态，不隐式提交 |
| POST /jobs/:id/poll | 空对象；只读原 prompt history/queue |
| POST /jobs/:id/archive | 空对象；归档已完成原作业，失败后可继续归档 |
| POST /jobs/:id/retry | request_key, recipe_version, prompt?, seed?；仅明确 failed/completed 允许 |

GET project/shot/asset/job 的 ID、关联 ID 和 request_key 均由 Go 端再次核对 owner、原作品、任务和资源归属。Go 只公开 config/recipes，任务查询与恢复沿原生任务 API。

相同 project upstream+canvas、shot project+upstream、asset project+upstream 的重复映射返回原对象。镜头参考或资产字节/MIME/kind 不一致返回 409，标签更名不创建新身份。

## 配方与批准

`recipe_version` 为 mode/output/workflow/bindings/output_nodes/reference_constraints 的确定性 SHA-256。显示名和私有磁盘路径不进入版本。提交或显式重试必须携带当前版本；不一致返回 `recipe_version_changed`，不创建作业，不触发 GPU。旧作业仍可查询、poll、archive，不受当前配方移除、版本变化或生成关闭影响。

`ready` 仅表示配方文件和绑定静态有效，不代表 GPU 已实测。原生生成还要求完整 output 合同：width/height 为 1..8192 的整数，总像素不超过 33554432；video 需 0<fps<=120 与 0<duration_seconds<=600。无 output 的配方不会进入原生选择器。输出说明由部署者与实际工作流核对，不自动推断。

output 可含 mime_type（受限媒体类型）。当前 Go 原生视频准入要求显式 video/mp4，提前拒绝未声明格式或 WebM；adapter 可保留历史 WebM 归档能力。Go 验证实际尺寸和时长，fps 当前仅为冻结的配方声明。

## 持久化与恢复

SQLite `objects`、`job_keys`、`job_identity` 保存 project/shot/asset/job 和去重围栏。首次 attempt 为 1，显式重试保存 parent_job_id 和递增 attempt；每个 Job 保存 workflow/recipe SHA、output_nodes、request_key、prompt_id 与归档身份。生成前先 commit，响应丢失后不能靠新 task 绕过。

Job.status 为 submitting/submitted/running/completed/failed/submission_unknown。启动时遗留 submitting 变为 submission_unknown。未知提交既不能自动重试，也不能自动清除；核对原作业。原生“取消”只停止工作区跟踪，GPU 可能继续，可查询原任务取回结果。

只读 queue 在建 job 之前失败为 503 `comfy_unavailable`，明确未提交；/prompt 超时、断流、缺 prompt_id、服务错误都视为 submission_unknown。poll 断网保留原状态。生成关闭只禁止新提交，不禁止取回。

上传仅接受 PNG/JPEG/WebP 图片（10 MiB），校验魔术与可用 PNG 尺寸。输出仅允许 PNG/JPEG/WebP/GIF/MP4/WebM，最多 16 个，每个 256 MiB；下载检查完整字节数、SHA-256、魔术和路径安全。archive 以 job/result_index 幂等续传，失败不重新生成。

状态目录包含 adapter.sqlite3（WAL）、references/、results/、staging/。备份时停止服务或使用 SQLite 一致性备份；不只复制活跃的主数据库。禁止提交状态目录、私有工作流、密钥、模型或真实素材。

## 验证

`python -m unittest discover -s tools/comfy_adapter -p test_adapter.py -v`

测试只访问临时 loopback mock，不调用真实 GPU、付费模型或公网目录。
