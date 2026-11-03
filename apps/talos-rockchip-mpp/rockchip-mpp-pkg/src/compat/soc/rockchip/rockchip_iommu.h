/* SPDX-License-Identifier: GPL-2.0 */
/*
 * The vendor IOMMU driver exports controls the mainline rockchip-iommu driver
 * doesn't have. Mainline powers the IOMMU through the device link to its
 * master and restores the page table on runtime resume; page faults are
 * reported through the domain's fault handler.
 */
#ifndef __SOC_ROCKCHIP_IOMMU_H
#define __SOC_ROCKCHIP_IOMMU_H

#include <linux/device.h>

int rockchip_iommu_enable(struct device *dev);
int rockchip_iommu_disable(struct device *dev);
int rockchip_iommu_force_reset(struct device *dev);

static inline int rockchip_pagefault_done(struct device *master_dev) { return 0; }
static inline void __iomem *rockchip_get_iommu_base(struct device *master_dev, int idx) { return NULL; }
static inline bool rockchip_iommu_is_enabled(struct device *dev) { return true; }
static inline void rockchip_iommu_mask_irq(struct device *dev) { }
static inline void rockchip_iommu_unmask_irq(struct device *dev) { }

#endif
