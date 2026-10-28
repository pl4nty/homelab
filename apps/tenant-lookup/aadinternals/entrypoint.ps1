Import-Module AADInternals

$secret = ConvertTo-SecureString -AsPlainText $env:AZURE_CLIENT_SECRET
$creds = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList $env:AZURE_CLIENT_ID, $secret
Connect-MgGraph -TenantId $env:AZURE_TENANT_ID -ClientSecretCredential $creds

# DnsClient-PS doesn't support DnsOnly
function Resolve-DnsName {
  param($Name)
  $PSBoundParameters.Remove("DnsOnly")
  Resolve-Dns -Query $Name @PSBoundParameters
}

Start-PodeServer -ScriptBlock {
  New-PodeLoggingMethod -Terminal | Enable-PodeErrorLogging -Levels Error, Warning, Informational
  Add-PodeEndPoint -Address * -Port 8080 -Protocol Http

  Add-PodeRoute -Method Get -Path '/api' -ScriptBlock {

    $tenant = $WebEvent.Query['domain']

    # if a tenant ID, convert to a domain name
    if ([guid]::TryParse($tenant,[ref][guid]::Empty)) {
      $tenantInfo = Invoke-MgGraph -Method GET -Uri "beta/tenantRelationships/findTenantInformationByTenantId(tenantId='$tenant')"
      $tenant = $tenantInfo.value.defaultDomainName
    }

    $domains = Invoke-AADIntReconAsOutsider -Domain $tenant -GetRelayingParties -ErrorAction Continue
    Write-PodeJsonResponse -Value @{domains=$domains; tenant=$tenant}
  }
}