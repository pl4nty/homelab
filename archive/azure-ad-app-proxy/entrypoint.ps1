# https://learn.microsoft.com/en-us/azure/active-directory/app-proxy/application-proxy-register-connector-powershell#register-the-connector-using-a-token-created-offline

Add-Type -Path Modules/AppProxyPSModule/Microsoft.Identity.Client.dll

$scopes = New-Object System.Collections.ObjectModel.Collection['string']
$scopes.Add('https://proxy.cloudwebappproxy.net/registerapp/user_impersonation')
$app = [Microsoft.Identity.Client.PublicClientApplicationBuilder]::Create('55747057-9b5d-4bd4-b387-abf52a8bd489').WithAuthority('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize').Build()
$password = ConvertTo-SecureString $env:PASSWORD -AsPlainText -Force
$authResult = $app.AcquireTokenByUsernamePassword($scopes, $env:USERNAME, $password).ExecuteAsync().ConfigureAwait($false).GetAwaiter().GetResult()

$token = ConvertTo-SecureString $authResult.AccessToken -AsPlainText -Force
.\RegisterConnector.ps1 -ModulePath Modules -AuthenticationMode Token -TenantId $authResult.TenantId -Token $token -Verbose

& "C:\LogMonitor\LogMonitor.exe"

# broken, grant type now requires /organization authority but it's hardcoded to /common in the DLL
# RUN powershell $password = ConvertTo-SecureString 'password' -AsPlainText -Force; \
#   $creds = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList 'UPN', $Password; \
#   .\RegisterConnector.ps1 -ModulePath Modules -AuthenticationMode Credentials -UserCredentials $Creds -Verbose

# broken, can't find required API permissions. might be delegated-only

# ENV AZURE_CLIENT_ID ""
# ENV AZURE_CLIENT_SECRET ""
# RUN powershell Add-Type -Path Modules/AppProxyPSModule/Microsoft.Identity.Client.dll; \
#   $scopes = New-Object System.Collections.ObjectModel.Collection['string']; \
#   $scopes.Add('https://proxy.cloudwebappproxy.net/registerapp/.default'); \
#   $app = [Microsoft.Identity.Client.ConfidentialClientApplicationBuilder]::Create($env:AZURE_CLIENT_ID).WithClientSecret($env:AZURE_CLIENT_SECRET).WithAuthority($env:AUTHORITY).Build(); \
#   $authResult = $app.AcquireTokenForClient($scopes).ExecuteAsync().ConfigureAwait($false).GetAwaiter().GetResult(); \
#   Write-Host (ConvertTo-Json -InputObject $authResult); \
#   $token = ConvertTo-SecureString $authResult.AccessToken -AsPlainText -Force; \
#   .\RegisterConnector.ps1 -ModulePath Modules -AuthenticationMode Token -TenantId 'tenantid' -Token $token -Verbose
