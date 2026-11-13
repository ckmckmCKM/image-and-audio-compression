$ErrorActionPreference = 'Stop'
$toolRoot = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $toolRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { throw '运行文件缺失，请保留完整工具目录。' }
$serverPath = Join-Path $toolRoot 'server.cjs'
$quotedServerPath = '"' + $serverPath + '"'
Start-Process -FilePath $nodePath -ArgumentList @($quotedServerPath, '--open') -WorkingDirectory $toolRoot -WindowStyle Hidden
