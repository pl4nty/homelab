$ErrorActionPreference = 'Stop'
$user = '{{USER}}'
$dir = "$env:ProgramData\windows-vm-mcp"

New-Item -ItemType Directory -Force $dir | Out-Null
icacls $dir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
[IO.File]::WriteAllText("$dir\config.json", '{"url":"{{URL}}","token":"{{TOKEN}}"}')
[IO.File]::WriteAllText("$dir\Agent.cs", @'
{{AGENT}}
'@)
[IO.File]::WriteAllText("$dir\agent.ps1", @'
try {
    Add-Type -Path "$PSScriptRoot\Agent.cs" -ReferencedAssemblies System.Core, System.Drawing, System.Windows.Forms, System.Web.Extensions
} catch {
    if (Test-Path "$PSScriptRoot\Agent.cs.bak") { Move-Item -Force "$PSScriptRoot\Agent.cs.bak" "$PSScriptRoot\Agent.cs" }
    throw
}
[WindowsVmMcp.Agent]::Run($PSScriptRoot)
'@)
[IO.File]::WriteAllText("$dir\run.ps1", @'
while ($true) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PSScriptRoot\agent.ps1"
    Start-Sleep 5
}
'@)

function Set-Policy($path, $name, $value) {
    if (-not (Test-Path $path)) { New-Item -Force $path | Out-Null }
    Set-ItemProperty $path $name $value
}

$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = 'Aa1-' + [Convert]::ToBase64String($bytes)
Set-LocalUser -Name $user -Password (ConvertTo-SecureString $password -AsPlainText -Force) -PasswordNeverExpires $true

$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $winlogon AutoAdminLogon '1'
Set-ItemProperty $winlogon DefaultUserName $user
Set-ItemProperty $winlogon DefaultDomainName $env:COMPUTERNAME
Set-ItemProperty $winlogon DefaultPassword $password
Remove-ItemProperty $winlogon AutoLogonCount -ErrorAction SilentlyContinue

$system = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
Set-Policy $system ConsentPromptBehaviorAdmin 0
Set-Policy $system PromptOnSecureDesktop 0
Set-Policy $system InactivityTimeoutSecs 0
Set-Policy $system DisableCAD 1
Set-Policy 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' NoLockScreen 1
Set-Policy 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' ScreenSaveActive '0'
Set-Policy 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Server\ServerManager' DoNotOpenAtLogon 1
Set-Policy 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' HideFirstRunExperience 1
Set-Policy 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoRebootWithLoggedOnUsers 1
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0

$action = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $dir\run.ps1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$user"
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$user" -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName windows-vm-mcp -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
    shutdown.exe /r /t 15 /c windows-vm-mcp
} else {
    Start-ScheduledTask -TaskName windows-vm-mcp
}
