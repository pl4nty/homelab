# Lab Infrastructure Configs
Various configuration files for my lab infrastructure.

Directory | Description
- | -
`manifests` | Kubernetes manifests deployed to clusters with Flux

Enable Flux with this command:
```powershell
az k8sconfiguration create `
   --name cluster-config `
   --cluster-name  `
   --resource-group  `
   --operator-instance-name cluster-config `
   --operator-namespace cluster-config `
   --repository-url https://github.com/pl4nty/lab-infra.git `
   --scope cluster `
   --cluster-type managedClusters | connectedClusters `
   --operator-params='--git-readonly --git-path=lab-infra/manifests'
```

If sync is desired, remove `--git-readonly` and add deploy key to GitHun repo.

Prereq: Deploy ingress with static IP using `nginx-ingress.yaml`.