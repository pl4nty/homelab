# Universal Print connector

The [Microsoft Universal Print connector](https://learn.microsoft.com/en-us/universal-print/fundamentals/universal-print-connector-overview) in a Windows Server container.

To get started, register a connector:

```PowerShell
.\Add-UPDevice.ps1 -DeviceType connector -DeviceName myconnector -PFXPassword mypassword
```

Then register a printer:

```PowerShell
.\Add-UPDevice.ps1 -DeviceType printer -DeviceName myprinter -PFXPassword mypassword -PrinterConnectorId [connector's CloudDeviceId]
```

Example environment variables are available in `example.env`. The container can be tested locally with:

```PowerShell
docker run -it --isolation -p 8091:8091 -v ${pwd}\certs:C:\certs --env-file=example.env ghcr.io/pl4nty/universal-print-connector
```

Hyper-V isolation is [recommended for print services](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/print-spooler#hyper-v-isolation) and can allow connectors to share a host.

A WCF web service is available on port 8091 for healthchecks, and [LogMonitor](https://github.com/microsoft/windows-container-tools/tree/main/LogMonitor) writes connector event logs to stdout.

As of writing, connectors can't be removed in the Universal Print web portal, so `Remove-UPDevice.ps1` is provided.
