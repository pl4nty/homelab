# Lab Infrastructure
Configuration files for my lab infrastructure. Some are automatically reconciled, others are for bootstrapping or point-in-time snapshots.

Directory | Description
--- | ---
`kubernetes` | Kubernetes manifests deployed to clusters with Flux

curl --data "ReturnUrl=&Username=user&Password=pw&action%3AIndex=" "https://toolbox3.iinet.net.au/login" -L -c -
curl "https://toolbox4.iinet.net.au/api/usage/getDataUsageInGB/1188057788/500707120?fromDate=2021-04-05&toDate=2021-05-06" -H "Cookie: JSESSIONID=cookie"
``
helm install `
  cert-manager `
  --namespace kube-system `
  --version v1.3.1 `
  --set installCRDs=true `
  --set nodeSelector."beta\.kubernetes\.io/os"=linux `
  jetstack/cert-manager