# 文本统计（text-stats）

Firefly Plugin API v1 插件，版本 1.0.0。首次安装保持停用，需要用户明确启用。

启用后可让 Firefly 使用 `text-stats_count` 工具统计给定文本，例如：

```json
{ "text": "Hello 世界\n第二行" }
```

返回 JSON 字符串：

```json
{ "characters": 12, "words": 3, "nonEmptyLines": 2 }
```

统计口径：

- `characters`：Unicode 码点数，包含空格、制表符、回车和换行。一个普通表情通常算一个码点；组合字符、肤色修饰符和家庭表情可能含多个码点。这不是 UTF-16 长度或视觉字形数。
- `words`：按 JavaScript Unicode 空白分隔的非空片段数。连续中文不做自然语言分词，标点和表情不会单独过滤。
- `nonEmptyLines`：去掉首尾空白后仍有内容的行数；支持 LF、CRLF、CR、Unicode 行分隔符和段分隔符。
- 空字符串返回三个零；非字符串参数报错，不隐式转换。

入口只进行内存内计算，不联网、不读写文件、不启动命令、不持久化或记录输入文本。停用时注销工具；没有计时器、窗口或后台任务。工具本身不保存输入，但宿主可能按其正常会话规则记录工具调用。

插件按 MIT 许可证提供，见随包的 LICENSE。Firefly 插件在主进程运行并拥有宿主权限；本插件的离线实现不代表宿主提供权限沙箱。

仓库内构建：`node scripts/plugin-marketplace/build.mjs`。输出 ZIP 可从聊天窗口的插件面板导入；离线随附市场也使用同一个 ZIP。构建不会发布公共目录或上传文件。
