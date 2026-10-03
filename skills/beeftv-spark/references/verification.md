# 验证范围

本页随本次交付更新。技能自检只验证结构；客户端 mock 合同测试不证明生产服务、GPU 模型或内容质量。

- 已实现：原生 BeefTV 项目查询/创建、剧本单元导入、原生角色/场景/道具查询和镜头资产版本关联；独立适配层项目/资产/镜头、任务提交/轮询/归档/重做及结果下载。
- 原生合同来自仓库 Go handler/request 与前端调用方；本地 ComfyUI 合同来自适配层实现。
- 部署协作环节已记录：CLI 对 Spark 临时 loopback sidecar 的 GET config/projects/assets/recipes/health 五项通过，生成关闭，临时服务已退出。这是临时适配层只读冒烟，不是完整 BeefTV 容器上线。
- 尚未确认：Spark 完整部署后的原生 BeefTV workspace/projects/assets API 冒烟。
- 后续获准的最小 GPU 联调已完成：Qwen 单张 864×480 图通过实际适配层和 CLI 提交、轮询、归档、下载与字节数/哈希核验。它验证独立 sidecar 闭环，未验证原生 BeefTV 项目/资产回写。
- H3 原生引擎短样例已完成：两段各 124 帧，22 帧 raw AV latent 上下文；B 同步裁去头部后为 102 帧，组合预览为 226 帧、24fps。真实参考图上传、latent 存取、完整解码、帧数和音画时长已核验；这条续接实验没有经 BeefTV 界面或适配层任务账本执行。
- 尚未验证：人物身份、人工试听、用户内容验收、20 秒段和长链。短空镜接缝有轻微位置/曝光变化，不能称为完全无缝或生产就绪。
- 尚未实现：sidecar 结果自动回写 BeefTV 原生资产/镜头、取消任务、云付费渠道。

2026-10-03 验证命令：

~~~powershell
python -X utf8 -m unittest discover -s skills/beeftv-spark/scripts -p test_*.py -v
python -X utf8 <installed-skill-creator>/scripts/quick_validate.py skills/beeftv-spark
~~~

已通过 28 项（21.863 秒）：27 项隔离 HTTP mock，1 项使用真实适配层 HTTP 服务和临时 SQLite/资产目录验证项目/剧本/素材登记、查询、下载完整性及关闭生成的门禁。该实际服务测试的 Comfy /queue 是只读 stub；不是 Spark 部署冒烟。本地账本在服务已接受作业后落盘失败也会保留不明状态，停止重投。

技能结构自检已通过源码和工作区发现两个副本，CLI --help 冒烟通过。下载故障覆盖字节数/哈希不符、声明超限和不完整响应；写入故障覆盖 HTTP 5xx、连接断开、请求键冲突、原生scope缺失和不明任务禁止重试。增补了同账本目录跨新键阻止生成 POST、损坏/不可读账本与目录停止写入，以及已知旧任务 GET/只读查询仍允许的回归。独立前向评估揭示的 raw 新键 POST 边界已补齐；服务端仍承担实际镜头去重保护。不得据此改称真实生成通过。

另增一项实际故障回归：子进程强制 PYTHONIOENCODING=ascii:strict、PYTHONUTF8=0，从 HTTP stub 下载到中文素材目录/文件，验证退出码0、JSON按ASCII解码并还原中文路径、下载字节一致。CLI仅改标准输出为ASCII安全JSON转义；不重投生成。
