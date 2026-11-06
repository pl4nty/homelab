#!/usr/bin/env bash
# OCI identity for the cloud controller and CSI in kubernetes/cluster-1/system/oci-cloud-controller-manager:
# a user with only the permissions they need (LoadBalancer Services, security lists, block volumes), plus an
# API key. Writes cloud-provider.sops.yaml there, encrypted for the repo's age key. Idempotent apart from adding
# a new API key each run (OCI allows 3 per user; delete old ones in the console).
#   OCI_CLI_PROFILE=default ./talos/oracle-iam.sh
set -euo pipefail
cd "$(dirname "$0")/.."
profile=${OCI_CLI_PROFILE:-DEFAULT}
conf() { awk -v p="[$profile]" -v k="$1=" '$0==p{f=1;next} /^\[/{f=0} f && index($0,k)==1{print substr($0,length(k)+1)}' ~/.oci/config; }
tenancy=${TENANCY_ID:-$(conf tenancy)}
region=$(conf region)
user=cluster-1-ccm
dir=kubernetes/cluster-1/system/oci-cloud-controller-manager
vcn=$(oci network vcn list -c "$tenancy" --display-name talos-oci-a1 --query 'data[0].id' --raw-output)
subnet=$(oci network subnet list -c "$tenancy" --vcn-id "$vcn" --display-name talos-oci-a1 --query 'data[0].id' --raw-output)
sl=$(oci network vcn get --vcn-id "$vcn" --query 'data."default-security-list-id"' --raw-output)

uid=$(oci iam user list -c "$tenancy" --all --query "data[?name=='$user'] | [0].id" --raw-output)
[[ -n $uid ]] || uid=$(oci iam user create -c "$tenancy" --name "$user" --description "cluster-1 OCI cloud controller and CSI (homelab)" --wait-for-state ACTIVE --query data.id --raw-output)
gid=$(oci iam group list -c "$tenancy" --all --query "data[?name=='$user'] | [0].id" --raw-output)
[[ -n $gid ]] || gid=$(oci iam group create -c "$tenancy" --name "$user" --description "cluster-1 OCI cloud controller and CSI" --wait-for-state ACTIVE --query data.id --raw-output)
oci iam group list-users --group-id "$gid" --all --query "data[?id=='$uid'] | [0].id" --raw-output | grep -q . || oci iam group add-user --group-id "$gid" --user-id "$uid" >/dev/null
statements=$(printf '"Allow group %s to %s in tenancy",' "$user" "read instance-family" "$user" "use virtual-network-family" "$user" "manage security-lists" "$user" "manage load-balancers" "$user" "manage volume-family")
statements="[${statements%,}]"
pid=$(oci iam policy list -c "$tenancy" --all --query "data[?name=='$user'] | [0].id" --raw-output)
if [[ -z $pid ]]; then
  oci iam policy create -c "$tenancy" --name "$user" --description "cluster-1 OCI cloud controller and CSI" --statements "$statements" --wait-for-state ACTIVE >/dev/null
else
  oci iam policy update --policy-id "$pid" --statements "$statements" --version-date "" --force >/dev/null
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
openssl genrsa -out "$work/key.pem" 2048 2>/dev/null
openssl rsa -in "$work/key.pem" -pubout -out "$work/pub.pem" 2>/dev/null
fingerprint=$(oci iam user api-key upload --user-id "$uid" --key-file "$work/pub.pem" --query data.fingerprint --raw-output)
{
  printf 'auth:\n  region: %s\n  tenancy: %s\n  user: %s\n  fingerprint: %s\n  key: |\n' "$region" "$tenancy" "$uid" "$fingerprint"
  sed 's/^/    /' "$work/key.pem"
  printf 'compartment: %s\nvcn: %s\nloadBalancer:\n  subnet1: %s\n  securityListManagementMode: All\n  securityLists:\n    %s: %s\n' "$tenancy" "$vcn" "$subnet" "$subnet" "$sl"
} >"$work/cloud-provider.yaml"
# the CCM reads cloud-provider.yaml, the CSI controller config.yaml; same content
out=$dir/oci-cloud-controller-manager.sops.yaml
for s in oci-cloud-controller-manager:cloud-provider.yaml oci-volume-provisioner:config.yaml; do
  printf -- '---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: kube-system\nstringData:\n  %s: |\n' "${s%%:*}" "${s#*:}"
  sed 's/^/    /' "$work/cloud-provider.yaml"
done >"$out"
sops --encrypt --in-place --age "$(sed -n 's/.*AGE_X25519_PUBLIC_KEY: //p' kubernetes/cluster-1/backups/etcd.yaml)" "$out"
echo "wrote $out for $user (key $fingerprint)"
