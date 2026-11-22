terraform {
  required_version = ">= 1.13"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "9.14.0"
    }
  }
}

# the key itself comes from the OCI_PRIVATE_KEY env var
provider "oci" {
  tenancy_ocid = local.tenancy
  user_ocid    = "ocid1.user.oc1..aaaaaaaats75afzmmvucnsll32vtiwjtrkm5l54hg5atp3i7yfyvz4ny22iq"
  fingerprint  = "a5:e6:88:f6:01:d3:ef:a8:92:47:57:e1:8b:4f:5a:7f"
  region       = "ap-sydney-1"
}

locals {
  name    = "talos-oci-a1"
  tenancy = "ocid1.tenancy.oc1..aaaaaaaa25lbdpi2azw3qdkoi3j2qpnsvkjxggpbsdlpqiibrv6qs6v6qyxa"
  # OCI allocates the VCN's /56 on apply, so the subnet only gets its /64 on the next apply
  subnet_ipv6 = [for b in oci_core_vcn.talos.ipv6cidr_blocks : cidrsubnet(b, 8, 0)]
  node_ipv6   = [for b in local.subnet_ipv6 : cidrhost(b, 256)]
}

resource "oci_core_vcn" "talos" {
  compartment_id = local.tenancy
  display_name   = local.name
  # clear of the home LAN and the pod/service CIDRs
  cidr_blocks = ["10.10.0.0/24"]
  dns_label   = "talos"
  # flannel's dual stack needs an IPv6 default route on the node's IPv4 interface
  is_ipv6enabled = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_internet_gateway" "talos" {
  compartment_id = local.tenancy
  vcn_id         = oci_core_vcn.talos.id
  display_name   = local.name
  enabled        = true
}

resource "oci_core_default_route_table" "talos" {
  manage_default_resource_id = oci_core_vcn.talos.default_route_table_id

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.talos.id
  }

  route_rules {
    destination       = "::/0"
    network_entity_id = oci_core_internet_gateway.talos.id
  }
}

resource "oci_core_default_security_list" "talos" {
  manage_default_resource_id = oci_core_vcn.talos.default_security_list_id

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  egress_security_rules {
    destination = "::/0"
    protocol    = "all"
  }

  # KubeSpan, so the node reaches the home LAN through NAT without a port forward at home
  dynamic "ingress_security_rules" {
    for_each = ["0.0.0.0/0", "::/0"]
    content {
      description = "KubeSpan"
      source      = ingress_security_rules.value
      protocol    = "17"
      udp_options {
        min = 51820
        max = 51820
      }
    }
  }

  # apid only accepts clients with a cert from the cluster's Talos CA, and the home IP is dynamic
  dynamic "ingress_security_rules" {
    for_each = ["0.0.0.0/0", "::/0"]
    content {
      description = "Talos apid for topf"
      source      = ingress_security_rules.value
      protocol    = "6"
      tcp_options {
        min = 50000
        max = 50000
      }
    }
  }

  ingress_security_rules {
    description = "path MTU discovery"
    source      = "0.0.0.0/0"
    protocol    = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    description = "path MTU discovery"
    source      = "::/0"
    protocol    = "58"
    icmp_options {
      type = 2
    }
  }
}

resource "oci_core_subnet" "talos" {
  compartment_id  = local.tenancy
  vcn_id          = oci_core_vcn.talos.id
  display_name    = local.name
  cidr_block      = "10.10.0.0/24"
  ipv6cidr_blocks = local.subnet_ipv6
  dns_label       = "nodes"

  lifecycle {
    prevent_destroy = true
  }
}

import {
  to = oci_core_vcn.talos
  id = "ocid1.vcn.oc1.ap-sydney-1.amaaaaaaqwuji6aakd7w3tqnuqngqbjznna2336ifh7cyzfi5y22vrkx2bba"
}

import {
  to = oci_core_internet_gateway.talos
  id = "ocid1.internetgateway.oc1.ap-sydney-1.aaaaaaaa7kpohxqf2irzv5oa45or4tzwr4ivpldiulazcojtucn3lzbp56wq"
}

import {
  to = oci_core_subnet.talos
  id = "ocid1.subnet.oc1.ap-sydney-1.aaaaaaaarngfvakq3efk4mdigntjtkr7n45oycyx7ms2ywylt5e6bqd3cvza"
}
