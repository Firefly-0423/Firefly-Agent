"""Owned synthetic fixture authoring only; no input config, chat or credentials."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'output' / 'memory-h-quality'
OUT.mkdir(parents=True, exist_ok=True)

# Explicit manual qrels: answer, supporting context, close but wrong history.
# Four separately authored questions per category; no labels in document text/IDs.
ROWS = [
 ('entity','海棠项目的负责人是谁？','海棠项目负责人为周岚。','海棠项目六月启动。','海棠花展负责人为秦川。'),
 ('entity','青屿仓库的备份时间','青屿仓库每日凌晨二点备份。','青屿仓库保存三十天备份。','青屿办公室每日晚上九点关闭。'),
 ('entity','澄湖小组批准的数据库','澄湖小组批准使用 PostgreSQL。','澄湖小组需要关系型事务。','澄海小组批准使用 MySQL。'),
 ('entity','云杉会议室门牌号','云杉会议室门牌号是 B308。','云杉会议室可容纳十二人。','云松会议室门牌号是 B306。'),
 ('mixed','Orion_API 的 rate limit 是多少？','Orion_API rate limit 是每分钟 120 requests。','Orion_API 使用 token bucket。','Orion_UI rate limit 是每分钟 600 requests。'),
 ('mixed','Quartz_worker 处理 E_CONN_RESET 怎么办','Quartz_worker 遇到 E_CONN_RESET 后指数退避重试两次。','Quartz_worker 的连接使用 TLS。','Quartz_worker 遇到 E_AUTH_DENIED 后禁止重试。'),
 ('mixed','Aurora-CLI v2.7 Windows 编码','Aurora-CLI v2.7 Windows 输出统一 UTF-8。','Aurora-CLI v2.7 运行于 PowerShell。','Aurora-CLI v2.6 Windows 输出 GBK。'),
 ('mixed','CedarStore export_id 在哪一列','CedarStore export_id 位于 CSV 第三列。','CedarStore CSV 包含导出批次信息。','CedarStore import_id 位于 CSV 第一列。'),
 ('paraphrase','我不吃含动物成分的食物，之前约定什么餐食？','上次决定准备纯素套餐，不使用肉蛋奶。','宴会安排在下午六点。','上次决定准备荤菜套餐。'),
 ('paraphrase','那个让页面等待太久的原因是什么？','前端首屏缓慢是同步加载大图导致的。','性能分析发现主线程阻塞。','接口偶发错误由密码过期导致。'),
 ('paraphrase','有没有记录怎样避免同一笔账算两遍？','账务处理采用幂等键消除重复支付。','每笔流水都有独立交易号。','账务处理采用舍入规则保留两位小数。'),
 ('paraphrase','之前商量如何让机器断网也能查资料？','讨论决定将文档缓存到本地供离线检索。','文档索引使用 SQLite。','讨论决定把文档只保存到远程服务器。'),
 ('evolution','现在霜桥发布日是哪天？','9月18日用户更正：霜桥发布日改为10月6日，旧日期作废。','霜桥发布前需要完成验收。','9月1日霜桥发布日定为9月30日。'),
 ('evolution','栖鹭服务最新端口','后来用户确认栖鹭服务端口改为7443，代替旧端口。','栖鹭服务现在启用 HTTPS。','最初栖鹭服务端口为8080。'),
 ('evolution','墨池项目当前联系邮箱','用户最后更正墨池项目联系邮箱为 new@synthetic.invalid。','墨池项目已交接给新团队。','早期墨池项目联系邮箱为 old@synthetic.invalid。'),
 ('evolution','梧桐当前首选语言','最新确认梧桐首选语言是 Rust，撤回先前 Python 决定。','梧桐需要内存安全。','梧桐首选语言最初是 Python。'),
 ('temporal','8月初白鹭预算是多少？','8月2日白鹭预算为五万元。','8月1日白鹭预算开始讨论。','9月12日白鹭预算改为七万元。'),
 ('temporal','松涛2026年9月15日之前的版本','松涛9月10日仍使用版本1.8。','松涛版本升级在9月中旬讨论。','松涛9月20日使用版本2.0。'),
 ('temporal','今天10月2日说的昨天银沙告警原因','10月1日银沙告警原因是磁盘已满。','银沙告警按日期归档。','9月28日银沙告警原因是网线断开。'),
 ('temporal','北京时间9月9日晨间的北辰任务状态','北辰状态于2026-09-09T00:30:00Z记录为完成，时区 Asia/Shanghai。','北辰任务按 UTC 保存原始时间。','北辰状态于2026-09-09T16:30:00Z记录为失败。'),
 ('tools','lookup_inventory 查到铃兰库存多少？','user: 查铃兰库存\nassistant: 调用 lookup_inventory\ntool: 铃兰库存为42件。','铃兰库存以件为单位。','assistant: 猜测铃兰库存可能是100件，未查询。'),
 ('tools','verify_checksum 查出的琥珀文件校验结果','user: 校验琥珀文件\nassistant: 调用 verify_checksum\ntool: 琥珀文件 SHA256 匹配，校验通过。','琥珀文件由构建流程生成。','assistant: 琥珀文件应该通过校验，但尚未运行工具。'),
 ('tools','test_runner 返回的雾凇失败数','user: 运行雾凇测试\nassistant: 调用 test_runner\ntool: 雾凇 81 passed，2 failed。','雾凇测试使用本地夹具。','assistant: 预计雾凇没有失败，不是工具结果。'),
 ('tools','query_train 查出的蒲公英发车时间','user: 查蒲公英列车\nassistant: 调用 query_train\ntool: 蒲公英列车发车时间为18:45。','蒲公英列车车站在北门。','assistant: 旧时刻表显示蒲公英17:30发车。'),
 ('near-wrong','安禾个人项目的存储区域','安禾个人项目存储区域为 eu-west-1。','安禾个人项目遵循欧盟地域要求。','安禾公司项目存储区域为 us-east-1。'),
 ('near-wrong','玉衡正式环境数据库名','玉衡正式环境数据库名是 yuheng_prod。','玉衡正式环境备份已开启。','玉衡测试环境数据库名是 yuheng_test。'),
 ('near-wrong','星河账号甲绑定的设备','星河账号甲绑定设备为平板。','星河账号甲已启用双因素。','星河账号乙绑定设备为手机。'),
 ('near-wrong','北溪修复成功的措施','北溪故障最终通过更新证书修复成功。','北溪曾排查过代理设置。','北溪尝试重启服务但故障仍未修复。'),
 ('duplicate','紫苑部署需要哪些独立准备？','紫苑部署先备份数据库。','紫苑部署还需要验证证书。','紫苑部署不需要准备的说法已被否定。'),
 ('duplicate','寒露导出要核对哪些内容？','寒露导出必须核对记录数量。','寒露导出还需核对哈希摘要。','寒露导入只需检查文件名。'),
 ('duplicate','山茶安全检查包含哪两项？','山茶安全检查包含依赖漏洞扫描。','山茶安全检查还包含权限配置审查。','山茶美术检查包含配色选择。'),
 ('duplicate','远岫上线前有哪些检查？','远岫上线前检查数据恢复。','远岫上线前还要检查回滚脚本。','远岫下线后检查账单。'),
]

def doc(text, grade, group):
    return {'id':hashlib.sha256(text.encode()).hexdigest()[:20], 'text':text, 'grade':grade, 'group':group}

holdout=[]
for i,(family,q,a,s,w) in enumerate(ROWS):
    # Category appears only in external evaluation metadata, never retriever input.
    ds=[doc(a,3,'answer'),doc(s,1 if family!='duplicate' else 3,'support'),doc(w,0,'conflict')]
    ds += [doc('盆栽土壤每周补充水分。',0,'noise1'),doc('秋季摄影采用自然光。',0,'noise2'),doc('虚构小镇有一座石桥。',0,'noise3')]
    if family=='duplicate':
        ds += [doc(a+'\n'+a,3,'answer'),doc('记录复述：'+a,3,'answer'),doc(s+' 已再次确认。',3,'support')]
    holdout.append({'id':f'h{i+1:02}', 'family':family, 'query':q, 'documents':ds, 'conflictGroups':['conflict']})

dev=[]
for i,(q,a,w) in enumerate([
 ('翠竹会议地点','翠竹会议地点为东厅。','翠竹展览地点为西厅。'),
 ('VegaSocket 协议','VegaSocket 使用 TCP 协议。','VegaMonitor 使用 UDP 协议。'),
 ('如何让重复提交只执行一次','方案使用去重请求号。','方案使用文件压缩。'),
 ('当前苍耳交付日期','苍耳交付日期最终改为7月8日。','苍耳原计划7月1日交付。'),
 ('4月的桃源状态','4月桃源状态为计划中。','5月桃源状态为已完成。'),
 ('scan_disk 榛果剩余空间','tool scan_disk: 榛果剩余空间为18GB。','猜测榛果剩余空间为30GB。'),
 ('凌霄开发账号的权限','凌霄开发账号只有只读权限。','凌霄管理账号具有写入权限。'),
 ('冬青部署准备','冬青部署准备镜像和证书。','冬青部署流程还未制定。'),
]):
    dev.append({'id':f'd{i+1:02}','family':'development','query':q,'documents':[doc(a,3,'answer'),doc(w,0,'conflict')], 'conflictGroups':['conflict']})

for name,data in [('development',dev),('holdout',holdout)]:
    target=OUT/(name+'.json')
    payload=(json.dumps({'version':'history-quality-synthetic-v1','split':name,'cases':data},ensure_ascii=False,indent=2)+'\n').encode()
    if target.exists() and target.read_bytes()!=payload:
        raise RuntimeError('Frozen corpus differs: use a new version, never overwrite evaluated qrels')
    target.write_bytes(payload)
manifest={'baseHead':'0f90f6ef27f5cd771bbd7378cda75a2bf563c898','ranking':'history-ranking-v1','frozenBeforeScoring':True,'tuningPerformed':False,'labels':'single-author manual, synthetic, not a production acceptance benchmark','files':{n:hashlib.sha256((OUT/n).read_bytes()).hexdigest() for n in ['development.json','holdout.json']}}
target=OUT/'manifest.json'
payload=(json.dumps(manifest,indent=2)+'\n').encode()
if target.exists() and target.read_bytes()!=payload: raise RuntimeError('Manifest differs')
target.write_bytes(payload)
print(json.dumps(manifest))
