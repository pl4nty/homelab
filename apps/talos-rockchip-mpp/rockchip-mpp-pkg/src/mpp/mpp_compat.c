// SPDX-License-Identifier: (GPL-2.0+ OR MIT)
/*
 * The vendor rockchip_iommu_{disable,enable,force_reset} on the mainline
 * rockchip-iommu driver: its runtime PM suspend and resume disable the MMU, and
 * re-enable it with a force reset, the page table base and paging. That is
 * what a codec reset needs when it also resets the MMU. The force variants run
 * the callbacks whatever the usage count the device link to the codec holds.
 */

#include <linux/of.h>
#include <linux/of_platform.h>
#include <linux/platform_device.h>
#include <linux/pm_runtime.h>
#include <soc/rockchip/rockchip_iommu.h>

static struct device *mpp_iommu_dev(struct device *master)
{
	struct device_node *np;
	struct platform_device *pdev;

	np = of_parse_phandle(master->of_node, "iommus", 0);
	if (!np)
		return NULL;
	pdev = of_find_device_by_node(np);
	of_node_put(np);

	return pdev ? &pdev->dev : NULL;
}

int rockchip_iommu_disable(struct device *dev)
{
	struct device *iommu = mpp_iommu_dev(dev);
	int ret;

	if (!iommu)
		return -ENODEV;
	ret = pm_runtime_force_suspend(iommu);
	put_device(iommu);

	return ret;
}

int rockchip_iommu_enable(struct device *dev)
{
	struct device *iommu = mpp_iommu_dev(dev);
	int ret;

	if (!iommu)
		return -ENODEV;
	ret = pm_runtime_force_resume(iommu);
	put_device(iommu);

	return ret;
}

int rockchip_iommu_force_reset(struct device *dev)
{
	int ret;

	ret = rockchip_iommu_disable(dev);
	if (ret)
		return ret;

	return rockchip_iommu_enable(dev);
}
