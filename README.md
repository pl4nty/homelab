# Lab Infrastructure Configs
Various configuration files for my lab infrastructure.

Directory | Description
--- | ---
`manifests` | Kubernetes manifests deployed to clusters with Flux

# AKS
## AKS Bootstrap
TODO research ephemeral disks. Supported by B-series, supposedly "automatically provisioned"
```powershell
az aks create `
    --resource-group lab-infra `
    --name aks-east-1 `
    --generate-ssh-keys `
    --vm-set-type VirtualMachineScaleSets `
    --load-balancer-sku basic `
    --node-count 1 `
    --min-count 1 `
    --max-count 3 `
    --enable-cluster-autoscaler `
    --location australiaeast `
    --node-osdisk-size 32 `
    --node-vm-size Standard_B2s
```

## Apply Flux via Policy
```powershell
az k8s-configuration create `
   --cluster-name aks-east-1 `
   --cluster-type connectedClusters `
   --name cluster-config `
   --resource-group lab-infra `
   --scope cluster `
   --enable-helm-operator `
   --helm-operator-chart-version='1.2.0' `
   --helm-operator-params='--set helm.versions=v3' `
   --operator-instance-name cluster-config `
   --operator-namespace cluster-config `
   --repository-url https://github.com/pl4nty/lab-infra.git `
   --operator-params='--git-readonly --git-path=manifests --git-branch=main'
```
managedClusters | connectedClusters

If sync is desired, remove `--git-readonly` and add deploy key to GitHub repo.

Deploy ingress with static IP using `nginx-ingress.yaml`. If Flux isn't installed, manually install ingress with:
```powershell
helm install nginx-ingress ingress-nginx/ingress-nginx `
    --namespace ingress `
    --set controller.replicaCount=1 `
    --set controller.nodeSelector."beta\.kubernetes\.io/os"=linux `
    --set defaultBackend.nodeSelector."beta\.kubernetes\.io/os"=linux `
    --set controller.admissionWebhooks.patch.nodeSelector."beta\.kubernetes\.io/os"=linux `
    --set controller.service.loadBalancerIP="13.70.81.98" `
    --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-dns-label-name"="aks-east-1-public"
```

## Azure Arc on AKS
GitOps isn't actually supported on AKS, despite docs. See https://github.com/Azure/AKS/issues/1967
Join to Azure Arc as a workaround with:
```powershell
az connectedk8s connect --name aks-east-1 `
    --resource-group lab-infra `
    --distribution aks `
    --infrastructure azure `
    --location australiaeast
```

# Onprem
https://docs.rke2.io/install/quickstart/

``
curl --data "ReturnUrl=&Username=user&Password=pw&action%3AIndex=" "https://toolbox3.iinet.net.au/login" -L -c -
curl "https://toolbox4.iinet.net.au/api/usage/getDataUsageInGB/1188057788/500707120?fromDate=2021-04-05&toDate=2021-05-06" -H "Cookie: JSESSIONID=cookie"
``
