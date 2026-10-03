# API 与 CLI

全局参数放命令之前：--config、--base-url、--state-dir、--timeout。配置优先级为命令行 > BEEFTV_SPARK_URL > JSON base_url。服务 origin 或完整 /api/local-comfy/v1 均可作为 base_url；原生 API 始终取同 origin 的 /api，不读取付费模型配置。

正常响应解包 {code:0,data,msg,reason}；非零 code 和 HTTP 错误均返回失败。CLI 输出 {ok:true,data:...} 或 {ok:false,reason,message,...}，失败退出码 1。HTTP 重定向不跟随，避免误转发上传数据。

CLI 的 JSON 标准输出用 ASCII 安全转义；解析后的中文名称和路径保持原文，避免 Windows 严格控制台编码在文件已落地后使打印失败。HTTP JSON 和本地 UTF-8 账本内容不受此输出编码策略影响。

客户端直连配置的服务，不使用系统/环境代理。任何生成 POST 或原生写请求的 HTTP 5xx 都按结果不明处理，不能据此换键重投。下载有 256 MiB 硬上限，先按资产元数据 size 与 sha256 验证完整字节，再创建目标文件；不完整、过大或哈希不符均不留下目标文件。

## 原生 BeefTV

合同源为 web/src/services/api/projects.ts、workspace.ts，backend/internal/handler/project.go、workspace.go，backend/internal/app/project.go、project_shot.go；由运行中的 workspace scope 决定用户归属。每个原生命令先 GET /api/workspace/bootstrap，要求实际 profile=local、workspace.id 与 user.id；缺失则停止，不注入默认 ID、Cookie 或登录头。

| CLI | 原生接口 | 必要参数与返回 |
| --- | --- | --- |
| upstream-bootstrap | GET /api/workspace/bootstrap | 本地 workspace 合同 |
| upstream-projects | GET /api/projects | data.projects（项目摘要） |
| upstream-project-create | POST /api/projects | --name --type --aspect-ratio --source-type；可选 --description --style-preset-id；body name/type/aspectRatio/sourceType，返回 data.project |
| upstream-project-get | GET /api/projects/{id}/core | --project；data.project |
| upstream-units | GET /api/projects/{id}/units | --project；data.units 与 canvasCounts |
| upstream-script-import | POST /api/projects/{id}/units/import | --project --file --kind chapter或episode --title；body units:[{kind,title,sourceText}]；返回 data.units |
| upstream-assets | GET /api/projects/{id}/assets | --project；可选 --category character/environment/prop/material/other --page --page-size；返回 assets/categoryCounts/hasMore 等分页字段 |
| upstream-character-get | GET /api/projects/{id}/characters/{assetId} | --project --asset；data.asset 与 character |
| upstream-shot-create | POST /api/projects/{id}/shots | --project --title --description-file --duration-ms --position，可选 --unit；body title/description/position/durationMs/revision.plotDescription/unitId；data.shot |
| upstream-shot-link | POST /api/projects/{id}/shots/{shot}/assets | --project --shot --asset-version --role reference/start_frame/end_frame/keyframe/storyboard/output；body assetVersionId/role；data.reference |

--file 和 --description-file 为本地 UTF-8 文件，不在终端命令中拼接剧本全文。项目 type/sourceType/aspectRatio 采用用户选择及部署源码允许的值；服务器校验错误如实返回，不用猜测值重试。导入是新增单元，未实现增量覆盖、自动拆镜、云 LLM 解析、原生资产上传或从 sidecar 自动回填。

## 本地 ComfyUI 适配层

以下接口路径均相对 /api/local-comfy/v1；列表 data 为数组。

| CLI | 接口 | 参数 |
| --- | --- | --- |
| health / config / recipes / projects | GET /health /config /recipes /projects | 无 |
| project-create | POST /projects | --name，可选 --upstream-project-id |
| script-import | POST /projects/{id}/script | --project --file；body script/format:text |
| assets | GET /assets | 可选 --project --kind character/scene/prop/reference/result |
| asset-get | GET /assets/{id} | --asset |
| asset-upload | POST /assets | --project --name --kind character/scene/prop/reference --file；可选 --upstream-asset-id；body project_id/name/kind/mime_type/data_base64 |
| asset-download | GET /assets/{id}/content | --asset --output；原始字节，不覆盖已有文件 |
| shots | GET /shots | 可选 --project |
| shot-create | POST /shots | --project --name；可选 --upstream-shot-id --reference（可重复） |
| shot-references | POST /shots/{id}/references | --shot --asset（可重复，空列表清除关联） |
| jobs | GET /jobs | 可选 --project --shot |
| job-submit | POST /jobs | --project --shot --recipe --prompt-file --seed --request-key --allow-generation；可选 --reference（可重复） |
| job-get | GET /jobs/{id} | --job |
| job-poll / job-archive | POST /jobs/{id}/poll 或 archive | --job；body:{} |
| job-watch | GET job + POST poll | --job，可选 --interval（至少1秒）--max-wait（默认55秒）；超时保留同job |
| job-retry / job-redo | POST /jobs/{id}/retry | --job --request-key --allow-generation；可选 --prompt-file --seed；retry仅failed，redo仅completed |
| result-download | GET job、asset 元数据及 content | --job --directory；先 archive；保存生成资产字节，不覆盖已有文件 |

config 公开生成开关、storage_scope:sidecar、concurrency、max_reference_bytes、recipe_count；recipes 公开 id/name/mode/reference_slots/ready/reference_constraints。ready 只表示文件和绑定静态校验，不能证明模型、GPU 或内容验收。generation_gate 不启用服务器开关，只检查当前开关和配方 ready。参考槽数、PNG 首帧尺寸/比例等约束由服务端按已注册配方执行。

Job 的 status 为 submitting/submitted/running/completed/failed/submission_unknown，包含 id、prompt_id、attempt、parent_job_id、recipe_id、workflow_sha256、recipe_sha256、output_nodes、error、results、archived_asset_ids。results 是 ComfyUI node_id/filename/subfolder/type 描述符；result-download 从已归档资产接口读取，不自行猜私网 /view URL。

CLI 账本只存请求键、body SHA-256、命令、状态和 job_id，不写提示词或配置 URL。成功的相同键重复执行改为 GET 已有 job；同键不同输入本地拒绝。未收到完整响应或写入后崩溃保留不明状态。新生成写入前检查 private state_dir 全部 JSON 账本；任何 pending/request_outcome_unknown 都禁止再次生成 POST，即使换请求键。损坏、字段无效或读取失败均停止生成写入，不忽略；已知旧任务 GET 和只读命令仍允许。该门禁与服务并发 1 一致；没有自动 clear 或跨账本目录全局屏障。服务器仍需执行自身请求键/镜头指纹去重，CLI 账本不能替代服务端去重。

当前没有取消、不明提交强制重试、生成并发绕过、原生自动回填或云渠道调用命令。
