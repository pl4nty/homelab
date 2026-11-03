// SPDX-License-Identifier: GPL-2.0
/*
 * Not part of the mainline driver: an exported symbol for rk3588_mpp_dt to call,
 * so module dependency resolution loads this IOMMU driver before the AV1
 * decoder's node is added and probed.
 */
#include <linux/export.h>

void vsi_iommu_dep(void);

void vsi_iommu_dep(void)
{
}
EXPORT_SYMBOL_GPL(vsi_iommu_dep);
