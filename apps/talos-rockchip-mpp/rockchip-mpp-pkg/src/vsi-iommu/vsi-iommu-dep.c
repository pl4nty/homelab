// SPDX-License-Identifier: GPL-2.0
/*
 * Not part of the mainline driver: an exported symbol for rk_vcodec to reference,
 * so module dependency resolution loads this IOMMU driver before the AV1
 * decoder probes.
 */
#include <linux/export.h>

void vsi_iommu_dep(void);

void vsi_iommu_dep(void)
{
}
EXPORT_SYMBOL_GPL(vsi_iommu_dep);
