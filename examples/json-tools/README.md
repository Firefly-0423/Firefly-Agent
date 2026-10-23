# JSON 工具（json-tools）

Firefly Plugin API v1 插件，版本 1.0.0。首次安装保持停用，需要用户明确启用。

启用后提供两个只读工具。

## `json-tools_validate`

参数 `{ "text": "..." }`。返回 JSON 字符串：

```json
{ "valid": true, "type": "object" }
{ "valid": false, "reason": "syntax", "message": "..." }
{ "valid": false, "reason": "lossy", "path": "$.a[1].b", "message": "negative zero is not preserved" }
```

- `syntax`：不是合法 JSON。`message` 是引擎给出的说明，最多 300 个字符，可能包含输入片段。
- `lossy`：语法合法，但含有无法往返的数字：负零（`-0`、`-0.0`）或溢出为无穷大的数字（`1e999`）。`path` 是第一处位置，如 `$.a[1].b`、`$["odd key"]`。
- 其余数字（含 `0`、`1e-7`、`9007199254740991`）有效。不检测超过 2^53 的整数精度损失，也不检测重复键。

## `json-tools_compare`

参数 `{ "left": "...", "right": "..." }`，两段文本都必须通过上述校验，否则工具报错并指出是哪一侧。

- 忽略对象键顺序；数字按值比较（`1` 与 `1.0` 相同）；数组顺序有意义。
- 相同返回 `{ "equal": true }`；不同返回文档顺序里的第一处差异：`{ "equal": false, "difference": { "path": "$.a[2]", "kind": "value" } }`。
- `kind`：`type`（类型不同，数组与对象也算）、`value`（同类型的标量值不同）、`length`（数组长度不同，`path` 指向数组）、`missing-in-right`（键只在左侧）、`missing-in-left`（键只在右侧）。
- 对象键只按自有键比较：`toString`、`constructor`、`__proto__` 都是普通数据。

两个工具都是迭代实现，没有递归深度限制；每段文本最多 1,000,000 个字符，参数不是字符串时报错而不是隐式转换。

## 来源

“无损 JSON”规则（拒绝负零和非有限数）与按键结构比较改编自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `packages/util/values`（`isJsonValue`、`deepEqualJson`），MIT 许可，`Copyright (c) 2026 DeepSeek`。原库校验的是内存中的值；本插件先用 `JSON.parse` 解析文本，再套用同一规则。差异路径、文本入口和上述限制是 Firefly 新写的。随包 LICENSE 保留原版权声明。

## 安全

入口只做内存内计算，不联网、不读写文件、不启动命令、不使用计时器，不持久化或记录输入。停用时注销两个工具。Firefly 插件在主进程运行并拥有宿主权限；本插件的离线实现不代表宿主提供权限沙箱。

构建：`node scripts/plugin-marketplace/build.mjs`。
