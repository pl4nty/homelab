/* SPDX-License-Identifier: GPL-2.0 */
/*
 * Shadows mainline <soc/rockchip/pm_domains.h>: mainline only exports
 * rockchip_pmu_block/unblock. The vendor per-device helpers have no mainline
 * equivalent; the MPP nodes set rockchip,skip-pmu-idle-request and power is
 * managed through runtime PM on the genpd instead.
 */
#ifndef __SOC_ROCKCHIP_PM_DOMAINS_H__
#define __SOC_ROCKCHIP_PM_DOMAINS_H__

#include <linux/device.h>

#ifdef CONFIG_ROCKCHIP_PM_DOMAINS
int rockchip_pmu_block(void);
void rockchip_pmu_unblock(void);
#else
static inline int rockchip_pmu_block(void) { return 0; }
static inline void rockchip_pmu_unblock(void) { }
#endif

static inline int rockchip_pmu_pd_on(struct device *dev) { return 0; }
static inline int rockchip_pmu_pd_off(struct device *dev) { return 0; }
static inline bool rockchip_pmu_pd_is_on(struct device *dev) { return true; }
static inline int rockchip_pmu_idle_request(struct device *dev, bool idle) { return 0; }
static inline int rockchip_save_qos(struct device *dev) { return 0; }
static inline int rockchip_restore_qos(struct device *dev) { return 0; }
static inline void rockchip_dump_pmu(void) { }
static inline void rockchip_pd_disable_unused(void) { }

#endif /* __SOC_ROCKCHIP_PM_DOMAINS_H__ */
