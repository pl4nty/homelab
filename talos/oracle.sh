#!/usr/bin/env bash
# Creates an Always Free Oracle Cloud A1 VM booted into Talos maintenance mode, then adds it to topf.yaml.
# It never touches the cluster. Re-running it reuses what exists (looked up by name) and refreshes the firewall.
# Run `topf apply` on the home nodes first, so KubeSpan (all/kubespan.yaml) is up before this node joins.
#
# Needs a Pay As You Go tenancy (custom images aren't Always Free-eligible), plus oci (after `oci setup config`) and curl, as in the devcontainer.
#   TENANCY_ID=ocid1.tenancy... ./talos/oracle.sh
# Optional: COMPARTMENT_ID (default tenancy), NAME, OCPUS, MEMORY_GB, ADMIN_CIDR (who can reach apid, default this IP),
# A1_FREE_OCPUS/A1_FREE_MEMORY_GB (Always Free A1 allowance: 4/24 on Pay As You Go; set higher to accept a short paid overlap).
set -euo pipefail
cd "$(dirname "$0")"

tenancy=${TENANCY_ID:?set TENANCY_ID}
compartment=${COMPARTMENT_ID:-$tenancy}
name=${NAME:-talos-oci-a1}
ocpus=${OCPUS:-2} memory=${MEMORY_GB:-12}
admin_cidr=${ADMIN_CIDR:-$(curl -4fsS https://checkip.amazonaws.com)/32}
version=$(sed -n 's/^talosVersion: //p' topf.yaml)
cidr=10.10.0.0/24 # clear of the home LAN and the default pod/service CIDRs
bucket=talos-images

# lookup <display-name> <oci list command...>: id of the live resource with that name, or nothing
lookup() {
  local n=$1
  shift
  oci "$@" -c "$compartment" --all --query "data[?\"display-name\"=='$n' && \"lifecycle-state\"!='TERMINATED'] | [0].id" --raw-output
}

schematic=$(curl -fsS -X POST --data-binary @hardware/oracle-schematic.yaml https://factory.talos.dev/schematics | sed -E 's/.*"id": *"([0-9a-f]+)".*/\1/')
[[ $schematic =~ ^[0-9a-f]{64}$ ]] || { echo "image factory returned '$schematic'" >&2; exit 1; }

vcn=$(lookup "$name" network vcn list)
[[ -n $vcn ]] || vcn=$(oci network vcn create -c "$compartment" --display-name "$name" --cidr-blocks "[\"$cidr\"]" --dns-label talos --wait-for-state AVAILABLE --query data.id --raw-output)
igw=$(lookup "$name" network internet-gateway list --vcn-id "$vcn")
[[ -n $igw ]] || igw=$(oci network internet-gateway create -c "$compartment" --vcn-id "$vcn" --display-name "$name" --is-enabled true --wait-for-state AVAILABLE --query data.id --raw-output)
defaults=$(oci network vcn get --vcn-id "$vcn" --query "join(' ', [data.\"default-route-table-id\", data.\"default-security-list-id\"])" --raw-output)
read -r rt sl <<<"$defaults"
oci network route-table update --rt-id "$rt" --force --route-rules "[{\"destination\": \"0.0.0.0/0\", \"networkEntityId\": \"$igw\"}]" >/dev/null
oci network security-list update --security-list-id "$sl" --force \
  --egress-security-rules '[{"destination": "0.0.0.0/0", "protocol": "all"}]' \
  --ingress-security-rules "[
    {\"description\": \"KubeSpan\", \"source\": \"0.0.0.0/0\", \"protocol\": \"17\", \"udpOptions\": {\"destinationPortRange\": {\"min\": 51820, \"max\": 51820}}},
    {\"description\": \"Talos apid for topf\", \"source\": \"$admin_cidr\", \"protocol\": \"6\", \"tcpOptions\": {\"destinationPortRange\": {\"min\": 50000, \"max\": 50000}}},
    {\"description\": \"path MTU discovery\", \"source\": \"0.0.0.0/0\", \"protocol\": \"1\", \"icmpOptions\": {\"type\": 3, \"code\": 4}}
  ]" >/dev/null
subnet=$(lookup "$name" network subnet list --vcn-id "$vcn")
[[ -n $subnet ]] || subnet=$(oci network subnet create -c "$compartment" --vcn-id "$vcn" --display-name "$name" --cidr-block "$cidr" --dns-label nodes --wait-for-state AVAILABLE --query data.id --raw-output)

# Talos docs' BYOI flow: factory qcow2 + launch metadata in a .oci archive, imported from Object Storage
image_name=talos-v$version-${schematic:0:12}
image=$(lookup "$image_name" compute image list --operating-system Talos)
if [[ -z $image ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fL -o "$work/oracle-arm64.qcow2" "https://factory.talos.dev/image/$schematic/v$version/oracle-arm64.qcow2"
  cat >"$work/image_metadata.json" <<EOF
{"version": 2, "operatingSystem": "Talos", "operatingSystemVersion": "$version",
 "externalLaunchOptions": {"firmware": "UEFI_64", "networkType": "PARAVIRTUALIZED", "bootVolumeType": "PARAVIRTUALIZED",
  "remoteDataVolumeType": "PARAVIRTUALIZED", "localDataVolumeType": "PARAVIRTUALIZED", "launchOptionsSource": "PARAVIRTUALIZED",
  "pvAttachmentVersion": 2, "pvEncryptionInTransitEnabled": true, "consistentVolumeNamingEnabled": true},
 "imageCapabilityData": null, "imageCapsFormatVersion": null,
 "additionalMetadata": {"shapeCompatibilities": [{"internalShapeName": "VM.Standard.A1.Flex", "ocpuConstraints": null, "memoryConstraints": null}]}}
EOF
  tar -C "$work" -czf "$work/$image_name.oci" oracle-arm64.qcow2 image_metadata.json
  oci os bucket get --bucket-name "$bucket" >/dev/null 2>&1 || oci os bucket create -c "$compartment" --name "$bucket" >/dev/null
  oci os object put --bucket-name "$bucket" --file "$work/$image_name.oci" --force >/dev/null
  ns=$(oci os ns get --query data --raw-output)
  image=$(oci compute image import from-object -c "$compartment" -ns "$ns" -bn "$bucket" --name "$image_name.oci" \
    --display-name "$image_name" --source-image-type QCOW2 --launch-mode PARAVIRTUALIZED --operating-system Talos --operating-system-version "$version" --query data.id --raw-output)
fi
while state=$(oci compute image get --image-id "$image" --query 'data."lifecycle-state"' --raw-output) && [[ $state == IMPORTING || $state == PROVISIONING ]]; do sleep 30; done
[[ $state == AVAILABLE ]] || { echo "image $image is $state" >&2; exit 1; }
oci compute image-shape-compatibility-entry add --image-id "$image" --shape-name VM.Standard.A1.Flex >/dev/null

instance=$(lookup "$name" compute instance list)
if [[ -z $instance ]]; then
  ads=$(oci iam availability-domain list -c "$tenancy" --query "join(' ', data[].name)" --raw-output)
  used() {
    local total=0 ad n
    for ad in $ads; do
      n=$(oci limits resource-availability get --service-name compute --limit-name "$1" -c "$tenancy" --availability-domain "$ad" --query 'data.used' --raw-output)
      total=$((total + ${n%.*}))
    done
    echo "$total"
  }
  cores=$(used standard-a1-core-count)
  gbs=$(used standard-a1-memory-count)
  if ((cores + ocpus > ${A1_FREE_OCPUS:-4} || gbs + memory > ${A1_FREE_MEMORY_GB:-24})); then
    echo "A1 usage ($cores OCPU, $gbs GB in use) would pass the Always Free allowance. Free some, or raise A1_FREE_OCPUS/A1_FREE_MEMORY_GB if your bill says otherwise." >&2
    exit 1
  fi
  # No user data: Talos waits in maintenance mode for `topf apply`, so cluster secrets never sit in instance metadata
  instance=$(oci compute instance launch -c "$compartment" --availability-domain "${ads%% *}" --display-name "$name" --hostname-label "$name" \
    --shape VM.Standard.A1.Flex --shape-config "{\"ocpus\": $ocpus, \"memoryInGBs\": $memory}" \
    --image-id "$image" --boot-volume-size-in-gbs 50 --subnet-id "$subnet" --assign-public-ip true \
    --launch-options '{"firmware": "UEFI_64", "networkType": "PARAVIRTUALIZED", "bootVolumeType": "PARAVIRTUALIZED", "remoteDataVolumeType": "PARAVIRTUALIZED"}' \
    --instance-options '{"areLegacyImdsEndpointsDisabled": true}' \
    --agent-config '{"areAllPluginsDisabled": true, "isManagementDisabled": true, "isMonitoringDisabled": true}' \
    --availability-config '{"isLiveMigrationPreferred": true, "recoveryAction": "RESTORE_INSTANCE"}' \
    --wait-for-state RUNNING --query data.id --raw-output)
fi
ip=$(oci compute instance list-vnics --instance-id "$instance" --query 'data[0]."public-ip"' --raw-output)

# topf reaches the node on its public IP, which isn't on an interface, so apid's cert needs it as a SAN
printf 'machine:\n  certSANs:\n    - %s\n' "$ip" >"node/$name/certsans.yaml"
if grep -q "host: $name$" topf.yaml; then
  sed -i "/host: $name$/{n;s/ip: .*/ip: $ip/;}" topf.yaml
else
  cat >>topf.yaml <<EOF
  - host: $name
    ip: $ip
    role: worker
    platform: oracle
    schematicId: "@hardware/oracle-schematic.yaml"
EOF
fi
echo "$name is in maintenance mode at $ip. Commit talos/, then: topf --nodes-filter '^$name\$' apply"
