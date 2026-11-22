data "oci_identity_availability_domains" "this" {
  compartment_id = local.tenancy
}

# the newest imported Talos image. Upgrades go through topf, so it only matters when the VM is created
data "oci_core_images" "talos" {
  compartment_id   = local.tenancy
  operating_system = "Talos"
  sort_by          = "TIMECREATED"
  sort_order       = "DESC"
}

# Always Free A1 is 4 OCPU / 24 GB in total. No user data: Talos waits in maintenance mode for
# `topf apply`, so cluster secrets never sit in instance metadata
resource "oci_core_instance" "talos" {
  compartment_id      = local.tenancy
  availability_domain = data.oci_identity_availability_domains.this.availability_domains[0].name
  display_name        = local.name
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = 4
    memory_in_gbs = 24
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.talos.images[0].id
    boot_volume_size_in_gbs = 50
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.talos.id
    hostname_label   = local.name
    assign_public_ip = true
  }

  launch_options {
    firmware                = "UEFI_64"
    network_type            = "PARAVIRTUALIZED"
    boot_volume_type        = "PARAVIRTUALIZED"
    remote_data_volume_type = "PARAVIRTUALIZED"
  }

  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  agent_config {
    are_all_plugins_disabled = true
    is_management_disabled   = true
    is_monitoring_disabled   = true
  }

  availability_config {
    is_live_migration_preferred = true
    recovery_action             = "RESTORE_INSTANCE"
  }

  lifecycle {
    prevent_destroy = true
    # nearly every field replaces the VM, and Talos owns it once it boots
    ignore_changes = all
  }
}

data "oci_core_vnic_attachments" "talos" {
  compartment_id = local.tenancy
  instance_id    = oci_core_instance.talos.id
}

data "oci_core_ipv6s" "talos" {
  vnic_id = data.oci_core_vnic_attachments.talos.vnic_attachments[0].vnic_id
}

# Talos's oracle platform reads this from instance metadata at boot, so the node needs a reboot after it's added
resource "oci_core_ipv6" "talos" {
  for_each   = toset(local.node_ipv6)
  vnic_id    = data.oci_core_vnic_attachments.talos.vnic_attachments[0].vnic_id
  ip_address = each.key
  depends_on = [oci_core_subnet.talos]
}

# instance principals for the OCI cloud controller and CSI in
# kubernetes/cluster-1/system/oci-cloud-controller-manager: LoadBalancer Services and block volumes
# (attaching one needs use instances and manage volume-attachments on top of manage volume-family)
resource "oci_identity_dynamic_group" "ccm" {
  compartment_id = local.tenancy
  name           = "cluster-1-oci-ccm"
  description    = "${local.name}, for the cluster-1 OCI cloud controller and CSI"
  matching_rule  = "ALL {instance.id = '${oci_core_instance.talos.id}'}"
}

resource "oci_identity_policy" "ccm" {
  compartment_id = local.tenancy
  name           = oci_identity_dynamic_group.ccm.name
  description    = "cluster-1 OCI cloud controller and CSI on ${local.name}"
  statements = [
    for verb in [
      "read instance-family",
      "use virtual-network-family",
      "manage security-lists",
      "manage load-balancers",
      "manage volume-family",
      "use instances",
      "manage volume-attachments",
    ] : "Allow dynamic-group ${oci_identity_dynamic_group.ccm.name} to ${verb} in tenancy"
  ]
}

import {
  to = oci_core_instance.talos
  id = "ocid1.instance.oc1.ap-sydney-1.anzxsljrqwuji6aczhavaddvahj72joa3j7xvkqpe7smuvk3chj345oy3v5a"
}

import {
  for_each = { for ip in data.oci_core_ipv6s.talos.ipv6s : ip.ip_address => ip.id if contains(local.node_ipv6, ip.ip_address) }
  to       = oci_core_ipv6.talos[each.key]
  id       = each.value
}

import {
  to = oci_identity_dynamic_group.ccm
  id = "ocid1.dynamicgroup.oc1..aaaaaaaag6aojvcakyf4qok2dwqgwbe3hlmrdttz5qj35qdz6jir7geerhoq"
}

import {
  to = oci_identity_policy.ccm
  id = "ocid1.policy.oc1..aaaaaaaau56rxutxrto4ia7n3htslftubvaljhtmp3meaiyem4uhb7h2r5ha"
}

output "public_ip" {
  description = "for talos/topf.yaml and talos/node/talos-oci-a1/certsans.yaml"
  value       = oci_core_instance.talos.public_ip
}
