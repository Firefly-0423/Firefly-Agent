# 固定版本 Skills 获取工具

来自用户提供的 Firefly-Upstream-Reacquisition-Kit-v1.0.0.zip。原始文件、校验和及补丁保留在仓库外取证目录；本项目仅导入获取脚本、配置与测试，并记录必要的严格许可哈希适配。

脚本只获取固定提交的文件，不安装、注册、启用或执行上游代码。PDF/XLSX 候选版本只暂存比较，不自动替换当前工作流。

必须在包含当前修改的隔离项目副本中获取。脚本写入指定项目的 vendor/firefly-upstream；当前 vendor/**/* 打包规则会包含该目录，所以不得直接在正式工作目录获取。暂存材料不能进入正式快照或被扫描注册。

```powershell
python -B -m unittest discover -s scripts/packaging/upstream-skills/tests -v
python -B scripts/packaging/upstream-skills/fetch_skills.py --plan
python -B scripts/packaging/upstream-skills/fetch_skills.py --project <隔离项目绝对路径> --fetch --include-office-candidates
python -B scripts/packaging/upstream-skills/fetch_skills.py --verify <实际暂存目录>
```

工作在当前分支执行，隔离副本验证，不创建分支或 worktree。收据仅证明获取及本地字节完整性，不证明许可覆盖、宿主兼容或功能等价。

获取失败退出 1，未取得全部清单退出 2；配置路线数不是成功数。MiniMax 的 docx 独立 MIT 已按固定提交核查，使用 reviewed_license_blobs 的精确路径与 Git blob，仍拒绝未审查或哈希变化的许可。
