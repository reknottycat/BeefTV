# 渠道连接选项

用户已直接授权标准 OpenAI 兼容渠道增加以下三个连接元数据字段。字段复用现有 API Key 输入和持久化路径，不增加另一份密钥，也不改变操作系统网络、私网放行范围或凭据。

| 字段 | 值与行为 |
| --- | --- |
| `authMode` | 省略或填 `bearer` 保持原有 `Authorization: Bearer` 认证；`api-key` 把同一份已配置 API Key 放入允许的认证头。 |
| `authHeader` | 只填写请求头名称。Bearer 模式必须留空；API Key 模式留空时默认使用 `X-Api-Key`。 |
| `apiPathPrefix` | 留空保持协议现有的路径构造；`/` 使用 origin 根路径；如 `/gateway/v1` 则替换同一 origin 内的 API 前缀。 |

提供商密钥由用户在原有遮罩 API Key 输入框中手动填写。认证头名称和路径前缀不得包含密钥。这组选项不支持 Basic 认证、URL 查询参数中的密钥、任意认证值或脚本。

## 请求头和路径校验

认证头名必须是有效 HTTP token，最长 128 字节，不能与业务请求头重名，比较时忽略大小写。系统管理的名称会被拒绝，包括 `Authorization`、代理认证头、Cookie、`Host`、内容头、逐跳头、`Forwarded`、`X-Forwarded-*`、`X-Canvas-*` 和协议专用的 `X-Goog-Api-Key`。其他业务请求头继续使用原有校验，单独保留。

路径前缀必须是最长 1024 字节的 origin 相对路径，不能带协议、主机、查询、片段、百分号转义、反斜杠、控制字符、空白、重复斜杠或 `.` / `..` 段。末尾斜杠会被规范化；`/` 保持为显式根路径。

假设渠道原有聊天端点为 `https://api.example.invalid/v1/chat/completions`：

| 前缀 | 最终端点 |
| --- | --- |
| 留空 | `https://api.example.invalid/v1/chat/completions` |
| `/` | `https://api.example.invalid/chat/completions` |
| `/gateway/v1` | `https://api.example.invalid/gateway/v1/chat/completions` |

前缀替换整个 API 前缀，不会追加到 `/v1` 后面。目标 origin、允许的端点后缀、HTTP 方法和请求体继续由现有协议决定。支持的标准后缀覆盖模型列表、聊天、Responses、图片生成/编辑，以及视频创建/状态/内容路由；其他后缀会被拒绝。

现有目标 URL 校验、SSRF 防护、重定向策略和私网 allowlist 继续生效。系统渠道不接受这组自定义覆盖。专用插件保留自己的认证和 `OriginPath` 语义，这三个字段不能覆盖它们；专用协议渠道应沿用其原有配置，或由用户明确清除不兼容的自定义连接选项。

## 公开文本提供商预设

预设只创建可编辑的新渠道草稿，API Key、Secret Key 和业务请求头均为空，不读取本机环境变量、不把密钥搬到另一台机器、不查询账户、不替换既有渠道。两个预设都使用 Bearer 和仅文本的模型配置。

| 预设 | 公开 Base URL | 草稿中的模型 ID | 路径前缀 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`、`deepseek-v4-pro` | `/` |
| MiniMax | `https://api.minimax.cn/v1` | `MiniMax-M2.7` | 留空 |

DeepSeek 使用显式根前缀，对应官方文档的 `/chat/completions` 端点。MiniMax 公开国际 Base URL 为 `https://api.minimax.io/v1`，用户可按自己的账户选择填写。预设依据 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/)和 [MiniMax OpenAI 兼容文本接口](https://platform.minimax.cn/docs/api-reference/text-openai-api)中的公开信息；公开模型 ID 不证明账户权限，也不授权付费调用。这些文本预设不启用图片识别或自动质量审稿。

## 模型目录与生成

独立的本地 Comfy adapter 提供三个目录来源：

| 来源 | 展示的证据 |
| --- | --- |
| `comfy.recipes` | 已登记 API 配方和静态绑定；显式刷新只经 `/object_info/{registered_class}` 读取已登记节点类。 |
| `rh.standard` | RunningHub 官方标准端点目录快照，保留来源版本、任务和输出类型。 |
| `rh.llm` | RunningHub 公开 LLM 目录及其公开元数据。 |

RunningHub 发现只使用以下两个固定、匿名的 HTTPS GET 来源：

- [官方标准目录快照](https://raw.githubusercontent.com/HM-RunningHub/OpenClaw_RH_Skills/main/runninghub/data/capabilities.json)。
- [公开 LLM 目录](https://llm.runninghub.ai/v1/models)。

读取时不附加认证或 Cookie、不加载环境变量中的密钥、不跟随重定向，也不接受用户指定的目标地址。标准目录的 `string` 输出可能是结构化数据或媒体地址，不能全部认定为文本生成模型。实际 LLM 调用需要另外配置适合该账户的密钥，公开目录读取不进行这种调用。

`GET /api/local-comfy/v1/model-catalog` 只读内存缓存。刷新某个来源需要显式 `POST /api/local-comfy/v1/model-catalog/refresh` 并提交 `{source}`，沿用现有同 origin JSON 写入校验。来源版本、抓取时间、陈旧状态和读取错误描述目录新鲜度，不代表账户健康状态。

目录响应明确为只读、仅目录，`generationEnabled:false`。发现条目、配方静态检查和已安装权重均不证明 GPU 执行成功、账户可用或计费授权。目录页还没有把条目接入原生项目默认模型或统一生成调度。社区 AI 应用、手工工作流 ID 导入和权重/资源列表是另外的未接通能力，目录不宣称枚举用户的全部应用或工作流。

## 验证结果的边界

配置持久化、目录发现、mock 请求行为、带认证的提供商连接和真实生成分别需要证据。本页说明连接合同，不是测试报告。表单保存成功不证明连接可用；mock 响应不证明账户权限、GPU 执行、模型质量或付费服务结果。实际检查及其限制应记录在交付证据中，不记录密钥、私有路径或含凭据的 URL。
