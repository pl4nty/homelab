/* SPDX-License-Identifier: GPL-2.0 */
/* Force-included after <linux/kconfig.h>: the Kconfig this driver would get in-tree. */
#ifndef __RGA_CONFIG_H
#define __RGA_CONFIG_H

#define CONFIG_ROCKCHIP_MULTI_RGA 1
#define CONFIG_ROCKCHIP_RGA_ASYNC 1
/* not an Android GKI kernel: the driver may close fence fds itself */
#define CONFIG_NO_GKI 1

#endif
