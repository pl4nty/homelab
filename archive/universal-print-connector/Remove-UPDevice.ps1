[CmdletBinding()]
param (
  [ValidateSet("connector","printer")] $DeviceType,
  $DeviceId,
  $API = "https://graph.microsoft.com/v1.0",
  $AuthSTS = "https://login.microsoftonline.com",
  $AuthClientId = "80331ee5-4436-4815-883e-93bc833a9a15",
  $AuthScope = "PrintConnector.ReadWrite.All Printer.FullControl.All"
)

$RedirectUri = "https://universalprintconnector/"
Write-Host "Open this URL, login, and copy the code query string parameter"
Write-Host "$AuthSTS/common/oauth2/v2.0/authorize?scope=$AuthScope&response_type=code&client_id=$AuthClientId&redirect_uri=$RedirectUri"
$code = Read-Host "Authorization code"

Write-Verbose "Requesting access token"
$res = Invoke-RestMethod "$AuthSTS/common/oauth2/v2.0/token" -Method POST -Body @{
  client_id=$AuthClientId;
  scope=$AuthScope;
  grant_type="authorization_code";
  code=$code;
  redirect_uri=$RedirectUri
}
$token = ConvertTo-SecureString $res.access_token -AsPlainText -Force

Invoke-RestMethod "$API/print/$DeviceType"+"s/$DeviceId" -Method DELETE -Authentication OAuth -Token $token
