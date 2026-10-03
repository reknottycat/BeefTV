---
name: beeftv-spark
description: 通过服务 URL/API 使用 Spark 上的 BeefTV，操作原生项目剧本和角色场景道具关联，并通过本地 ComfyUI 适配层提交单镜、查询状态和取回结果。用于电脑端 AI 操作，不依赖网页点击；不调用云付费渠道。
---

# BeefTV Spark

使用 [scripts/beeftv_spark.py](scripts/beeftv_spark.py) 通过 HTTP 调用服务。Python 3.10+ 即可，无新增第三方依赖。服务部署在 Spark；电脑端只运行短时 CLI，不启动完整 BeefTV 后台。

先运行 upstream-bootstrap、upstream-projects、health、config、recipes，并查询目标项目的原生及适配层资产。以本次响应确认服务可达、本地 workspace scope、生成开关及配方 ready。不能把 mock 测试通过当作 Spark 已部署或真实生成通过。验证范围见 [references/verification.md](references/verification.md)，字段和命令见 [references/api.md](references/api.md)。

## 本地配置

从用户给定的服务 URL 或已有本地配置读取地址。CLI 支持 --config JSON 文件或环境变量 BEEFTV_SPARK_URL；生成还需要 --state-dir 或配置中的 state_dir 保存请求账本。实际私网 URL、个人路径、脚本、媒体和账本只放 Git 忽略的 .local/ 等本地目录。公开示例不含凭据，不把账号 Cookie、API key 或用户名密码写进 URL。

~~~powershell
python <skill-dir>/scripts/beeftv_spark.py --config <private-config.json> upstream-projects
python <skill-dir>/scripts/beeftv_spark.py --config <private-config.json> upstream-assets --project <native-project-id> --category character
python <skill-dir>/scripts/beeftv_spark.py --config <private-config.json> assets --project <sidecar-project-id>
~~~

本地配置的脱敏形状：

~~~json
{"base_url":"http://spark-host.example:6007","state_dir":"beeftv-spark-client-state"}
~~~

state_dir 相对配置文件所在目录解析；环境变量/命令行提供的相对路径按当前目录解析。配置必须用实际服务地址。缺 URL、scope、可达服务或配方时明确报告缺项，不安装新服务、改网络/凭据或换付费云渠道。客户端只支持服务已有的 local workspace，不创建默认账号、token 或伪造 user/workspace ID。

## 原生项目与适配层登记

- upstream-* 调用 BeefTV 原生 /api：upstream-project-create 创建网页能显示的项目；upstream-script-import 将文本导入一个 chapter/episode 单元；upstream-units 查询已保存单元。剧本导入不调用 LLM，不自动拆镜。
- upstream-assets 查询原生库，分类为 character、environment、prop、material、other；场景用 environment。upstream-character-get 查角色卡详情。upstream-shot-create 创建原生镜头，upstream-shot-link 用原生 assetVersionId 关联同项目镜头。禁止把 sidecar asset ID 当原生资产版本 ID。
- 不带 upstream- 的 project-create、script-import、asset-upload、shot-create 只登记 /api/local-comfy/v1 的独立项目/资产/镜头。upstream_project_id、upstream_asset_id、upstream_shot_id 只是关联元数据；不会自动同步原生库或自动回填网页项目。生成归档结果也只在适配层资产库。
- 用 assets 查询适配层角色、场景、道具、参考图、生成结果；asset-upload 上传用户选定的真实参考图，shot-references 关联同项目资产。本人图依工作区人物资产索引选择真实图片，不能用文字描述替代。
- 制作新视频前遵守工作区视频项目、风格和导演编排规则。该技能负责 API 执行，不替代导演方案、文稿审核、身份图选择或最终成片验收。

原生 API 写入没有请求键幂等合同；连接断开或超时返回 request_outcome_unknown，先查项目/单元/镜头，不能直接重复创建或导入。

## 单镜生成、失败与去重

1. 只复用服务列出的已确认配方，检查 ready 和参考槽位。配方以服务器实际 API 工作流为准，不从模型名猜步骤数，不自行重写 H3 工作流。
2. 查询 jobs --project ... --shot ...，继承已提交任务。服务器生成默认关闭；用户已授权当前镜头、资源允许且服务器明确启用时，才带 --allow-generation 提交。保留服务器并发限制，不启动额外 GPU 服务或抢占正在跑的任务。
3. job-submit 必须传稳定 --request-key、适配层项目/镜头/配方/提示词文件和 seed。CLI 先写账本，服务器按请求键和单镜尝试指纹去重；同键改内容会冲突。普通提交固定为 attempt 1。
4. job-watch/job-poll 跟踪已有任务。网络超时、连接断开、submitting、submission_unknown、CLI request_outcome_unknown 均不是已失败：先 jobs/job-get 核对，不换新键重提交，不自动重试 GPU 作业。private state_dir 中任何账本 pending/不明状态都会阻止新的生成 POST（包括换键）；账本损坏或不可读也停止写入。已知旧任务 GET 和只读查询仍可使用。人工核对后再处理账本，不能删账本绕过检查。
5. 任务明确 failed 才用 job-retry，明确 completed 且用户要求重做才用 job-redo；两者都用新请求键，经同一 /retry 端点产生新 attempt，保留旧结果。未知状态不支持自动恢复，没有取消接口。重试次数按用户授权范围执行；错误未消除时停止。
6. completed 后运行 job-archive，检查 archived_asset_ids，再 result-download 到项目素材目录。此处归档的是生成资产，不代表视频已发布、内容已验收或该搬移生产项目。最终成片仍遵循项目 output/ 与 SemVer 规则。

如实报告项目/镜头/任务 ID、状态、attempt、取回文件、验证范围和剩余缺项。技能不发起云支付，不设置账号权限，不修改系统安全设置。
