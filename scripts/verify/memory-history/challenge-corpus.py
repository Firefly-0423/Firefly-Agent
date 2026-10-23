"""Independent synthetic H challenge authoring; no retriever import or scoring.

Frozen outputs are immutable. Any changed fixture requires a separately named
version/directory, disclosure, and fresh independent cases, never overwritten labels.
"""
import hashlib
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "output" / "memory-h-quality-next"
BASE = "dca39ae53fb0b62d102266ea75fa4d571c894982"
VERSION = "history-independent-challenge-v1"


def stamp(iso):
    return None if iso is None else int(datetime.fromisoformat(iso).timestamp() * 1000)


def message(text, iso=None, zone=None, role="user", **extra):
    return {"role": role, "text": text, "occurredAt": stamp(iso), "timeZone": zone, **extra}


def document(text, iso=None, zone=None, messages=None):
    msgs = messages if messages is not None else [message(text, iso, zone)]
    msgs = [{"id": f"m{index}", **m} for index, m in enumerate(msgs)]
    # IDs bind content/metadata, carry no family, relevance or chronological index.
    identity = json.dumps(msgs, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {"id": hashlib.sha256(identity.encode()).hexdigest()[:24],
            "text": "\n".join(m["text"] for m in msgs), "messages": msgs,
            "occurredAt": stamp(iso), "timeZone": zone}


def timed(text, day, hour="09:00:00", zone="UTC", offset="+00:00"):
    return document(text, f"2026-{day}T{hour}{offset}", zone)


cases = []


def add(family, query, rows, temporal=None, rationale="", ambiguity=None):
    ds, qrels, groups = [], [], {}
    for d, grade, group, reason in rows:
        ds.append(d)
        qrels.append({"documentId": d["id"], "grade": grade,
                      "equivalenceGroup": group, "rationale": reason})
        groups.setdefault(group, []).append(d["id"])
    c = {"id": f"c{len(cases)+1:02}", "kind": "retrieval", "family": family,
         "query": query, "documents": ds, "qrels": qrels,
         "equivalenceGroups": [{"id": g, "documentIds": ids} for g, ids in groups.items()],
         "conflictGroups": sorted({r[2] for r in rows if r[1] == 0}),
         "rationale": rationale}
    if temporal is not None:
        c["temporal"] = temporal
    if ambiguity is not None:
        c["ambiguity"] = ambiguity
    cases.append(c)


def row(text, grade, group, reason, day=None):
    return (document(text) if day is None else timed(text, day), grade, group, reason)


# New entities and wording. Both surface-form normalization and genuine semantic
# paraphrases are authored without consulting a dictionary or candidate implementation.
add("identifier-variation", "nimbus-edge 的 MAX_QUEUE_DEPTH 配置值？", [
    row("Nimbus-Edge 的 max_queue_depth 设置为 384。", 3, "queue", "同一产品/参数，仅英文大小写不同。"),
    row("Nimbus-Edge 的 max_batch_depth 设置为 48。", 0, "batch", "相似参数不等于请求参数。"),
    row("Nimbus-Edge 的队列在入口侧限流。", 1, "context", "队列背景，不提供数值。")])
add("identifier-variation", "Ｏｐａｌ＿Ｓｙｎｃ ＲＥＴＲＹ＿ＣＡＰ是多少？", [
    row("Opal_Sync RETRY_CAP = 4。", 3, "cap", "全角输入与半角原标识一致。"),
    row("Opal_Sync TIMEOUT_CAP = 14。", 0, "timeout", "后缀接近但参数不同。"),
    row("Opal_Pull RETRY_CAP = 9。", 0, "product", "其他组件的同名参数。")])
add("identifier-variation", "KestrelDB /auditTrail 端点保留几天？", [
    row("KestrelDB 的 /auditTrail 留存期限为 17 天。", 3, "retention", "完整大小写路径应得到目标证据。"),
    row("KestrelDB 的 /audit_trail 留存期限为 71 天；这是另一个端点。", 0, "path", "不得把标点差异一律当等价。"),
    row("KestrelDB 审计数据按日分区。", 1, "context", "相关上下文，不是天数。")])
add("lexical-variation", "菱角计划的交付窗口定在几时？", [
    row("菱角计划约定的交付时段是晚上八点至九点。", 3, "window", "窗口/时段、几时/时间表达变换。"),
    row("菱角计划的讨论会在下午两点。", 0, "meeting", "会议时间不是交付时间。"),
    row("菱角计划交付由值班组执行。", 1, "context", "提供交付背景。")])
add("lexical-variation", "苍穹索引存放在哪个目录？", [
    row("苍穹检索索引的保存位置是 E:/synthetic/azimuth-index。", 3, "path", "存放/保存位置等价。"),
    row("苍穹检索日志保存位置是 E:/synthetic/azimuth-log。", 0, "log", "日志目录不是索引目录。"),
    row("苍穹索引采用每日增量更新。", 1, "context", "相关维护背景。")])
add("identifier-variation", "Tern-Bridge 的 E_PIPE_CLOSED 最后怎么处理？", [
    row("Tern-Bridge 遇到 E_PIPE_CLOSED 时重新打开通道，再重送未确认片段。", 3, "repair", "错误标识完全一致。"),
    row("Tern-Bridge 遇到 E_PIPE_CLOSE 时直接取消任务。", 0, "error", "相差一字符的错误不得混同。"),
    row("Tern-Bridge 通过序号跟踪片段确认。", 1, "context", "关联修复背景。")])

for query, answer, context, wrong, reason in [
    ("之前给那个没人值守还会自己把任务跑完的办法起了什么名字？", "当时采用无人值守的批处理调度器。", "夜间任务完成后只发送汇总通知。", "当时要求每一步都等待操作员确认。", "自动执行/无人值守/调度器的概念改写，不依赖共享实体名。"),
    ("那份出错也能回到修改前样子的安排叫什么？", "方案采用事务回滚，失败后撤销本次全部变更。", "变更仅在验证成功后提交。", "方案允许失败后保留已写入的一半变更。", "口语复原请求对应事务回滚。"),
    ("上次怎样安排看不见屏幕的人也能操作表单？", "表单为屏幕阅读器添加可访问标签，并提供键盘导航。", "提交按钮有清晰的文本名称。", "表单把所有字段说明改成图片。", "视障操作需求对应可访问标签/键盘导航。"),
    ("断电再开机，还能从停住的地方接着做的办法呢？", "任务将进度保存为检查点，重启后恢复执行。", "每处理一百条记录保存一次进度。", "任务重启后丢弃进度并从头执行。", "停点续做对应持久检查点恢复。"),
    ("我们怎样确保一个部门的人看不到另一部门的记录？", "记录检索在授权域内分区，按租户隔离。", "权限检查先于读取数据。", "把所有部门记录放在同一公开查询结果中。", "部门间不可见对应授权分区/租户隔离。"),
    ("先把坏版本换回上一份能工作的，是哪种处理？", "发布故障时执行版本回退，恢复上一版构建。", "部署保留上一版构建清单。", "发布故障时继续追加未经测试的新改动。", "口语故障恢复对应版本回退。"),
]:
    add("semantic-paraphrase", query, [row(answer, 3, "answer", reason), row(context, 1, "context", "独立支持背景。"), row(wrong, 0, "conflict", "与用户描述目标相反。")], rationale="允许默认词法路径无法召回；不可据此改写题目或注入同义词。")

latest = {"kind": "latest"}
add("explicit-latest", "现在赤陶试点最终确认的容量是多少？", [
    row("赤陶试点容量改为 640 席，替代最初的 320 席。", 3, "current", "较新的明确同主体更新。", "08-18"),
    row("赤陶试点最初容量定为 320 席。", 0, "old", "已被后续更新替代。", "08-03"),
    row("赤陶试验厅容量定为 960 席。", 0, "near", "更新更晚却不是同一主体。", "09-06")], latest, "H 最新历史证据，不产生 confirmedM 或事实承诺。")
add("explicit-latest", "请找海镜任务最近一次确定的执行方式。", [
    row("海镜任务执行方式改为串行，撤销先前并行安排。", 3, "current", "明确较晚安排。", "09-12"),
    row("海镜任务执行方式定为并行。", 0, "old", "旧安排已撤销。", "09-05"),
    row("海镜任务安排：执行方式可能是分批；原始时间未记录。", 1, "unknown", "相关未知时间证据不能证明比已知时间更新。")], latest, "未知时间保持未知，不能用导入时间取代。")
add("explicit-latest", "罗盘芯当前选用哪种颜色？只看最后的选择。", [
    row("罗盘芯最后选择是琥珀色，取消蓝灰色。", 3, "current", "当前目标选择。", "09-19"),
    row("罗盘芯之前选择蓝灰色。", 0, "old", "历史旧选择。", "09-17"),
    row("罗盘壳选择蓝灰色。", 0, "near", "更晚近的相似实体。", "09-22")], latest)
add("explicit-latest", "暮帆部署最近那次改用什么平台？", [
    row("暮帆部署改用 FreeBSD，之前的 Linux 方案结束。", 3, "current", "最近部署变更。", "09-24"),
    row("暮帆部署采用 Linux。", 0, "old", "被替代的旧方案。", "09-11"),
    row("暮帆试验环境最近采用 Linux。", 0, "near", "不同环境的更晚记录。", "09-27")], latest)
add("explicit-latest", "现在环礁工单的上限到底是 12 还是 21？", [
    row("环礁工单上限改为 21，撤回 12 的决定。", 3, "current", "明确最新更正。", "09-26"),
    row("环礁工单上限为 12。", 0, "old", "旧值。", "09-08"),
    row("环礁工单上限据说为 12，但消息没有原始时间。", 1, "unknown", "未知时点传闻不能覆盖已知更正。")], latest)


def interval(a, b):
    return {"kind": "range", "from": stamp(a), "to": stamp(b)}


add("historical-range", "2026年7月4日 UTC 当天，玉盘预算定了多少？", [
    row("玉盘预算定为 28 万元。", 3, "dated", "明确指定日内证据。", "07-04"),
    row("玉盘预算改为 52 万元。", 0, "newer", "区间外较新证据。", "08-04"),
    row("玉盘预算曾讨论为 28 万元，原始时间未知。", 0, "unknown", "不能证明位于要求日期。")], interval("2026-07-04T00:00:00+00:00", "2026-07-04T23:59:59.999+00:00"))
add("historical-range", "北京时间2026年8月16日08:00到09:00，晨钟队报告什么状态？", [
    (document("晨钟队报告已就绪。", "2026-08-16T00:30:00+00:00", "Asia/Shanghai"), 3, "in", "UTC 时刻为北京时间 08:30。"),
    (document("晨钟队报告未就绪。", "2026-08-16T08:30:00+00:00", "Asia/Shanghai"), 0, "out", "相同数字钟面但实际为北京时间16:30。"),
    row("晨钟队状态更新时间未知。", 0, "unknown", "不推测时间。")], interval("2026-08-16T08:00:00+08:00", "2026-08-16T09:00:00+08:00"))
add("historical-range", "纽约时间2026年8月10日09:00到10:00，黑麦任务重试几次？", [
    (document("黑麦任务重试 6 次。", "2026-08-10T13:20:00+00:00", "America/New_York"), 3, "in", "明确时区换算到纽约09:20。"),
    (document("黑麦任务重试 2 次。", "2026-08-10T09:20:00+00:00", "UTC"), 0, "out", "UTC09:20不在指定纽约时间区间。"),
    row("黑麦任务重试次数不固定。", 0, "unknown", "没有已知日期。")], interval("2026-08-10T09:00:00-04:00", "2026-08-10T10:00:00-04:00"))
add("historical-range", "2026年9月2日 UTC 12:00至12:05那段端午台讨论的结果？", [
    (document("", messages=[message("端午台评审开始。", "2026-09-02T11:59:00+00:00", "UTC"), message("端午台结果：暂缓发布。", "2026-09-02T12:06:00+00:00", "UTC", "assistant")]), 3, "span", "完整回合跨度覆盖请求区间，即使两个端点均在区间外。"),
    (document("", messages=[message("端午台评审开始。", "2026-09-02T12:06:01+00:00", "UTC"), message("端午台结果：批准发布。", "2026-09-02T12:10:00+00:00", "UTC", "assistant")]), 0, "out", "整个回合在区间外。")], interval("2026-09-02T12:00:00+00:00", "2026-09-02T12:05:00+00:00"), "历史匹配基于已知消息的整个回合跨度；返回完整消息，不截掉区间外端点。")
add("historical-range", "2026年9月7日 UTC 15:00到15:10之间，回声柜的 inspect_slots 结果？", [
    (document("", messages=[message("查询回声柜。", "2026-09-07T14:59:00+00:00", "UTC"), message("运行 inspect_slots。", "2026-09-07T15:03:00+00:00", "UTC", "assistant", toolCallIds=["slots-73"]), message("inspect_slots: 回声柜空位为 73。", "2026-09-07T15:11:00+00:00", "UTC", "tool", toolCallId="slots-73")]), 3, "tool-span", "回合相交且调用/结果必须完整返回。"),
    row("inspect_slots: 回声柜空位为 37。", 0, "other-day", "另一日的近似值。", "09-08")], interval("2026-09-07T15:00:00+00:00", "2026-09-07T15:10:00+00:00"))
add("historical-range", "只查2026年9月13日 UTC 的风车架检查记录。", [
    (document("", messages=[message("风车架检查完成。", "2026-09-13T10:00:00+00:00", "UTC"), message("风车架检查发现两处松动。", None, None, "assistant")]), 3, "mixed", "已知消息在区间内；未知消息保留原始null，无时间推断。"),
    (document("", messages=[message("风车架检查没有松动。"), message("风车架检查再次确认。", role="assistant")]), 0, "unknown", "全部未知时间不能认证历史区间。"),
    row("风车架检查发现三处松动。", 0, "outside", "已知区间外。", "09-14")], interval("2026-09-13T00:00:00+00:00", "2026-09-13T23:59:59.999+00:00"))
add("historical-range", "2026年9月21日 UTC 10:00:00至10:01:00，丹炉的阀门记录？", [
    (document("丹炉阀门关闭。", "2026-09-21T10:00:00+00:00", "UTC"), 3, "start", "闭区间起点。"),
    (document("丹炉阀门开启。", "2026-09-21T10:01:00+00:00", "UTC"), 3, "end", "闭区间终点，不同操作不等价。"),
    (document("丹炉阀门再次关闭。", "2026-09-21T10:01:00.001+00:00", "UTC"), 0, "outside", "终点后1毫秒。")], interval("2026-09-21T10:00:00+00:00", "2026-09-21T10:01:00+00:00"))

add("ambiguous-no-temporal", "砂湾机组的转速设定是什么？", [
    row("砂湾机组转速设定为 1400 rpm。", 3, "earlier", "一种明确历史设定。", "07-12"),
    row("砂湾机组转速改为 1800 rpm。", 3, "later", "另一种明确历史设定，应带时间呈现。", "09-12"),
    row("砂湾风扇转速设定为 1800 rpm。", 0, "near", "不同设备。", "09-14")], ambiguity="未指定当前或过去；保留两种带日期的H证据，不自动生成latest意图。")
add("ambiguous-no-temporal", "帮我找月窑那次改期的记录。", [
    row("月窑展出从7月9日改到7月16日。", 3, "first", "符合改期描述的第一事件。", "06-21"),
    row("月窑展出从7月16日改到8月3日。", 3, "second", "符合改期描述的第二事件。", "07-02"),
    row("月窑维护从9月2日改到9月5日。", 1, "other", "主题相关但不同事件，辅助消歧。", "08-22")], ambiguity="那次未指定日期，不能编造绝对区间。")
add("ambiguous-no-temporal", "雪翎配额之前是怎么说的？", [
    row("雪翎配额定为每人 7 单。", 3, "first", "明确历史说法。", "05-19"),
    row("雪翎配额调整为每人 11 单。", 3, "second", "另一历史说法。", "08-19"),
    row("雪翎配额的讨论没有原始时间，提到每人 9 单。", 1, "unknown", "相关未知时点证据，需披露未知。")], ambiguity="之前没有绝对边界，不设置temporal字段。")


def toolturn(name, entity, result, call):
    return document("", messages=[message(f"请运行 {name} 检查{entity}。"),
        message(f"调用 {name}。", role="assistant", toolCallIds=[call]),
        message(result, role="tool", toolCallId=call)])


add("tool-pair", "probe_routes 返回栈桥路由的哪条失效？", [
    (toolturn("probe_routes", "栈桥路由", "probe_routes: 栈桥路由 R17 失效，R71 正常。", "route-8"), 3, "tool", "真正工具结果与完整调用配对。"),
    row("栈桥路由可能是 R71 失效，尚未运行 probe_routes。", 0, "guess", "工具未执行的猜测。"),
    (toolturn("probe_routes", "渡口路由", "probe_routes: 渡口路由 R17 失效。", "route-9"), 0, "near", "不同实体的真实工具结果。")])
add("tool-pair", "check_manifest 查到盘石构建缺哪个条目？", [
    (toolturn("check_manifest", "盘石构建", "check_manifest: 盘石构建缺少 assets/icon.svg。", "manifest-6"), 3, "tool", "工具证据。"),
    row("盘石构建猜测缺少 assets/index.svg，尚未校验。", 0, "guess", "相似路径猜测。"),
    row("盘石构建清单应包含静态资源。", 1, "context", "清单背景。")])
add("tool-pair", "count_ledger 查到雁塔账本几条撤销？", [
    (toolturn("count_ledger", "雁塔账本", "count_ledger: 雁塔账本有 19 条撤销、91 条完成。", "ledger-5"), 3, "tool", "真实工具计数。"),
    row("雁塔账本预计有 91 条撤销、19 条完成；没有运行工具。", 0, "swap", "互换计数且未运行。"),
    row("雁塔账本按状态统计。", 1, "context", "有关计数背景。")])

add("nonduplicate-conflicts", "列出天幕许可证在2026年6月8日与6月18日两次的额度。", [
    row("天幕许可证额度为 64。", 3, "june8", "日期不同的独立历史事实。", "06-08"),
    row("天幕许可证额度为 64。", 3, "june18", "文本相同但原始日期不同，不能删掉第二次。", "06-18"),
    row("天幕许可证额度为 46。", 0, "other", "非请求日期。", "06-28")])
add("nonduplicate-conflicts", "对照霁岚两次测试：一次是通过8失败2，另一次通过2失败8。", [
    row("霁岚测试结果：通过 8，失败 2。", 3, "first", "第一独立计数结果。", "08-05"),
    row("霁岚测试结果：通过 2，失败 8。", 3, "second", "相同词集合但数字角色不同，不能去重。", "08-06"),
    row("霁岚测试结果：通过 8，失败 8。", 0, "wrong", "请求描述之外的计数。", "08-07")])
add("nonduplicate-conflicts", "找春铎流程中先验签再解包与禁止先解包再验签的两条说明。", [
    row("春铎流程必须先验签，再解包。", 3, "positive", "明确允许操作顺序。"),
    row("春铎流程禁止先解包，再验签。", 3, "negative", "否定及顺序携带独立安全含义，不能词集合去重。"),
    row("春铎流程必须先解包，再验签。", 0, "unsafe", "逆向操作，不是请求证据。")])
add("equivalent-duplicates", "瓷舟上线的两项必要准备是什么？", [
    row("瓷舟上线需要验证恢复备份。", 3, "restore", "第一项。"),
    row("瓷舟上线需要验证恢复备份。\n瓷舟上线需要验证恢复备份。", 3, "restore", "同一事实重复叙述，不增加独立召回。"),
    row("确认：瓷舟上线需要验证恢复备份。", 3, "restore", "相同事实改写。"),
    row("瓷舟上线还需要演练流量切换。", 3, "traffic", "独立第二项，不能被重复挤出。"),
    row("瓷舟上线只需修改欢迎页。", 0, "wrong", "错误近似准备。")])
add("equivalent-duplicates", "澜石验收要核对哪两种数值？", [
    row("澜石验收核对总记录数。", 3, "count", "数值检查一。"),
    row("再次记下：澜石验收核对总记录数。", 3, "count", "同事实复述。"),
    row("澜石验收核对总记录数。\n重复提醒核对总记录数。", 3, "count", "同事实重复。"),
    row("澜石验收还核对损坏页数。", 3, "damage", "独立数值检查二。"),
    row("澜石设计核对页面宽度。", 0, "wrong", "另一任务。")])
add("equivalent-duplicates", "螺纹发布要求保存哪些独立材料？", [
    row("螺纹发布保存签名清单。", 3, "signed", "第一材料。"),
    row("复述：螺纹发布保存签名清单。", 3, "signed", "重复事实。"),
    row("螺纹发布保存签名清单。\n螺纹发布保存签名清单。", 3, "signed", "重复事实。"),
    row("螺纹发布保存回退操作记录。", 3, "rollback", "第二材料。"),
    row("螺纹发布保存签名清单的旧截图而不保留原文件。", 0, "wrong", "不等价材料。")])

# Main oracles describe required externally observed outcomes. They are NOT
# relevance grades, not runnable claims, and must not be folded into Recall/nDCG.
scenarios = [
    {"id": "s01", "kind": "main-safety-scenario", "family": "scope-isolation",
     "setup": "创建两个owned synthetic scope，使用相同actor/provider/session显示名称；只为scope甲授权H查询。",
     "actions": ["scope乙保存与查询精确匹配的历史。", "scope甲保存较弱相关历史。", "从scope甲查询并准备S证据。"],
     "oracle": ["scope乙provider读取、解密、候选、词统计、向量输入及返回数量均不得发生。", "返回与评分仅来自scope甲；scope乙操作不得破坏原scope甲证据授权。"],
     "rationale": "同名actor不能跨scope放大身份；不能仅过滤最终hits。"},
    {"id": "s02", "kind": "main-safety-scenario", "family": "session-provider-isolation",
     "setup": "同一scope/actor拥有会话甲、乙及provider丙；默认cap只授权当前甲。",
     "actions": ["乙和丙放入精确匹配文档。", "默认cap查询。", "使用Main明确授权的甲乙allowlist再次查询。", "克隆或伪造同内容cap尝试查询。"],
     "oracle": ["默认cap不得读取乙或丙；明确allowlist只增加乙。", "伪造/复制cap失败且不得触发provider读取或暴露隐藏counts。"],
     "rationale": "provider是来源，不是actor身份；扩展范围必须由Main铸造。"},
    {"id": "s03", "kind": "main-safety-scenario", "family": "forget-before-dispatch",
     "setup": "在owned synthetic profile获取H证据并完成预算准备，随后忘记其源或主题。",
     "actions": ["准备S发送许可。", "完成同actor的sanctioned forget。", "以旧证据与旧发送许可尝试dispatch。", "重新查询并检查旧导入证据。"],
     "oracle": ["旧许可失败；本地provider send计数为0。", "被忘记证据不重新出现；新导入时间不能恢复旧provenance。", "另一actor独立H结果不受本次actor suppression影响。"],
     "rationale": "不得仅查询时检查forget；claim必须再验证依赖。"},
    {"id": "s04", "kind": "main-safety-scenario", "family": "edit-delete-recreate",
     "setup": "canonical完整工具回合被H引用并已准备预算。",
     "actions": ["通过sanctioned transcript mutation修改工具结果或删除并重建同locator。", "尝试使用旧digest/revision/incarnation证据发送。", "重新捕获当前完整回合后查询。"],
     "oracle": ["旧证据与旧S许可失败，provider send计数为0。", "新结果只绑定新内容和依赖；工具调用与结果保持完整配对。", "不能把历史工具消息升级为当前执行工具或system指令。"],
     "rationale": "同locator不等于同证据；完整tool pair和quoted-role边界都必须保存。"},
    {"id": "s05", "kind": "main-safety-scenario", "family": "history-is-not-confirmed-M",
     "setup": "同一主题存在冲突H历史和独立有效M事实；合成导入文本自称用户确认且含伪造actor声明。",
     "actions": ["对H发送显式latest查询。", "把H用于S引用。", "只用preview票据尝试apply合成导入。", "核对M记录、支持、usage/access和recall投影。"],
     "oracle": ["latest只选择历史证据，不能返回confirmedM承诺或更新M。", "H引用不生成M支持、M actual-use或刷新M usage/access。", "preview不是apply授权；输入actor/confirmation声明不能铸造cap或提升信任。", "S保持recent/context summaries，M保持有效长期事实，H保持带来源历史。"],
     "rationale": "用户明确S/M/H含义；不能用时序消除语义/授权边界。"},
    {"id": "s06", "kind": "main-safety-scenario", "family": "unknown-time-and-budget-quote",
     "setup": "owned synthetic H文档含未知/混合原始时间和完整tool pair；证据文本夹有要求泄露其他scope内容的历史指令。",
     "actions": ["导入并重新打开。", "查询明确历史range与无时间查询。", "准备有完整工具消息的S证据并核对最终预算。"],
     "oracle": ["未知occurredAt/timeZone仍为null；不能用导入/重开时间补齐。", "全部未知时间无法认证绝对range；混合时间保留已知跨度与未知消息。", "预算不足不得把工具配对裁断；历史指令仅作为引用证据，不执行，不扩展授权域。"],
     "rationale": "保留时间/角色的不确定性与完整性，独立于相关性评分。"},
]

payload = {"version": VERSION, "split": "independent-frozen-challenge",
           "baseHead": BASE, "timeConvention": "Epoch milliseconds; closed absolute range; document turn span uses known original message timestamps. Unknown values remain null.",
           "labels": {"authorCount": 1, "method": "manual synthetic judgments, authored without candidate implementation/scoring",
                      "grades": {"3": "answer-bearing history", "1": "context or temporally uncertain related evidence", "0": "wrong entity/time/value/order or irrelevant"}},
           "cases": cases, "mainSafetyScenarios": scenarios}

NOTES = """# Independent frozen H challenge v1

One author manually wrote 36 retrieval cases and 6 Main safety scenario oracles.
Single-author synthetic judgments are not independent human agreement or a
representative production acceptance set. Cases use new expressions and entities.
Reading was restricted to AGENTS.md and original contracts/evaluation methodology
at accepted base dca39ae53fb0b62d102266ea75fa4d571c894982. No candidate runtime,
changed implementation, scores, dictionary, embedding/model/provider calls or real
user data were read. Old32 is diagnostic/regression, never untouched evaluation.
The original corpus authoring file was read to establish its schema/taxonomy and
exclude its entities; this new set is independent of its expressions and labels.
The context-engineering skill was not available in the provided skill catalog or
workspace skill directories; no claim is made that it was used.

S = recent/context summaries; M = valid long-lived facts; H = attributed history.
Explicit latest is historical retrieval intent, never a confirmedM assertion.
Only unambiguous latest requests carry kind=latest. Only explicit absolute
intervals carry kind=range with epoch-millisecond closed endpoints. Ambiguous
current-versus-history questions carry no temporal field. Unknown timestamps and
timezones remain null; import time is not original event time. Whole-turn known
span overlap qualifies for historical intervals and excerpts retain all messages,
including outside-window endpoints and complete assistant tool calls/results.
Metadata-unknown documents are not assigned synthetic original timestamps.

Qrels and equivalence groups are outside retriever inputs. Feed only id/text,
messages, original metadata and explicitly authored temporal intent to retrieval.
Case-local corpora are synthetic; no semantic embedding quality is implied.
Measure group-aware Recall/nDCG at 1/3/8, duplicate exposure, top1 grade3 and
conflict exposure separately using the original metric conventions. Positive
grade1 context counts toward Recall, not answer correctness. Repeated groups
consume ranks with no added gain. Empty positive results are scored as failures.
Different dates, numbers, negation or operation order have independent groups;
surface term equality alone cannot merge them. All zero-grade groups are listed
as conflictGroups for deterministic exposure reporting; inspect family/rationale
when distinguishing a dangerous contradiction from an unrelated near-match.
Do not silently omit rejected documents or rewrite the positive denominator.
Main safety scenarios are definitions to implement against authorized synthetic
Main seams; they have no ranking qrels and must remain separate from relevance
averages. Their presence is not evidence that any safety scenario has passed.

Freeze precedes all scoring. The script checks all existing output bytes before
writing anything and refuses differing fixtures/manifests/notes. Manifest SHA256
binds fixture, script and notes; report its hash with every scoring result. Scores
are not produced here. Never change an exposed fixture to improve results: make
fresh independently authored cases, a new version/directory and disclose reuse.
Determinism/integrity validation may be repeated without testing a retriever.
All writes are restricted to owned E: paths; no commit, push, merge, credentials,
userData, downloads, external application save or production activation.
"""


def encoded(data):
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def validate():
    assert len(cases) == 36 and len(scenarios) == 6
    assert len({c["id"] for c in cases + scenarios}) == 42
    for c in cases:
        ids = [d["id"] for d in c["documents"]]
        assert len(ids) == len(set(ids))
        assert {q["documentId"] for q in c["qrels"]} == set(ids)
        assert any(q["grade"] == 3 for q in c["qrels"])
        assert all(q["grade"] in (0, 1, 3) and q["rationale"] for q in c["qrels"])
        assert set(ids) == {i for g in c["equivalenceGroups"] for i in g["documentIds"]}
        if "temporal" in c:
            t = c["temporal"]
            assert t == {"kind": "latest"} or (set(t) == {"kind", "from", "to"} and t["kind"] == "range" and isinstance(t["from"], int) and t["from"] <= t["to"])
        if c["family"] == "ambiguous-no-temporal":
            assert "temporal" not in c
        for d in c["documents"]:
            assert d["text"] == "\n".join(m["text"] for m in d["messages"])
            calls = [i for m in d["messages"] for i in m.get("toolCallIds", [])]
            results = [m["toolCallId"] for m in d["messages"] if m["role"] == "tool"]
            assert sorted(calls) == sorted(results)
            for m in d["messages"]:
                assert m["occurredAt"] is None or isinstance(m["occurredAt"], int)
                assert "timeZone" in m


def main():
    assert str(ROOT).lower().startswith("e:\\codex\\2026-10-01\\task\\")
    validate()
    files = {OUT / "challenge.json": encoded(payload), OUT / "AUTHOR-NOTES.md": NOTES.encode("utf-8")}
    manifest = {"version": VERSION, "baseHead": BASE, "frozenBeforeScoring": True,
                "candidateImplementationRead": False, "retrieverScoringPerformed": False,
                "authorCount": 1, "retrievalCases": len(cases), "mainSafetyScenarios": len(scenarios),
                "caseCount": len(cases) + len(scenarios),
                "familyCounts": {family: sum(c["family"] == family for c in cases) for family in sorted({c["family"] for c in cases})},
                "files": {"challenge.json": hashlib.sha256(files[OUT / "challenge.json"]).hexdigest(),
                          "AUTHOR-NOTES.md": hashlib.sha256(files[OUT / "AUTHOR-NOTES.md"]).hexdigest(),
                          "../../scripts/verify/memory-history/challenge-corpus.py": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}}
    files[OUT / "manifest.json"] = encoded(manifest)
    # Preflight the entire set before any write: partial overwrite is forbidden.
    for path, data in files.items():
        if path.exists() and path.read_bytes() != data:
            raise RuntimeError(f"Frozen file differs: {path.name}; use a fresh version/directory")
    OUT.mkdir(parents=True, exist_ok=True)
    for path, data in files.items():
        if not path.exists():
            with path.open("xb") as handle:
                handle.write(data)
    print(json.dumps({"caseCount": manifest["caseCount"], "retrievalCases": len(cases),
                      "mainSafetyScenarios": len(scenarios),
                      "manifestSHA256": hashlib.sha256(files[OUT / "manifest.json"]).hexdigest()}))


if __name__ == "__main__":
    main()
