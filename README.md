# 缺集自动订阅

读取宿主的缺集扫描结果，按规则创建或合并聚合订阅。无需编译，整个目录打包为 `.dian115p` 后在插件中心上传。

- **规则**：从上到下匹配，每季按第一条命中的规则处理；可按实例、媒体库、连载状态、最新季、缺集数、缺集比例、已有集数、年份、类型、地区、片名和 TMDB 名单筛选。
- **动作**：自动订阅、进待审、忽略。可设观察期、单轮上限、资源来源，以及只补缺集或继续跟新集。
- **触发**：每小时一次，以及宿主缺集扫描完成后。自动运行默认关闭，手动运行和试运行不受影响。
- **保护**：提交前用 Emby 实时结果复核；不改动你自己创建的订阅；转存中的订阅下轮再合并；失败订阅过冷却期才重试；集号延续上季的剧不自动订阅。
- **通知**：结果按渠道发送；有待审项时 Telegram 带“全部批准 / 全部忽略”按钮。

缺集范围以宿主扫描结果为准，TMDB 上有播出日期的集都算缺，包括未来日期。

`GET /api/emby-manager/missing/report` 尚未列入公开契约，宿主升级时可能变化；每次读取会让宿主校准读到的剧集。

```sh
node --test docs/plugin-platform/examples/missing-subscribe/test/*.test.mjs
node docs/plugin-platform/conformance/project-check.mjs docs/plugin-platform/examples/missing-subscribe
node docs/plugin-platform/conformance/pack.mjs docs/plugin-platform/examples/missing-subscribe <目录外>/missing-subscribe.dian115p
```
