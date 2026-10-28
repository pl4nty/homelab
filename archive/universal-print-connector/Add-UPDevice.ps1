[CmdletBinding()]
param (
  [ValidateSet("connector","printer")] $DeviceType,
  $DeviceName,
  $DeviceId = [guid]::NewGuid(),
  $PrinterConnectorId,
  $PFXPassword,
  $CertDistinguishedName = "CN=Microsoft, O=Microsoft Corp, L=Redmond, ST=Washington, C=US",
  $API = "https://graph.microsoft.com",
  $AuthSTS = "https://login.microsoftonline.com",
  $AuthClientId = "80331ee5-4436-4815-883e-93bc833a9a15",
  $AuthScope = "https://print.print.microsoft.com/.default+openid+profile+offline_access"
)

$API += $DeviceType -eq "connector" ? "registerConnector" : "register"
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

Write-Verbose "Generating CSR"
$privateKey = New-Object System.Security.Cryptography.RSACng(2048)
$subject = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($CertDistinguishedName)
$certReq = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest($subject, $privateKey, [System.Security.Cryptography.HashAlgorithmName]::Sha256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$csr = $certReq.CreateSigningRequest()

$body = @{
  name=$DeviceName;
  device_id=$DeviceId;
  device_type=$DeviceType;
  certificate_request=@{
    type="pkcs10";
    data=[Convert]::ToBase64String($csr);
    transport_key=[Convert]::ToBase64String($privateKey.ExportRSAPublicKey())
  }
}

$body += $DeviceType -eq "connector" ? @{
  hostname=$env:computername;
  os_version="bar";
  app_version="baz"
} : @{
  manufacturer="foo";
  model="bar"
  connector_id=$PrinterConnectorId
}

Write-Verbose "Registering device"
$connector = Invoke-RestMethod $API -Method POST -Authentication OAuth -Token $token -ContentType "application/json" -Body ($body | ConvertTo-Json)

$id = $connector.registration_id
do {
  sleep $connector.interval
  $connector = Invoke-RestMethod "$API\?registration_id=$id" -Authentication OAuth -Token $token
  Write-Verbose "Polled for registration after $($connector.interval)s"
} while ($connector.interval)

Write-Verbose "Exporting PFX"
$connector.certificate > client.cer
$privateKey.ExportRSAPrivateKeyPem() > client.key
echo $PFXPassword, $PFXPassword | certutil -f -mergepfx client.cer "certs/$DeviceType.pfx"
rm client.cer, client.key

Write-Host DeviceTokenUrl:, $connector.device_token_url
Write-Host CloudDeviceId:, $connector.cloud_device_id
