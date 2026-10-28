# vendored WCF image is core without a print spooler service, so we DIY based on
# https://github.com/microsoft/dotnet-framework-docker/blob/main/src/wcf/4.8.1/windowsservercore-ltsc2022/Dockerfile
FROM mcr.microsoft.com/powershell:windowsserver-ltsc2022
RUN dism /Online /Quiet /Enable-Feature /All /FeatureName:WCF-HTTP-Activation45 /FeatureName:WCF-TCP-Activation45 /FeatureName:IIS-WebSockets

# https://aka.ms/UPConnector
RUN pwsh iwr -OutFile UniversalPrintConnectorInstaller.exe https://download.microsoft.com/download/a/5/4/a5411e44-ff15-4a41-aede-6bb6aa581756/UniversalPrintConnectorInstaller.1.87.8489.31785.exe
RUN UniversalPrintConnectorInstaller.exe /quiet
# clear logs from failed auto-start
RUN pwsh [System.Diagnostics.Eventing.Reader.EventLogSession]::GlobalSession.ClearLog('Microsoft-Windows-PrintConnector/Operational')

COPY LogMonitorConfig.json /LogMonitor/
RUN pwsh iwr  -OutFile C:\LogMonitor\LogMonitor.exe https://github.com/microsoft/windows-container-tools/releases/download/v1.2.1/LogMonitor.exe
COPY entrypoint.ps1 .

CMD [ "entrypoint.ps1" ]
# use as healthcheck?
# http://localhost:8091/WindowsServiceHostedService/PrinterConnectorService
EXPOSE 8091
