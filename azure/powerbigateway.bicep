param name string = 'msftlab-powerbi'
param location string = resourceGroup().location

param localAdminUsername string = 'admin-labs'
@secure()
param localAdminPassword string = 'Pasta9-Fiction-Employer'

param clusterName string = 'test-cluster'
@secure()
param recoveryKey string = 'test-cluster'

param tenantId string = tenant().tenantId
param applicationId string = '5e366d86-791e-4411-b533-218780d457e5'
@secure()
param clientSecret string = 'hrH8Q~7Ioz-CiuCBEwwoNrXDrk6cbh8BOK-wKa4q'

module vmss 'vmss.bicep' = {
  name: 'vmss-${name}'
  params: {
    name: name
    location: location
    subnet: resourceId('rg-sharedservices', 'Microsoft.Network/virtualNetworks/subnets', 'vnet-sharedservices', 'powerbi')
    localAdminUsername: localAdminUsername
    localAdminPassword: localAdminPassword
    healthSettings: {
      protocol: 'tcp'
      port: 389
    }
    // dscSettings: {
    //   ModulesUrl: 'https://github.com/joshua-a-lucas/BlueTeamLab/raw/main/scripts/Deploy-DomainServices.zip'
    //   ConfigurationFunction: 'Deploy-DomainServices.ps1\\Deploy-DomainServices'
    //   Properties: {
    //     domainFQDN: domainFQDN
    //     adminCredential: {
    //       UserName: domainAdminUsername
    //       Password: 'PrivateSettingsRef:adminPassword'
    //     }
    //   }
    // }
    // dscProtectedItems: {
    // }
  }
}

var token = listServiceSAS(resourceId('rg-sharedservices', 'Microsoft.Storage/storageAccounts', 'stcloudshellaue001'),'2022-09-01', {
  canonicalizedResource: '/blob/stcloudshellaue001/test'
  signedResource: 'c'
  signedPermission: 'racw'
  signedProtocol: 'https'
  signedExpiry: '2023-07-01T00:00:00Z'
}).serviceSasToken

resource vms 'Microsoft.Compute/virtualMachineScaleSets/virtualMachines/runCommands@2023-07-01' = {
  name: '${vmss.name}/0/install'
  dependsOn: [
    vmss
  ]
  location: location
  properties: {
    errorBlobUri: 'https://stcloudshellaue001.blob.${environment().suffixes.storage}/test/stdout.log?${token}'
    outputBlobUri: 'https://stcloudshellaue001.blob.${environment().suffixes.storage}/test/stderr.log?${token}'
    source: {
      // scriptUri: 'https://github.com/pl4nty/lab-infra/azure/raw/main/Install-PowerBIgateway.ps1'
      script: '''
      Param
      (
        [Parameter(Mandatory)] [String] $gatewayName,
        [Parameter(Mandatory)] [String] $recoveryKey,
        [Parameter(Mandatory)] [String] $tenantId,
        [Parameter(Mandatory)] [String] $applicationId,
        [Parameter(Mandatory)] [String] $ClientSecret,
      )

      iwr https://github.com/PowerShell/PowerShell/releases/download/v7.3.4/PowerShell-7.3.4-win-x64.msi -OutFile install.msi
      msiexec /package install.msi /quiet ADD_PATH=1 DISABLE_TELEMETRY=1
      rm install.msi
      pwsh -c "Install-Module -Name DataGateway; Install-DataGateway -AcceptConditions"
      pwsh -c "Connect-DataGatewayServiceAccount -TenantId $tenantId -ApplicationId $applicationId -ClientSecret $clientSecret; Add-DataGatewayCluster -Name $gatewayName -RecoveryKey $recoveryKey"
      '''
    }
    parameters: [
      {
        name: 'gatewayName'
        value: clusterName
      }
      {
        name: 'tenantId'
        value: tenantId
      }
      {
        name: 'applicationId'
        value: applicationId
      }
    ]
    protectedParameters: [
      {
        name: 'recoveryKey'
        value: recoveryKey
      }
      {
        name: 'clientSecret'
        value: clientSecret
      }
    ]
  }
}
