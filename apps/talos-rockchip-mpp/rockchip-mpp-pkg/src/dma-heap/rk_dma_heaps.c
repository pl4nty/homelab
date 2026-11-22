// SPDX-License-Identifier: GPL-2.0
/*
 * The system-uncached, system-uncached-dma32 and system-dma32 DMA-BUF heaps of
 * the Rockchip BSP kernel, which mainline doesn't have. Userspace MPP uses DMA
 * heaps only when all four system heaps exist, and it never syncs a buffer
 * from an uncached heap, so these must really be uncached.
 *
 * Based on the mainline system heap (drivers/dma-buf/heaps/system_heap.c).
 * Uncached buffers are flushed from the CPU caches once, when they are
 * allocated, and mapped write-combined to the CPU. DMA32 buffers come from
 * the DMA32 zone.
 */

#include <linux/device/faux.h>
#include <linux/dma-buf.h>
#include <linux/dma-mapping.h>
#include <linux/dma-heap.h>
#include <linux/err.h>
#include <linux/highmem.h>
#include <linux/mm.h>
#include <linux/module.h>
#include <linux/scatterlist.h>
#include <linux/slab.h>
#include <linux/vmalloc.h>

struct rk_heap {
	const char *name;
	gfp_t gfp;
	bool uncached;
};

struct rk_heap_buffer {
	struct dma_heap *heap;
	struct list_head attachments;
	struct mutex lock;
	unsigned long len;
	struct sg_table sg_table;
	int vmap_cnt;
	void *vaddr;
	bool uncached;
};

struct rk_heap_attachment {
	struct device *dev;
	struct sg_table table;
	struct list_head list;
	bool mapped;
};

static struct rk_heap rk_heaps[] = {
	{ "system-uncached", GFP_HIGHUSER, true },
	{ "system-uncached-dma32", GFP_USER | GFP_DMA32, true },
	{ "system-dma32", GFP_USER | GFP_DMA32, false },
};

static struct faux_device *rk_heap_fdev;

#define HIGH_ORDER_GFP(gfp) ((((gfp) | __GFP_ZERO | __GFP_NOWARN | __GFP_NORETRY) & \
			      ~__GFP_RECLAIM) | __GFP_COMP)
#define LOW_ORDER_GFP(gfp) ((gfp) | __GFP_ZERO)

static const unsigned int orders[] = {8, 4, 0};
#define NUM_ORDERS ARRAY_SIZE(orders)

static int dup_sg_table(struct sg_table *from, struct sg_table *to)
{
	struct scatterlist *sg, *new_sg;
	int ret, i;

	ret = sg_alloc_table(to, from->orig_nents, GFP_KERNEL);
	if (ret)
		return ret;

	new_sg = to->sgl;
	for_each_sgtable_sg(from, sg, i) {
		sg_set_page(new_sg, sg_page(sg), sg->length, sg->offset);
		new_sg = sg_next(new_sg);
	}

	return 0;
}

static int rk_heap_attach(struct dma_buf *dmabuf,
			  struct dma_buf_attachment *attachment)
{
	struct rk_heap_buffer *buffer = dmabuf->priv;
	struct rk_heap_attachment *a;
	int ret;

	a = kzalloc(sizeof(*a), GFP_KERNEL);
	if (!a)
		return -ENOMEM;

	ret = dup_sg_table(&buffer->sg_table, &a->table);
	if (ret) {
		kfree(a);
		return ret;
	}

	a->dev = attachment->dev;
	INIT_LIST_HEAD(&a->list);
	a->mapped = false;

	attachment->priv = a;

	mutex_lock(&buffer->lock);
	list_add(&a->list, &buffer->attachments);
	mutex_unlock(&buffer->lock);

	return 0;
}

static void rk_heap_detach(struct dma_buf *dmabuf,
			   struct dma_buf_attachment *attachment)
{
	struct rk_heap_buffer *buffer = dmabuf->priv;
	struct rk_heap_attachment *a = attachment->priv;

	mutex_lock(&buffer->lock);
	list_del(&a->list);
	mutex_unlock(&buffer->lock);

	sg_free_table(&a->table);
	kfree(a);
}

static struct sg_table *rk_heap_map_dma_buf(struct dma_buf_attachment *attachment,
					    enum dma_data_direction direction)
{
	struct rk_heap_buffer *buffer = attachment->dmabuf->priv;
	struct rk_heap_attachment *a = attachment->priv;
	struct sg_table *table = &a->table;
	unsigned long attrs = buffer->uncached ? DMA_ATTR_SKIP_CPU_SYNC : 0;
	int ret;

	ret = dma_map_sgtable(attachment->dev, table, direction, attrs);
	if (ret)
		return ERR_PTR(ret);

	a->mapped = true;
	return table;
}

static void rk_heap_unmap_dma_buf(struct dma_buf_attachment *attachment,
				  struct sg_table *table,
				  enum dma_data_direction direction)
{
	struct rk_heap_buffer *buffer = attachment->dmabuf->priv;
	struct rk_heap_attachment *a = attachment->priv;
	unsigned long attrs = buffer->uncached ? DMA_ATTR_SKIP_CPU_SYNC : 0;

	a->mapped = false;
	dma_unmap_sgtable(attachment->dev, table, direction, attrs);
}

static int rk_heap_dma_buf_begin_cpu_access(struct dma_buf *dmabuf,
					    enum dma_data_direction direction)
{
	struct rk_heap_buffer *buffer = dmabuf->priv;
	struct rk_heap_attachment *a;

	if (buffer->uncached)
		return 0;

	mutex_lock(&buffer->lock);

	if (buffer->vmap_cnt)
		invalidate_kernel_vmap_range(buffer->vaddr, buffer->len);

	list_for_each_entry(a, &buffer->attachments, list) {
		if (!a->mapped)
			continue;
		dma_sync_sgtable_for_cpu(a->dev, &a->table, direction);
	}
	mutex_unlock(&buffer->lock);

	return 0;
}

static int rk_heap_dma_buf_end_cpu_access(struct dma_buf *dmabuf,
					  enum dma_data_direction direction)
{
	struct rk_heap_buffer *buffer = dmabuf->priv;
	struct rk_heap_attachment *a;

	if (buffer->uncached)
		return 0;

	mutex_lock(&buffer->lock);

	if (buffer->vmap_cnt)
		flush_kernel_vmap_range(buffer->vaddr, buffer->len);

	list_for_each_entry(a, &buffer->attachments, list) {
		if (!a->mapped)
			continue;
		dma_sync_sgtable_for_device(a->dev, &a->table, direction);
	}
	mutex_unlock(&buffer->lock);

	return 0;
}

static int rk_heap_mmap(struct dma_buf *dmabuf, struct vm_area_struct *vma)
{
	struct rk_heap_buffer *buffer = dmabuf->priv;
	struct sg_table *table = &buffer->sg_table;
	unsigned long addr = vma->vm_start;
	struct sg_page_iter piter;
	int ret;

	if (buffer->uncached)
		vma->vm_page_prot = pgprot_writecombine(vma->vm_page_prot);

	for_each_sgtable_page(table, &piter, vma->vm_pgoff) {
		struct page *page = sg_page_iter_page(&piter);

		ret = remap_pfn_range(vma, addr, page_to_pfn(page), PAGE_SIZE,
				      vma->vm_page_prot);
		if (ret)
			return ret;
		addr += PAGE_SIZE;
		if (addr >= vma->vm_end)
			return 0;
	}
	return 0;
}

static void *rk_heap_do_vmap(struct rk_heap_buffer *buffer)
{
	struct sg_table *table = &buffer->sg_table;
	int npages = PAGE_ALIGN(buffer->len) / PAGE_SIZE;
	struct page **pages = vmalloc(sizeof(struct page *) * npages);
	struct page **tmp = pages;
	struct sg_page_iter piter;
	pgprot_t pgprot = PAGE_KERNEL;
	void *vaddr;

	if (!pages)
		return ERR_PTR(-ENOMEM);

	if (buffer->uncached)
		pgprot = pgprot_writecombine(PAGE_KERNEL);

	for_each_sgtable_page(table, &piter, 0) {
		WARN_ON(tmp - pages >= npages);
		*tmp++ = sg_page_iter_page(&piter);
	}

	vaddr = vmap(pages, npages, VM_MAP, pgprot);
	vfree(pages);

	if (!vaddr)
		return ERR_PTR(-ENOMEM);

	return vaddr;
}

static int rk_heap_vmap(struct dma_buf *dmabuf, struct iosys_map *map)
{
	struct rk_heap_buffer *buffer = dmabuf->priv;
	void *vaddr;
	int ret = 0;

	mutex_lock(&buffer->lock);
	if (buffer->vmap_cnt) {
		buffer->vmap_cnt++;
		iosys_map_set_vaddr(map, buffer->vaddr);
		goto out;
	}

	vaddr = rk_heap_do_vmap(buffer);
	if (IS_ERR(vaddr)) {
		ret = PTR_ERR(vaddr);
		goto out;
	}

	buffer->vaddr = vaddr;
	buffer->vmap_cnt++;
	iosys_map_set_vaddr(map, buffer->vaddr);
out:
	mutex_unlock(&buffer->lock);

	return ret;
}

static void rk_heap_vunmap(struct dma_buf *dmabuf, struct iosys_map *map)
{
	struct rk_heap_buffer *buffer = dmabuf->priv;

	mutex_lock(&buffer->lock);
	if (!--buffer->vmap_cnt) {
		vunmap(buffer->vaddr);
		buffer->vaddr = NULL;
	}
	mutex_unlock(&buffer->lock);
	iosys_map_clear(map);
}

static void rk_heap_dma_buf_release(struct dma_buf *dmabuf)
{
	struct rk_heap_buffer *buffer = dmabuf->priv;
	struct sg_table *table;
	struct scatterlist *sg;
	int i;

	table = &buffer->sg_table;
	for_each_sgtable_sg(table, sg, i) {
		struct page *page = sg_page(sg);

		__free_pages(page, compound_order(page));
	}
	sg_free_table(table);
	kfree(buffer);
}

static const struct dma_buf_ops rk_heap_buf_ops = {
	.attach = rk_heap_attach,
	.detach = rk_heap_detach,
	.map_dma_buf = rk_heap_map_dma_buf,
	.unmap_dma_buf = rk_heap_unmap_dma_buf,
	.begin_cpu_access = rk_heap_dma_buf_begin_cpu_access,
	.end_cpu_access = rk_heap_dma_buf_end_cpu_access,
	.mmap = rk_heap_mmap,
	.vmap = rk_heap_vmap,
	.vunmap = rk_heap_vunmap,
	.release = rk_heap_dma_buf_release,
};

static struct page *alloc_largest_available(gfp_t gfp, unsigned long size,
					    unsigned int max_order)
{
	struct page *page;
	int i;

	for (i = 0; i < NUM_ORDERS; i++) {
		if (size <  (PAGE_SIZE << orders[i]))
			continue;
		if (max_order < orders[i])
			continue;

		page = alloc_pages(orders[i] ? HIGH_ORDER_GFP(gfp) : LOW_ORDER_GFP(gfp),
				   orders[i]);
		if (!page)
			continue;
		return page;
	}
	return NULL;
}

static struct dma_buf *rk_heap_allocate(struct dma_heap *heap,
					unsigned long len,
					u32 fd_flags,
					u64 heap_flags)
{
	struct rk_heap *info = dma_heap_get_drvdata(heap);
	struct device *dev = &rk_heap_fdev->dev;
	struct rk_heap_buffer *buffer;
	DEFINE_DMA_BUF_EXPORT_INFO(exp_info);
	unsigned long size_remaining = len;
	unsigned int max_order = orders[0];
	struct dma_buf *dmabuf;
	struct sg_table *table;
	struct scatterlist *sg;
	struct list_head pages;
	struct page *page, *tmp_page;
	int i, ret = -ENOMEM;

	buffer = kzalloc(sizeof(*buffer), GFP_KERNEL);
	if (!buffer)
		return ERR_PTR(-ENOMEM);

	INIT_LIST_HEAD(&buffer->attachments);
	mutex_init(&buffer->lock);
	buffer->heap = heap;
	buffer->len = len;
	buffer->uncached = info->uncached;

	INIT_LIST_HEAD(&pages);
	i = 0;
	while (size_remaining > 0) {
		if (fatal_signal_pending(current)) {
			ret = -EINTR;
			goto free_buffer;
		}

		page = alloc_largest_available(info->gfp, size_remaining, max_order);
		if (!page)
			goto free_buffer;

		list_add_tail(&page->lru, &pages);
		size_remaining -= page_size(page);
		max_order = compound_order(page);
		i++;
	}

	table = &buffer->sg_table;
	if (sg_alloc_table(table, i, GFP_KERNEL))
		goto free_buffer;

	sg = table->sgl;
	list_for_each_entry_safe(page, tmp_page, &pages, lru) {
		sg_set_page(sg, page, page_size(page), 0);
		sg = sg_next(sg);
		list_del(&page->lru);
	}

	if (buffer->uncached) {
		ret = dma_map_sgtable(dev, table, DMA_BIDIRECTIONAL, 0);
		if (ret)
			goto free_pages;
		dma_unmap_sgtable(dev, table, DMA_BIDIRECTIONAL, 0);
	}

	exp_info.exp_name = dma_heap_get_name(heap);
	exp_info.ops = &rk_heap_buf_ops;
	exp_info.size = buffer->len;
	exp_info.flags = fd_flags;
	exp_info.priv = buffer;
	dmabuf = dma_buf_export(&exp_info);
	if (IS_ERR(dmabuf)) {
		ret = PTR_ERR(dmabuf);
		goto free_pages;
	}
	return dmabuf;

free_pages:
	for_each_sgtable_sg(table, sg, i) {
		struct page *p = sg_page(sg);

		__free_pages(p, compound_order(p));
	}
	sg_free_table(table);
free_buffer:
	list_for_each_entry_safe(page, tmp_page, &pages, lru)
		__free_pages(page, compound_order(page));
	kfree(buffer);

	return ERR_PTR(ret);
}

static const struct dma_heap_ops rk_heap_ops = {
	.allocate = rk_heap_allocate,
};

static int __init rk_dma_heaps_init(void)
{
	struct dma_heap_export_info exp_info;
	struct dma_heap *heap;
	int i, ret;

	rk_heap_fdev = faux_device_create("rk_dma_heaps", NULL, NULL);
	if (!rk_heap_fdev)
		return -ENODEV;
	ret = dma_coerce_mask_and_coherent(&rk_heap_fdev->dev, DMA_BIT_MASK(64));
	if (ret)
		return ret;

	for (i = 0; i < ARRAY_SIZE(rk_heaps); i++) {
		exp_info.name = rk_heaps[i].name;
		exp_info.ops = &rk_heap_ops;
		exp_info.priv = &rk_heaps[i];

		heap = dma_heap_add(&exp_info);
		if (IS_ERR(heap))
			return PTR_ERR(heap);
	}

	return 0;
}
module_init(rk_dma_heaps_init);

void rk_dma_heaps_dep(void);
void rk_dma_heaps_dep(void)
{
}
EXPORT_SYMBOL_GPL(rk_dma_heaps_dep);

MODULE_IMPORT_NS("DMA_BUF");
MODULE_IMPORT_NS("DMA_BUF_HEAP");
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("Rockchip BSP system-uncached, system-uncached-dma32 and system-dma32 DMA-BUF heaps");
