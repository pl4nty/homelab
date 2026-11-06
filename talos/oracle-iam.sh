#!/usr/bin/env bash
# Lets talos-oci-a1 call OCI as itself (instance principals) for the cloud controller and CSI in
# kubernetes/cluster-1/system/oci-cloud-controller-manager: LoadBalancer Services and block volumes.
# Idempotent. Run after ./oracle.sh:  OCI_CLI_PROFILE=default ./talos/oracle-iam.sh
set -euo pipefail
tenancy=${TENANCY_ID:-$(awk -v p="[${OCI_CLI_PROFILE:-DEFAULT}]" '$0==p{f=1;next} /^\[/{f=0} f && /^tenancy=/{sub(/^tenancy=/,""); print}' ~/.oci/config)}
name=${NAME:-talos-oci-a1}
group=cluster-1-oci-ccm
instance=$(oci compute instance list -c "$tenancy" --display-name "$name" --lifecycle-state RUNNING --query 'data[0].id' --raw-output)
[[ -n $instance ]] || { echo "no running instance named $name" >&2; exit 1; }

rule="ALL {instance.id = '$instance'}"
if [[ -z $(oci iam dynamic-group list -c "$tenancy" --all --query "data[?name=='$group'] | [0].id" --raw-output) ]]; then
  oci iam dynamic-group create -c "$tenancy" --name "$group" --description "$name, for the cluster-1 OCI cloud controller and CSI" --matching-rule "$rule" --wait-for-state ACTIVE >/dev/null
fi
statements=$(printf '"Allow dynamic-group %s to %s in tenancy",' "$group" "read instance-family" "$group" "use virtual-network-family" "$group" "manage security-lists" "$group" "manage load-balancers" "$group" "manage volume-family")
statements="[${statements%,}]"
policy=$(oci iam policy list -c "$tenancy" --all --query "data[?name=='$group'] | [0].id" --raw-output)
if [[ -z $policy ]]; then
  oci iam policy create -c "$tenancy" --name "$group" --description "cluster-1 OCI cloud controller and CSI on $name" --statements "$statements" --wait-for-state ACTIVE >/dev/null
else
  oci iam policy update --policy-id "$policy" --statements "$statements" --version-date "" --force >/dev/null
fi
echo "$group can manage load balancers, security lists and volumes as $name"
