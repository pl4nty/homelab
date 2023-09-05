param name string
param location string

param subnet string
param sku string = 'Standard_B2s'
param managedIdentity bool = false

@secure()
param localAdminUsername string
@secure()
param localAdminPassword string
// https://learn.microsoft.com/en-us/azure/virtual-machine-scale-sets/virtual-machine-scale-sets-health-extension#extension-schema-for-binary-health-states
param healthSettings object
// param dscSettings object
// param dscProtectedItems object

resource umi 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (managedIdentity) {
  name: 'umi-${name}'
  location: location
}

resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2023-07-01' = {
  name: 'vmss-${name}'
  location: location
  identity: {
    type: managedIdentity ? 'UserAssigned' : 'None'
  }
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
          // {
          //   name: 'Microsoft.Powershell.DSC'
          //   properties: {
          //     publisher: 'Microsoft.Powershell'
          //     type: 'DSC'
          //     typeHandlerVersion: '2.77'
          //     autoUpgradeMinorVersion: true
          //     settings: dscSettings
          //     protectedSettings: {
          //       Items: dscProtectedItems
          //     }
          //   }
          // }
          {
            name: 'HealthExtension'
            properties: {
              // provisionAfterExtensions: [
              //   'Microsoft.Powershell.DSC'
              // ]
              publisher: 'Microsoft.ManagedServices'
              type: 'ApplicationHealthWindows'
              typeHandlerVersion: '1.0'
              autoUpgradeMinorVersion: true
              enableAutomaticUpgrade: true
              settings: healthSettings
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

output id string = vmss.id
output name string = vmss.name
output umiId string = managedIdentity ? umi.id : ''
