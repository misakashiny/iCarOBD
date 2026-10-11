<#
  serve.ps1 —— ICarUI 的**兜底**本地静态服务器（v2.90.0）

  ## 它为什么存在

  ICarUI 的硬约束是「**零安装**」：不装 Node、不装 Python、不联网。
  所以这里**不能用** `python -m http.server` / `npx serve` —— 那等于把约束破掉。
  于是用 PowerShell 自带的 `System.Net.HttpListener` 手写一个，几十行就够。

  ## ⚠️ 它只是兜底，**不是**正常用法

  平时**双击 `start-icarui.cmd` 就行**（直开 `index.html`）。

  实测（`tests/probe-file-url.js`，19 条全过）：`file://` 直开**功能完整** ——
  素材、导出（JSON / PNG / `.icarzip`）、导入（文件对话框 / 拖放）、
  `localStorage`、`showSaveFilePicker` 全部可用，console 0 报错。
  所以**没有**任何一条功能"必须走服务器"。

  那为什么还留这个脚本：`file://` 下有两类**环境相关**的差异，
  换机器 / 换浏览器 / 换安全策略时可能翻脸 —— 有个本地服务器就能立刻对照排查：

    · `fetch` / `XMLHttpRequest` 在 `file://` 下被挡（工具自己不用，但手写调试会撞上）
    · 按**路径**（不是 data URL）加载的图画进画布会**污染画布** → `toDataURL` 抛
      `SecurityError`。走 `http://127.0.0.1` 时同源，不污染。

  ## 端口

  默认 **8765**，可用参数改：`-Port 9000`。
  ⚠️ 被占时**自动往后找**（最多试 20 个），不会闷声失败，也不会写死一个端口。

  ## 怎么停

  · 在窗口里按 **Ctrl+C**（本脚本会捕获并打印一行"已停止"）
  · 或者**直接关掉那个窗口**

  跑法：

    powershell -ExecutionPolicy Bypass -File tools\icarui\serve.ps1
    powershell -ExecutionPolicy Bypass -File tools\icarui\serve.ps1 -Port 9000
    powershell -ExecutionPolicy Bypass -File tools\icarui\serve.ps1 -NoBrowser

  ⚠️ **本文件必须带 UTF-8 BOM**（含中文注释）。PowerShell 5.1 读无 BOM 的
  `.ps1` 会按 GBK 解码中文 → 吞行 → 假语法错误。`check-build-guard.ps1`
  的第 3 节机器检查着这一条。
#>
param(
    # 默认端口。被占就自动往后找 —— 见文件头「端口」。
    [int]$Port = 8765,
    # 最多往后试几个端口（8765..8784）。20 个够用，又不至于扫很久。
    [int]$MaxTries = 20,
    # 起好之后不自动开浏览器（给"只想拿个 URL 自己开"的场合）
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# ===========================================================================
# 0. 静态根目录 = 本脚本所在目录（tools/icarui/）—— **不写死盘符**
#
# ⚠️ 仓库路径里有中文与空格（`D:\AI Dsh\<CJK>\iCarOBD2`），所以下面每一处
#    路径拼接都必须带引号，且一律用 $root 派生，不做字符串替换。
# ===========================================================================
$root = $PSScriptRoot
$index = Join-Path $root 'index.html'
if (-not (Test-Path -LiteralPath $index)) {
    Write-Host "❌ 找不到 $index —— serve.ps1 必须和 index.html 放在同一个目录。" -ForegroundColor Red
    exit 1
}

# ===========================================================================
# MIME 查询 —— **做成函数，不放在顶层变量里**
#
# 为什么不是一个 `$MIME` 哈希表：
#
#   v2.90.0 实测踩到一个极其难查的 PowerShell 行为 ——
#   顶层建的 `$MIME`（20 条键）在**第一次请求处理之后**会退化成 1 个元素，
#   于是除了 `index.html`（它是靠 `/` → `/index.html` 命中的）之外，
#   `.js` / `.css` / `.png` **全部回落成 `application/octet-stream`**。
#
#   表现：服务器起来了、文件也 200、字节数也对，**只有 MIME 不对** ——
#   浏览器拿到 `application/octet-stream` 的 `.js` 会拒绝执行，
#   而控制台只会说一句含糊的 "Refused to execute script"。
#
#   修法不是"换个写法绕过去"，而是**别让它有机会变**：
#   把表放进函数体（每次调用重新建），调用方拿不到那个变量，
#   也就没有"被谁改掉"的可能。函数是纯的、无副作用、无共享状态。
#
# 表里的类型只列这个工具**真的会用**的：
#   `.js` 必须是 `text/javascript` —— 给成 `application/octet-stream`
#   时 Chrome 会拒执行（那种失败很难看懂）。
#
# ⚠️ 查表**大小写不敏感**：用 StringComparer.OrdinalIgnoreCase 建表，
#    调用方传 `.JS` 还是 `.js` 都命中（PowerShell 的 `@{}` 字面量默认
#    是**大小写敏感**的，别用 `@{}`）。
# ===========================================================================
function Get-MimeType {
    param([string]$Ext)

    $map = New-Object 'System.Collections.Hashtable' ([System.StringComparer]::OrdinalIgnoreCase)
    $map['.html'] = 'text/html; charset=utf-8'
    $map['.htm']  = 'text/html; charset=utf-8'
    $map['.js']   = 'text/javascript; charset=utf-8'
    $map['.mjs']  = 'text/javascript; charset=utf-8'
    $map['.css']  = 'text/css; charset=utf-8'
    $map['.json'] = 'application/json; charset=utf-8'
    $map['.png']  = 'image/png'
    $map['.jpg']  = 'image/jpeg'
    $map['.jpeg'] = 'image/jpeg'
    $map['.gif']  = 'image/gif'
    $map['.webp'] = 'image/webp'
    $map['.svg']  = 'image/svg+xml'
    $map['.ico']  = 'image/x-icon'
    $map['.woff'] = 'font/woff'
    $map['.woff2'] = 'font/woff2'
    $map['.ttf']  = 'font/ttf'
    $map['.txt']  = 'text/plain; charset=utf-8'
    $map['.md']   = 'text/markdown; charset=utf-8'
    $map['.icarzip'] = 'application/zip'
    $map['.zip']  = 'application/zip'

    if ($Ext -and $map.ContainsKey($Ext)) { return $map[$Ext] }
    return 'application/octet-stream'
}

# ===========================================================================
# 1. 找端口 —— 被占就往后试
#
# ⚠️ 判据是"能不能真的 Start() 起来"，不是"先 Test-NetConnection 探一下再 Start"。
#    探测与占用之间有时间窗（TOCTOU），探完再起照样可能撞。
#    直接 try Start，失败就换下一个 —— 一次系统调用定胜负。
#
# ⚠️ 前缀用 127.0.0.1 而不是 localhost / + / *：
#    · `+` 和 `*` 需要管理员权限（URL ACL），普通双击会直接抛
#      "拒绝访问" —— 那正是"零安装"最不能接受的失败方式
#    · 只绑回环地址 = 局域网里别的机器连不上，一个临时服务器没必要对外
#
# ⚠️ **循环变量绝不能叫 `$try`**（v2.90.0 实测踩到，症状极其离谱）。
#
#    `try` 是 PowerShell 的**保留关键字**。写 `$try = $Port + $i` 时解析器
#    把那一行当成 `try { … }` 语句块的**开头**，于是：
#      · **不报语法错**，脚本照跑、服务器照起、端口照样能连
#      · 但那一行**不是赋值** —— `$candidate` 从来不存在，
#        而且顶层作用域被那次"假的 try"搅乱，**后面建的顶层变量会失效**。
#
#    实测症状（就是这个脚本踩的）：`Get-MimeType` 之前那个顶层 `$MIME`
#    表（20 条键）在第一次请求处理完之后退化成 1 个元素，
#    于是 `.js` / `.css` / `.png` 全部回落成 `application/octet-stream`，
#    而 `index.html` 看起来是好的（它靠 `/` → `/index.html` 恰好命中）。
#    浏览器拿到 octet-stream 的 `.js` 会**拒绝执行**，控制台只给一句
#    含糊的 "Refused to execute script" —— 极难联想到是服务器端的问题。
#
#    两道防线：
#      ① 循环变量叫 `$candidate`，不用语言关键字当变量名
#         （`$try` / `$catch` / `$if` / `$for` … 一律不要）
#      ② MIME 表放进 `Get-MimeType` 函数体，**不存在顶层变量里** ——
#         没有变量就没有"被谁改掉"的可能（见上面那一段的说明）
#
#    验证方式：起服务器后 `curl -I http://127.0.0.1:<port>/js/app.js`，
#    `Content-Type` 必须是 `text/javascript`，不是 `application/octet-stream`。
$listener = $null
$bound = 0
$tried = New-Object System.Collections.ArrayList

for ($i = 0; $i -lt $MaxTries; $i++) {
    $candidate = $Port + $i
    [void]$tried.Add($candidate)
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://127.0.0.1:$candidate/")
    try {
        $l.Start()
        $listener = $l
        $bound = $candidate
        break
    } catch {
        # 端口被占 / 权限不足 —— 关掉这个 listener 再试下一个
        try { $l.Close() } catch { }
    }
}

if (-not $listener) {
    Write-Host "❌ $MaxTries 个端口都被占了：$($tried -join ', ')" -ForegroundColor Red
    Write-Host "   换一段再试：powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 9100" -ForegroundColor Yellow
    exit 1
}

$url = "http://127.0.0.1:$bound/index.html"
if ($bound -ne $Port) {
    Write-Host "⚠️  端口 $Port 被占，自动改用 $bound。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  ICarUI 本地服务器（兜底用）" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  根目录 : $root"
Write-Host "  地址   : $url"
Write-Host "  停止   : 在这个窗口按 Ctrl+C，或直接关掉窗口"
Write-Host ""
Write-Host "  ⚠️ 平时**双击 start-icarui.cmd 直开就行**，不用起这个服务器。" -ForegroundColor DarkGray
Write-Host "     只有在直开出问题时才用它对照排查（见 README 的「怎么启动」）。" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

if (-not $NoBrowser) {
    # 和 .cmd 那边同一个写法：空标题 + 带引号的 URL
    Start-Process $url
}

# ===========================================================================
# 2. 请求循环
#
# 同步单线程 —— 这是给一个人用的临时服务器，不值得引入线程/异步的复杂度。
# ⚠️ 每个请求都要**自己 try/catch**：一个坏请求（客户端提前断开）抛出去
#    会把整个循环干掉，表现成"服务器莫名退出"。这里选择"记一行、继续服务"。
# ===========================================================================
$stopped = $false
try {
    while ($listener.IsListening) {
        $ctx = $null
        try { $ctx = $listener.GetContext() } catch { break }   # Stop() 时这里会抛，正常退出

        try {
            $req = $ctx.Request
            $res = $ctx.Response

            # ---- 2a. URL → 磁盘路径
            $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)

            # ⚠️ 浏览器**总会**顺手要一次 /favicon.ico，而本工具没有这个文件。
            #    不特判的话服务器会回 404，浏览器控制台里就多一条
            #    "Failed to load resource: 404" —— 排查 file:// 差异时
            #    这条噪声会让人以为"起服务器反而有报错"。
            #    这里直接回 204（No Content）：合法、无内容、控制台干净。
            if ($rel -eq '/favicon.ico') {
                $res.StatusCode = 204
                $res.ContentLength64 = 0
                $res.OutputStream.Close()
                continue
            }
            if ($rel -eq '/' -or $rel -eq '') { $rel = '/index.html' }
            $rel = $rel.TrimStart('/') -replace '/', '\'

            # ⚠️ 目录穿越防护：拼出来的**绝对**路径必须仍在 $root 里面。
            #    只查"路径里有没有 .."是不够的（`%2e%2e`、8.3 短名都能绕）。
            #    这里用 GetFullPath 归一化后再比较前缀 —— 判据是**结果**，不是字面量。
            $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
            $rootFull = [System.IO.Path]::GetFullPath($root)
            $inside = $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)

            if (-not $inside) {
                $body = [System.Text.Encoding]::UTF8.GetBytes('403 forbidden')
                $res.StatusCode = 403
                $res.ContentType = 'text/plain; charset=utf-8'
                $res.ContentLength64 = $body.Length
                $res.OutputStream.Write($body, 0, $body.Length)
                Write-Host "  403 $rel" -ForegroundColor DarkYellow
            }
            elseif (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                $body = [System.Text.Encoding]::UTF8.GetBytes('404 not found: ' + $rel)
                $res.StatusCode = 404
                $res.ContentType = 'text/plain; charset=utf-8'
                $res.ContentLength64 = $body.Length
                $res.OutputStream.Write($body, 0, $body.Length)
                Write-Host "  404 $rel" -ForegroundColor DarkYellow
            }
            else {
                $ext = [System.IO.Path]::GetExtension($full)
                $mime = Get-MimeType $ext
                $bytes = [System.IO.File]::ReadAllBytes($full)
                $res.StatusCode = 200
                $res.ContentType = $mime
                $res.ContentLength64 = $bytes.Length
                # 本地开发：别让浏览器拿缓存，改了文件刷新就该看到新的
                $res.Headers['Cache-Control'] = 'no-store'
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
                Write-Host ("  200 {0,-34} {1,8:N0} B  {2}" -f $rel, $bytes.Length, $mime) -ForegroundColor DarkGray
            }
            $res.OutputStream.Close()
        } catch {
            # 单个请求失败不拖垮服务器 —— 见上面 §2 的说明
            Write-Host "  ⚠️  处理请求出错（继续服务）：$($_.Exception.Message)" -ForegroundColor DarkYellow
            try { $ctx.Response.Abort() } catch { }
        }
    }
} finally {
    $stopped = $true
    try { $listener.Stop(); $listener.Close() } catch { }
    Write-Host ""
    Write-Host "已停止（端口 $bound）。" -ForegroundColor Green
}
