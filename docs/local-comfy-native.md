# 原生本地 ComfyUI 模型与任务

本地生成沿用 BeefTV 的模型选择器、项目默认模型、`/api/tasks`、资源存储和画布结果消费。云渠道继续使用原协议；本地模型不需要新增渠道或云 Key。

当前登记的模型 ID 为 `local-comfy:qwen_image_2_1`（1024×1024 文生图）、`local-comfy:qwen_image_2_1_preview512`（512×512 文生图）、`local-comfy:h3_i2v_turbo4`（864×480、124帧、24fps，需要1张 PNG 首帧）。尺寸、帧数和步数来自已有工作流；普通云参数不能覆盖它们。Ref2VA 与长视频续接不在这三个配方的可调用范围内。

图片、视频模型 ID 保存到已有全局默认和项目默认字段。选择优先级为节点明确选择、制作项目默认、全局默认。已保存但不再登记的本地模型显示不可用原因，不会自动改选云模型。目录和 generation permission 为即时服务状态，不写入配置。缺少连接或凭据的文本渠道保留为可编辑草稿，不能自动成为默认文本模型。

普通创建、画布和制作镜头提交使用：

```json
{
  "provider": "local-comfy",
  "model": "local-comfy:qwen_image_2_1_preview512",
  "type": "canvas_image",
  "input": {
    "mode": "image",
    "prompt": "用户镜头提示词",
    "localComfy": { "recipeId": "qwen_image_2_1_preview512", "seed": 42 },
    "metadata": { "clientOperationId": "每次明确操作的稳定标识" }
  }
}
```

服务端从固定 Compose adapter 获取生成开关。关闭时拒绝新提交，返回 `reason: generation_disabled`；已有任务仍可查询和归档。重复 clientOperationId 返回同一任务。视频参考图必须是当前用户拥有、可读取的图片资源；前端按固定首帧尺寸检查，服务端继续验证图片 bytes、类型和归属。不会向本地 adapter 转发云 Key、用户指定 URL 或任意认证 header。

任务中的 providerRequestId 关联 sidecar 作业。提交响应丢失时仅通过稳定身份查询原作业，不自动再提交。任务中心的重试只针对明确失败的原作业；取消停止 BeefTV 跟踪并标记上游取消不确定，不发全局 ComfyUI interrupt。结果经大小、SHA 与归属核验后保存为已有原生 Resource，供素材库、项目关联和画布幂等消费。

正常任务中心入口为 `/tasks`。画布项目库“制作项目”入口使用 `/projects?view=production`，保留现成剧本、角色、场景和道具页面。独立 `/local-comfy` 仍可读取旧作业，未指定上下文时由用户明确选择项目。

验证须分别报告离线 mock、完整构建、网页选择与配置回读、真实 GPU 生成。本轮关闭生成开关，不以历史 Qwen 技术预览推定新原生任务、全尺寸 Qwen、H3 或长视频已实测成功。
