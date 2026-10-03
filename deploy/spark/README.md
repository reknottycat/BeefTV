# Spark 本地工作台容器

这一套 Compose 保留 BeefTV 的 React 前端、Go 本地工作台和原渠道入口，额外添加标准库 Python ComfyUI 适配服务。前端 Nginx 优先将 `/api/local-comfy/v1/` 转到内部 `comfy-adapter:6007`，其他 `/api/` 继续使用上游 Go 服务。复用已有 ComfyUI，不安装或运行模型；容器没有 GPU 声明。

## 数据与版本

- 此版本 Go 数据库只支持 SQLite：`/data/open_ai_canvas.db`，WAL 模式。不要使用根目录旧 PostgreSQL/Redis 服务器模板。
- `CANVAS_AUTO_MIGRATE` 由 `backend/cmd/server/main.go` 读取；开启时启动会运行 `database.MigrateLocalSchema`。迁移前必须先备份，并在副本验证。
- 正常 Go 启动同时会恢复任务 worker、BeefAPI 会话和播放副本。旧数据库副本先使用 `compose.migration-check.yml`，其唯一候选容器 `network_mode: none`，避免旧待办云任务联网重启。此设置只隔离新候选容器，不改变宿主网络策略。
- 镜像按已验证源码 commit 使用唯一 release 标签。不要复用标签或使用 `latest`；实际部署后另记录镜像 ID/digest。
- 三个镜像保留 MIT `LICENSE`、`NOTICE` 和 `THIRD_PARTY_NOTICES.md`；`BEEFTV_SOURCE_REPOSITORY` 指向实际构建代码的 fork，revision label 记录相应 commit，上游归属仍保留。
- 持久目录独立于源码和镜像，推荐布局：`<runtime-root>/state/backend-data`、`state/comfy-state`、`private/recipes`、`backups`、`releases/<commit>`。旧媒体本轮不搬迁。
- `.env`、真实私网地址、工作流、数据库、密钥和素材仅放 gitignored `.local` 或 Spark 私有 runtime 目录，不能进入 fork 或镜像。三个 Dockerfile 各自使用上下文白名单；不提交运行日志。
- `private/recipes/recipes.json` 使用容器内绝对路径（例如 `/recipes/workflows/example-api.json`）；该目录只读挂载。参考图、生成结果和 SQLite 任务账本写入 `state/comfy-state`。配置格式见 [适配合同](../../tools/comfy_adapter/CONTRACT.md)。
- Spark 前端在构建时启用 `VITE_CANVAS_LOCAL_RESOURCE_STORE=backend` 和 `VITE_CANVAS_LOCAL_MODE=true`：剧本工作台保持本地模式，图片等资源走同源 Go API，物理文件在持久化 `/data/resources`；后端不可达时不把新资源偷偷降级写入浏览器。

## 前提与首次部署

要求 ARM64 Docker/Compose，精确基础镜像：`alpine:3.22`、`golang:1.25-alpine`、`oven/bun:1.3.13`、`nginx:1.27-alpine`、`python:3.13-alpine`。构建还安装 Alpine 的 `build-base`、`nodejs`、`zip`、`ca-certificates`、`tzdata`、`wget`；Python 适配没有 pip 依赖。Bun 仅 `--frozen-lockfile --ignore-scripts`，Go 使用现有 `go.mod`/`go.sum`。如依赖不可达或 ARM64 manifest 缺失，报告具体项，不盲改版本或扩大权限。

前端使用上游 slim 构建，不带可选浏览器大模型、3D 素材或 FFmpeg 模型资源。原剧本、画布、资产、渠道功能沿用上游；依赖可选重型资源的功能应另行验证。完整 `bun run build:slim` 同时做 TypeScript 检查，不跳过编译错误。

1. 在已授权账户的新私有 runtime 目录创建上述三个持久/配置目录；保留本机原目录。运行用户 UID/GID 与新目录所有者一致，Compose 不自动创建或改已有数据目录权限。
2. 把 `.env.example` 复制到 `.local/spark.env`，填写明确的私有接口、浏览器 origin、绝对数据路径、源码 commit 和 release 标签。Comfy 地址只放实际环境文件。保持 `BEEFTV_COMFY_ENABLE_GENERATION=0`。
3. 先做配置检查：

   ```sh
   docker compose --env-file .local/spark.env -f deploy/spark/compose.yml config --quiet
   python3 -m unittest discover -s deploy/spark -p 'test_*.py'
   ```

4. 获得所需依赖安装/构建授权且专项测试通过后，在 ARM64 主机分服务构建，再启动；镜像构建和程序运行均不调用 GPU：

   ```sh
   docker compose --env-file .local/spark.env -f deploy/spark/compose.yml build backend
   docker compose --env-file .local/spark.env -f deploy/spark/compose.yml build comfy-adapter
   docker compose --env-file .local/spark.env -f deploy/spark/compose.yml build web
   docker compose --env-file .local/spark.env -f deploy/spark/compose.yml up -d --no-build
   ```

5. 从已配置私有 origin 访问前端，并读 `/api/health/ready`、`/api/workspace/bootstrap`、`/api/local-comfy/v1/health` 和 `/api/local-comfy/v1/config`。确认原项目/资产 API 与 adapter 都可达、`generation_enabled` 为 false。健康检查不能替代编辑保存、资源读取和最终生成验证。此时仍不提交 GPU 作业。

无需新依赖的适配器 smoke 可以先在已有 Python 的专属临时目录运行 `smoke_readonly.py --temporary-root <new-private-test-directory>`，环境显式设置 `BEEFTV_COMFY_URL` 和私有 recipes manifest。脚本强制 adapter 关闭生成，真实上游只准 `/queue`、`/system_stats` 的 GET；临时 adapter 仅绑定 loopback 随机端口，检查五个 GET 后关闭并等待线程退出。它不会启动 Go 工作台或前端，不能作为完整 BeefTV 部署成功证据。

后端与适配服务不发布宿主端口。唯一 web 端口显式绑定授权的私有接口；这份配置不改防火墙或公网路由。数据库和资产保留在 bind mount，更新镜像不会复制大模型或清空素材。

## 备份、升级与回滚

Git 上游同步与容器升级是两个步骤：先 `fetch upstream`、在隔离分支合并、检查差异、测试、提交；再选择通过验证的 commit 构建镜像。不能直接将上游变化覆盖运行目录。

1. 保留当前源码 commit、`.env` 副本和三个镜像 ID；不执行 `docker image prune`。维护窗口内用原 Compose 执行 `stop`（不用 `down`），等待工作台和 adapter 停止。确认其他进程没有写入这些专属数据目录。
2. 执行冷备：

   ```sh
   python3 deploy/spark/backup.py --runtime-root /your/private/runtime-root --project beeftv-spark
   ```

   脚本检查该项目的全部容器已停止，并验证 `/data` 和 `/state` 挂载确实对应 runtime 目录。使用 SQLite backup API（包含已提交 WAL 事务）并验证 `integrity_check`；备份目标转换为单文件 DELETE journal，应用启动时再按原 DSN 开启 WAL。单独复制资产和配置，忽略 WAL/SHM/journal。备份使用新目录，不覆盖或删除原件。只有生成 `complete.json` 才是完整备份。
3. 将完整备份的 `backend/` 复制到独立候选目录，制作候选 `.env`，设置不同 Compose project、新 release 标签和 `BEEFTV_MIGRATION_DATA`（必须指向副本）。先运行离线迁移检查：

   ```sh
   docker compose --env-file .local/candidate.env -f deploy/spark/compose.migration-check.yml up -d --no-build
   docker compose --env-file .local/candidate.env -f deploy/spark/compose.migration-check.yml exec -T migration-check wget -qO /dev/null http://127.0.0.1:8080/api/health/ready
   docker compose --env-file .local/candidate.env -f deploy/spark/compose.migration-check.yml stop
   ```

   使用已有宿主 Python/SQLite 对迁移副本做 `PRAGMA integrity_check`、schema 版本和项目/资源引用检查，记录变化。没有迁移成功证据就不切换。浏览器、adapter、保存路径等联调先用另一套空数据候选，私有 loopback 端口且 generation 为 `0`；不要把含未知待办任务的旧数据库副本直接联网启动。检查结果和日志仅保存私有目录。
4. 候选通过后停候选，在原项目启用相同已验证镜像；原数据目录迁移前备份必须仍存在。只在用户已授权的维护窗口切换，不做自动升级。
5. 若切换失败，停止新容器。恢复旧 `.env` 和旧镜像标签，将完整备份复制到**新的恢复目录**，调整 mounts 指向恢复目录，启动旧镜像。旧镜像可能不能读取迁移后的 schema，不能仅回退镜像。失败目录和原数据目录保留，禁止覆盖、删除或回滚用户其他服务。

本方案没有周期自动同步任务，也不新增 token、OAuth 权限、系统服务或网络策略。
