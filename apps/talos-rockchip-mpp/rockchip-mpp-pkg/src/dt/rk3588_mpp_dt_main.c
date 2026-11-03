// SPDX-License-Identifier: (GPL-2.0+ OR MIT)
/*
 * Adds the RK3588 MPP, RGA and AV1 device nodes to a mainline device tree at
 * module load. rk_vcodec and rga3 call rk3588_mpp_dt_ready(), so loading either
 * loads this first, and this loads vsi_iommu first: the AV1 decoder must find
 * its IOMMU driver when it probes.
 *
 * Board DTBs are built without __symbols__, so the labels the overlay refers
 * to are added to /__symbols__ first, found by compatible or path. The overlay
 * stays applied until reboot: the mainline Rockchip IOMMU driver can't unbind,
 * so its devices must not go away.
 */

#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/of.h>
#include <linux/printk.h>
#include <linux/slab.h>

#include "rk3588_mpp_dt.h"

void vsi_iommu_dep(void);

extern const u8 mpp_dtbo_begin[];
extern const u8 mpp_dtbo_end[];

struct mpp_symbol {
	const char *label;
	const char *compatible;
	const char *path;
};

static const struct mpp_symbol mpp_symbols[] = {
	{ .label = "cru", .compatible = "rockchip,rk3588-cru" },
	{ .label = "power", .compatible = "rockchip,rk3588-power-controller" },
	{ .label = "vpu121_mmu", .path = "/iommu@fdb50800" },
};

static int mpp_add_symbols(void)
{
	struct device_node *symbols, *np;
	struct of_changeset *ocs;
	const char *path;
	int i, ret;

	ocs = kzalloc(sizeof(*ocs), GFP_KERNEL);
	if (!ocs)
		return -ENOMEM;
	of_changeset_init(ocs);

	symbols = of_find_node_by_path("/__symbols__");
	if (!symbols) {
		symbols = of_changeset_create_node(ocs, of_root, "__symbols__");
		if (!symbols) {
			ret = -ENOMEM;
			goto err;
		}
		/* a node under / gets a platform device unless it's marked done */
		of_node_set_flag(symbols, OF_POPULATED);
		of_node_get(symbols);
	}

	for (i = 0; i < ARRAY_SIZE(mpp_symbols); i++) {
		const struct mpp_symbol *sym = &mpp_symbols[i];

		if (of_property_present(symbols, sym->label))
			continue;

		if (sym->compatible)
			np = of_find_compatible_node(NULL, NULL, sym->compatible);
		else
			np = of_find_node_by_path(sym->path);
		if (!np || !np->phandle) {
			pr_err("rk3588-mpp-dt: no %s node with a phandle in the device tree\n",
			       sym->label);
			of_node_put(np);
			ret = -ENODEV;
			goto err_put;
		}

		path = kasprintf(GFP_KERNEL, "%pOF", np);
		of_node_put(np);
		if (!path) {
			ret = -ENOMEM;
			goto err_put;
		}
		ret = of_changeset_add_prop_string(ocs, symbols, sym->label, path);
		kfree(path);
		if (ret)
			goto err_put;
	}
	of_node_put(symbols);

	/* leaked on purpose: the symbols stay as long as the overlay does */
	ret = of_changeset_apply(ocs);
	if (ret)
		goto err;
	return 0;

err_put:
	of_node_put(symbols);
err:
	of_changeset_destroy(ocs);
	kfree(ocs);
	return ret;
}

static int __init rk3588_mpp_dt_init(void)
{
	struct device_node *np;
	int ovcs_id = 0;
	int ret;

	if (!of_machine_is_compatible("rockchip,rk3588") &&
	    !of_machine_is_compatible("rockchip,rk3588s"))
		return -ENODEV;

	vsi_iommu_dep();

	/* applied by an earlier load since boot, or the DT already has them */
	np = of_find_compatible_node(NULL, NULL, "rockchip,mpp-service");
	if (np) {
		of_node_put(np);
		return 0;
	}

	ret = mpp_add_symbols();
	if (ret)
		return ret;

	ret = of_overlay_fdt_apply(mpp_dtbo_begin, mpp_dtbo_end - mpp_dtbo_begin,
				   &ovcs_id, NULL);
	if (ret) {
		pr_err("rk3588-mpp-dt: failed to apply the device tree overlay: %d\n", ret);
		if (ovcs_id)
			of_overlay_remove(&ovcs_id);
		return ret;
	}

	pr_info("rk3588-mpp-dt: applied the RK3588 device tree overlay\n");
	return 0;
}
module_init(rk3588_mpp_dt_init);

/* nothing to undo: the overlay stays until reboot, see above */
static void __exit rk3588_mpp_dt_exit(void)
{
}
module_exit(rk3588_mpp_dt_exit);

void rk3588_mpp_dt_ready(void)
{
}
EXPORT_SYMBOL_GPL(rk3588_mpp_dt_ready);

MODULE_LICENSE("Dual MIT/GPL");
MODULE_DESCRIPTION("RK3588 MPP, RGA and AV1 device tree nodes for mainline kernels");
