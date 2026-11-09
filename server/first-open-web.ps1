$ErrorActionPreference = 'Stop'
try {
    $output = & ssh.exe -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=yes txy-kr 'cat /srv/image-chatgpt/server/data/config/local_api.json'
    if ($LASTEXITCODE -ne 0) { throw '无法通过 txy-kr 连接服务器。' }
    $config = ($output -join "`n") | ConvertFrom-Json
    if (-not $config.api_key) { throw '服务器尚未生成访问密钥。' }
    Set-Clipboard -Value ([string]$config.api_key)
    Start-Process 'https://img.888824.xyz'
    Write-Host '首次访问密钥已复制到剪贴板。请在网页登录框粘贴，登录后设置自己的访问密码。'
    Write-Host '以后可以直接打开网页并使用你设置的密码，无需再次运行此工具。'
} catch {
    Write-Host ('无法打开网页端：' + $_.Exception.Message)
}
Read-Host '按 Enter 关闭窗口' | Out-Null
