param(
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$stage = Join-Path $output '.windows-staging'
$archive = Join-Path $output 'Shikigami-windows-x64.zip'

function Assert-UnderOutput([string]$candidate) {
  $full = [IO.Path]::GetFullPath($candidate)
  $prefix = $output.TrimEnd('\') + '\'
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Temporary path is outside output directory: $full"
  }
}

Assert-UnderOutput $stage
New-Item -ItemType Directory -Force -Path $output | Out-Null
if (Test-Path -LiteralPath $stage) {
  $item = Get-Item -LiteralPath $stage -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Staging folder must not be a link.' }
  Remove-Item -LiteralPath $stage -Recurse -Force
}
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Force -Path $app | Out-Null

# Only this explicit list enters the public ZIP. No host artifacts, profiles, or secrets.
Copy-Item -LiteralPath (Join-Path $projectRoot 'src') -Destination (Join-Path $app 'src') -Recurse
New-Item -ItemType Directory -Path (Join-Path $app 'scripts') | Out-Null
foreach($script in @('observe.ps1','verify-shared.mjs')) { Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\$script") -Destination (Join-Path $app "scripts\$script") }
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs') -Destination (Join-Path $app 'docs') -Recurse
foreach ($name in @('package.json', 'package-lock.json', 'LICENSE', 'README.md', 'REPORT.md', 'codex-config.example.toml')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $app $name)
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = [IO.Path]::GetFullPath($nodeCommand.Source)
$nodeVersion = & $nodePath --version
if ($LASTEXITCODE -ne 0) { throw 'Node runtime could not be checked.' }
$major = [int]([regex]::Match($nodeVersion, '^v(\d+)').Groups[1].Value)
if ($major -lt 22) { throw "Node 22+ is required; found $nodeVersion" }
$nodeLicense = Join-Path (Split-Path $nodePath) 'LICENSE'
if (-not (Test-Path -LiteralPath $nodeLicense)) { throw "Node license not found next to runtime: $nodeLicense" }
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $app 'node.exe')
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $app 'NODE-LICENSE.txt')

& npm.cmd ci --prefix $app --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed while creating the production package.' }

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler was not found.' }
$installer = Join-Path $stage 'Shikigami.exe'
$source = Join-Path $PSScriptRoot 'windows\ShikigamiInstaller.cs'
$brandImage = Join-Path $projectRoot 'src\assets\shikigami-spirit.png'
& $compiler /nologo /target:winexe /optimize+ /codepage:65001 /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll "/out:$installer" "/resource:$brandImage,ShikigamiSpirit.png" $source
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installer)) { throw 'Windows launcher compilation failed.' }

@'
SHIKIGAMI  |  Windows セットアップ

1. このZIPを任意のフォルダーにすべて展開します。
2. Shikigami.exe をダブルクリックします。
3. 「インストールする」を選ぶと、ユーザー領域へ配置されます。管理者権限は不要です。
4. 以後はスタートメニューの Shikigami から起動できます。

Google Chrome が必要です。AI専用ブラウザは非表示で動き、操作画面だけ別のChromeアプリ窓に開きます。
作業データ: %LOCALAPPDATA%\Shikigami\data
アプリ:    %LOCALAPPDATA%\Shikigami\app

アンインストールは Windows の「インストールされているアプリ」から行えます。
作業データはアンインストール時に残します。

このプレビュー版は署名されていません。ダウンロード元を確認してから実行してください。
'@ | Set-Content -LiteralPath (Join-Path $stage 'はじめに.txt') -Encoding UTF8

if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Created: $archive"
Write-Output "Node: $nodeVersion"
Write-Output "Bytes: $((Get-Item -LiteralPath $archive).Length)"
Write-Output "SHA256: $hash"
