/* SPDX-License-Identifier: GPL-2.0 */
/* Force-included after <linux/kconfig.h>: the Kconfig this driver would get in-tree. */
#ifndef __MPP_CONFIG_H
#define __MPP_CONFIG_H

#define CONFIG_ROCKCHIP_MPP_SERVICE 1
#define CONFIG_ROCKCHIP_MPP_PROC_FS 1
#define CONFIG_ROCKCHIP_MPP_RKVDEC2 1
#define CONFIG_ROCKCHIP_MPP_RKVENC2 1
#define CONFIG_ROCKCHIP_MPP_VDPU2 1
#define CONFIG_ROCKCHIP_MPP_VEPU2 1
#define CONFIG_ROCKCHIP_MPP_JPGDEC 1
#define CONFIG_ROCKCHIP_MPP_IEP2 1
#define CONFIG_ROCKCHIP_MPP_AV1DEC 1

/*
 * The encoder/decoder DVFS hooks are built on the vendor OPP, IPA and system
 * monitor frameworks, which mainline lacks; run at the fixed rates from DT.
 */
#undef CONFIG_PM_DEVFREQ

#endif
