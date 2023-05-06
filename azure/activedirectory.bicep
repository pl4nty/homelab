param name string = 'msftlab-activedirectory'
param location string = resourceGroup().location

param sku string = 'Standard_B2s'
param subnet string = '/subscriptions/0564a0a2-a720-4b20-ae93-91af70171c2d/resourceGroups/rg-sharedservices/providers/Microsoft.Network/virtualNetworks/vnet-sharedservices/subnets/activedirectory'

param localAdminUsername string = 'admin-labs'
@secure()
param localAdminPassword string = 'Pasta9-Fiction-Employer'
param domainAdminUsername string = 'admin-labs'
@secure()
param domainAdminPassword string = 'Pasta9-Fiction-Employer'
param domainFQDN string = 'corp.axsymlabs.au'

resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2023-03-01' = {
  name: 'vmss-${name}'
  location: location
  sku: {
    name: sku
    capacity: 1
  }
  properties: {
    orchestrationMode: 'Flexible'
    platformFaultDomainCount: 2
    virtualMachineProfile: {
      networkProfile: {
        networkApiVersion: '2022-09-01'
        networkInterfaceConfigurations: [
          {
            name: 'nic-${name}'
            properties: {
              // enableAcceleratedNetworking: true
              ipConfigurations: [
                {
                  name: 'v4'
                  properties: {
                    subnet: {
                      id: subnet
                    }
                  }
                }
                {
                  name: 'v6'
                  properties: {
                    subnet: {
                      id: subnet
                    }
                    privateIPAddressVersion: 'IPv6'
                    publicIPAddressConfiguration: {
                      name: 'pip-${name}-v6'
                      sku: {
                        name: 'Standard'
                      }
                      properties: {
                        publicIPAddressVersion: 'IPv6'
                      }
                    }
                  }
                }
              ]
            }
          }
        ]
      }
      storageProfile: {
        imageReference: {
          publisher: 'MicrosoftWindowsServer'
          offer: 'WindowsServer'
          sku: '2022-datacenter-azure-edition-core-smalldisk'
          version: 'latest'
        }
        osDisk: {
          createOption: 'FromImage'
          managedDisk: {
            storageAccountType: 'StandardSSD_LRS'
          }
          diskSizeGB: 32
        }
      }
      licenseType: 'Windows_Server'
      osProfile: {
        adminUsername: localAdminUsername
        adminPassword: localAdminPassword
        computerNamePrefix: 'DC'
        windowsConfiguration: {
          patchSettings: {
            enableHotpatching: true
            patchMode: 'AutomaticByPlatform'
          }
        }
      }
      extensionProfile: {
        extensions: [
          {
            name: 'Microsoft.Powershell.DSC'
            properties: {
              publisher: 'Microsoft.Powershell'
              type: 'DSC'
              typeHandlerVersion: '2.77'
              autoUpgradeMinorVersion: true
              settings: {
                ModulesUrl: 'https://github.com/joshua-a-lucas/BlueTeamLab/raw/main/scripts/Deploy-DomainServices.zip'
                ConfigurationFunction: 'Deploy-DomainServices.ps1\\Deploy-DomainServices'
                Properties: {
                  domainFQDN: domainFQDN
                  adminCredential: {
                    UserName: domainAdminUsername
                    Password: 'PrivateSettingsRef:adminPassword'
                  }
                }
              }
              protectedSettings: {
                Items: {
                  adminPassword: domainAdminPassword
                }
              }
            }
          }
          {
            name: 'HealthExtension'
            properties: {
              provisionAfterExtensions: [
                'Microsoft.Powershell.DSC'
              ]
              publisher: 'Microsoft.ManagedServices'
              type: 'ApplicationHealthWindows'
              typeHandlerVersion: '1.0'
              autoUpgradeMinorVersion: true
              enableAutomaticUpgrade: true
              settings: {
                protocol: 'tcp'
                port: 389
              }
            }
          }
        ]
      }
      diagnosticsProfile: {
        bootDiagnostics: {
          enabled: true
        }
      }
    }
  }
}

output ip string = 
