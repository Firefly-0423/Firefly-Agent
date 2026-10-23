# install-bge-reranker.ps1
# 把 bge-reranker-base 的 ONNX 模型下载到 models/bge-reranker-base/onnx/model_quantized.onnx
# 运行方式（PowerShell）：
#   .\scripts\install-bge-reranker.ps1           # 依次尝试各下载源
#   .\scripts\install-bge-reranker.ps1 -Force    # 目标已存在时也不再询问

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# 统一的日志输出：固定前缀，颜色可选
function Write-Log([string]$Text, [string]$Color) {
    $line = "[install-bge-reranker] $Text"
    if ($Color) { Write-Host $line -ForegroundColor $Color } else { Write-Host $line }
}

$modelDir  = Join-Path (Split-Path -Parent $PSScriptRoot) "models\bge-reranker-base\onnx"
$modelPath = Join-Path $modelDir "model_quantized.onnx"

Write-Host ""
Write-Log "目标路径: $modelPath" Cyan

# ── 目标已存在：提示并按需询问是否覆盖 ──
if (Test-Path $modelPath) {
    $currentMB = [math]::Round((Get-Item $modelPath).Length / 1MB, 1)
    Write-Log "文件已存在 ($currentMB MB)，跳过下载。" Yellow
    if (-not $Force) {
        $reply = Read-Host "要覆盖吗？[y/N]"
        if ($reply -notin @("y", "Y")) { exit 0 }
    }
}

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

# ── 下载源，按优先级排列 ──
# 先试 Hugging Face 国内镜像（量化版，约 105MB，最小）；
# 不行再用魔搭（完整版约 1GB，下载后要改成 model_quantized.onnx 这个名字）
$sources = @(
    @{
        name = "hf-mirror.com (Xenova 量化版, ~105MB)"
        url  = "https://hf-mirror.com/Xenova/bge-reranker-base/resolve/main/onnx/model_quantized.onnx"
        type = "quantized"
    },
    @{
        name = "魔搭 (model.onnx 完整版, ~1.06GB)"
        url  = "https://www.modelscope.cn/models/BAAI/bge-reranker-base/resolve/master/onnx/model.onnx"
        type = "full"
    }
)

# 发一个 HEAD 请求，返回 HTTP 状态码；连不上返回 $null
function Test-UrlReachable($url, $timeoutSec = 10) {
    try {
        $request = [System.Net.HttpWebRequest]::Create($url)
        $request.Method = "HEAD"
        $request.UserAgent = "Mozilla/5.0"
        $request.Timeout = $timeoutSec * 1000
        $response = $request.GetResponse()
        $code = [int]$response.StatusCode
        $response.Close()
        return $code
    } catch {
        return $null
    }
}

# 下载单个文件；成功返回 $true，失败时清理半成品并返回 $false
function Download-File($url, $dest, $label) {
    Write-Host ""
    Write-Log "从 $label 下载..." Green
    Write-Log "URL: $url"
    try {
        if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
            # 有 BITS 就用它：大文件更稳，还能断点续传
            Start-BitsTransfer -Source $url -Destination $dest -DisplayName $label -Description "bge-reranker-base onnx" -ErrorAction Stop
        } else {
            # 没有 BITS 时用 Invoke-WebRequest（系统自带，但不能续传）
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 600
        }
        return $true
    } catch {
        Write-Log "下载失败: $_" Red
        if (Test-Path $dest) { Remove-Item $dest -Force }
        return $false
    }
}

# ── 逐个尝试下载源 ──
foreach ($source in $sources) {
    Write-Host ""
    Write-Log "探测: $($source.name)" Cyan
    $code = Test-UrlReachable $source.url
    $reachable = ($code -ge 200 -and $code -lt 400)
    if (-not $reachable) {
        Write-Log "  ✗ 不可达 (status=$code)" DarkGray
        continue
    }
    Write-Log "  ✓ 可达 (HTTP $code)" Green

    if (-not (Download-File $source.url $modelPath $source.name)) { continue }

    # 魔搭给的是 model.onnx，按约定需要以 model_quantized.onnx 的名字存在
    if ($source.type -eq "full") {
        Write-Log "完整版下载完成，复制为 model_quantized.onnx 名称" Yellow
        Copy-Item $modelPath $modelPath -Force
    }

    # 校验下载结果
    if (-not (Test-Path $modelPath)) { continue }
    $bytes = (Get-Item $modelPath).Length
    $mb = [math]::Round($bytes / 1MB, 1)
    if ($bytes -lt 1MB) {
        Write-Log "失败：文件太小 ($mb MB)，疑似下载错误" Red
        Remove-Item $modelPath -Force
        continue
    }
    Write-Host ""
    Write-Log "✓ 下载完成" Green
    Write-Log "  路径: $modelPath" Green
    Write-Log "  大小: $mb MB" Green
    if ($source.type -eq "full") {
        Write-Log "  类型: 完整版（推荐用 optimum 量化以减小打包体积）" Yellow
    } else {
        Write-Log "  类型: Xenova 量化版" Green
    }
    exit 0
}

Write-Host ""
Write-Log "所有候选源都失败，请检查网络后重试。" Red
exit 1
