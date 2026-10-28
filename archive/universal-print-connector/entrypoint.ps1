$key = "HKLM:\SOFTWARE\Microsoft\UniversalPrint\Connector"
New-ItemProperty -Path $key -Name McpSvcResourceID -Value $env:McpSvcResourceID
New-ItemProperty -Path $key -Name PrintSvcUrl -Value "$($env:McpSvcResourceID)/"
New-ItemProperty -Path $key -Name NotificationUrl -Value "https://notification.print.microsoft.com/"
New-ItemProperty -Path $key -Name DeviceTokenUrl -Value $env:DeviceTokenUrl
New-ItemProperty -Path $key -Name CloudDeviceId -Value $env:CloudDeviceId
# AppInsights diagnostics. overriden by cloud-delivered config
# New-Item $env:CONFIG_KEY\\Diagnostics; \
# New-ItemProperty -Path $env:CONFIG_KEY\\Diagnostics -Name UserConsented -Value 1

# count mount config.json to C:\Windows\PrintConnectorSvc, but overwritten by cloud config. may break if read-only
# target-environment := print.print.microsoft.com, localhost (localhost:87)
# max-concurrent-jobs-per-printer
# include-all-local-printers
# exclude-printers-not-shareable
# exclude-printer-drivers-prefixes
# exclude-file-printers
# enable-pdf-job-passthrough
# enable-pdftoxps
# enable-impersonation
# enable-save-print-file
# enable-software-printers
# apply-printer-margins
# check-printer-updates-interval-milliseconds
# diagnostics-upload-interval-seconds

ConvertTo-Json @{"exclude-printer-drivers-prefixes"=@("Microsoft Print"); "exclude-printers-not-shareable"=$false} | Out-File C:\Windows\PrintConnectorSvc\config.json

$store = "cert:\LocalMachine\PrintProxyStore"
New-Item $store
$pass = ConvertTo-SecureString $env:CERT_PASSWORD -AsPlainText -Force
# exportable is required by application
$cert = Import-PfxCertificate -CertStoreLocation $store -FilePath $env:CERT_FILE_PFX -Password $pass -Exportable
New-ItemProperty -Path $key -Name certificate_thumbprint -Value $cert.Thumbprint

$key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Print\Printers\"
$env:PRINTERS -split "," | % {
  $printer = $_ -split ":"
  $printerKey = "$key\$($printer[0])\CloudData"
  New-Item $printerKey
  write-host $printer.length, $printer[0]
  New-ItemProperty -Path $printerKey -Name device_id -Value $printer[1]

  $pass = ConvertTo-SecureString $printer[3] -AsPlainText -Force
  $cert = Import-PfxCertificate -CertStoreLocation $store -FilePath $printer[2] -Password $pass -Exportable
  New-ItemProperty -Path $printerKey -Name certificate_thumbprint -Value $cert.Thumbprint
}

Start-Service "Print Connector service"
& "C:\LogMonitor\LogMonitor.exe"
