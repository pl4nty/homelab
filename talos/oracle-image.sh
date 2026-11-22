#!/usr/bin/env bash
# Imports the Talos image that terraform/oracle boots a new talos-oci-a1 from. Existing VMs upgrade through topf,
# so this only matters before creating one. Re-running it reuses an image that already exists.
# Needs a Pay As You Go tenancy (custom images aren't Always Free-eligible), plus oci (after `oci setup config`) and curl, as in the devcontainer.
#   TENANCY_ID=ocid1.tenancy... ./talos/oracle-image.sh
set -euo pipefail
cd "$(dirname "$0")"

compartment=${COMPARTMENT_ID:-${TENANCY_ID:?set TENANCY_ID}}
version=$(sed -n 's/^talosVersion: //p' topf.yaml)
bucket=talos-images

schematic=$(curl -fsS -X POST --data-binary @hardware/oracle-schematic.yaml https://factory.talos.dev/schematics | sed -E 's/.*"id": *"([0-9a-f]+)".*/\1/')
[[ $schematic =~ ^[0-9a-f]{64}$ ]] || { echo "image factory returned '$schematic'" >&2; exit 1; }

# Talos docs' BYOI flow: factory qcow2 + launch metadata in a .oci archive, imported from Object Storage
image_name=talos-v$version-${schematic:0:12}
image=$(oci compute image list -c "$compartment" --all --operating-system Talos --query "data[?\"display-name\"=='$image_name'] | [0].id" --raw-output)
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
echo "$image_name is $image"
