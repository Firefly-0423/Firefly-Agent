# 时区工具（timezone-tools）

Firefly Plugin API v1 插件，版本 1.0.0。首次安装保持停用，需要用户明确启用。

启用后提供两个只读工具，只使用引擎内置的 `Intl` 和 `Date`。

## `timezone-tools_canonicalize`

参数 `{ "zone": "America/New_York" }`。返回 `{ "valid": true, "canonical": "America/New_York" }` 或 `{ "valid": false }`。

只接受 `UTC` 或 `Area/Location` 形式的 IANA 名称；空串、带首尾空白、缩写（`EST`、`GMT`）、单段名称（`Tokyo`）、小写 `utc` 和平台不认识的名称一律无效。别名按本机 ICU 数据归一化，所以同一别名在不同 Node/Electron 构建上可能返回不同拼写（例如 `Asia/Kolkata` 在部分构建上规范为 `Asia/Calcutta`）。

## `timezone-tools_convert`

参数 `{ "time": "2026-03-08T12:00:00Z", "to": "America/New_York" }`，可选 `from`。

- `time` 带 `Z` 或 `±hh:mm`（也接受 `±hhmm`）偏移时表示确定的瞬间，此时不能再给 `from`。
- `time` 不带偏移时是某个时区的本地时间，必须给出 `from`；不会猜测系统时区。
- 夏令时空档里不存在的本地时间（如 2026-03-08T02:30 在 America/New_York）报错；重复的本地时间（2026-11-01T01:30）取较早的瞬间，返回 `ambiguous: true` 和 `alternativeInstant`。
- 返回 `instant`（UTC，毫秒精度）、`to`（`zone`、`local`、`offset`），有 `from` 时还有 `from`。`zone` 回显调用者写的名称。
- 年份限定 1900–2200，秒的小数部分超过 3 位时截断到毫秒，不接受 `24:00` 和闰秒。

输入不合法时报错，不隐式修正。

## 来源

时区名校验规则（`UTC` 或 `Area/Location` 的严格正则，加 `Intl.DateTimeFormat` 规范化）改编自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `packages/util/time`（`canonicalClientTimeZone`），MIT 许可，`Copyright (c) 2026 DeepSeek`。原库明确只做校验、不格式化也不换算；`timezone-tools_convert` 是 Firefly 新写的，建立在同一套时区名规则之上。随包 LICENSE 保留原版权声明。

## 安全

入口只做内存内计算，不联网、不读写文件、不启动命令、不使用计时器，不持久化或记录输入。停用时注销两个工具。Firefly 插件在主进程运行并拥有宿主权限；本插件的离线实现不代表宿主提供权限沙箱。

构建：`node scripts/plugin-marketplace/build.mjs`。
