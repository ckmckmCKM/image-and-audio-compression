param([ValidateSet('files','folder')][string]$Kind, [string]$InitialPath = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Width = 1
$owner.Height = 1
$owner.Show()
try {
    if ($Kind -eq 'files') {
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Filter = 'Images and audio|*.png;*.jpg;*.jpeg;*.mp3;*.ogg;*.wav|Images|*.png;*.jpg;*.jpeg|Audio|*.mp3;*.ogg;*.wav'
        $dialog.Multiselect = $true
        if ($InitialPath -and (Test-Path -LiteralPath $InitialPath -PathType Container)) { $dialog.InitialDirectory = $InitialPath }
        $selected = @()
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $selected = @($dialog.FileNames) }
    } else {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.ShowNewFolderButton = $true
        if ($InitialPath -and (Test-Path -LiteralPath $InitialPath -PathType Container)) { $dialog.SelectedPath = $InitialPath }
        $selected = @()
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $selected = @($dialog.SelectedPath) }
    }
    [Console]::WriteLine((ConvertTo-Json -InputObject $selected -Compress))
    $dialog.Dispose()
} finally { $owner.Dispose() }
