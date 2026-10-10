/**
 * 批注存储：按条目分组的 JSON，另存一份 index 便于按 id 快速定位。
 * 批注绝不因文件变化而删除，只可能被标记 needsReview。
 */
import type { Annotation } from '../shared/types';
import { JsonFile } from './store';
import { shortId } from './paths';

interface AnnotationData {
  version: number;
  byItem: Record<string, Annotation[]>;
  savedAt: number;
}

export class AnnotationStore {
  private file: JsonFile<AnnotationData>;
  private byItem = new Map<string, Annotation[]>();
  private byId = new Map<string, string>();
  private dirtyCounts = new Set<string>();

  constructor(dataFile: string) {
    this.file = new JsonFile<AnnotationData>({
      file: dataFile,
      defaults: () => ({ version: 1, byItem: {}, savedAt: Date.now() }),
      revive: (raw) => {
        const data = raw as Partial<AnnotationData>;
        if (!data || typeof data !== 'object' || typeof data.byItem !== 'object' || data.byItem === null) return null;
        return { version: 1, byItem: data.byItem as Record<string, Annotation[]>, savedAt: data.savedAt ?? Date.now() };
      },
      debounceMs: 600,
    });
  }

  async load(): Promise<void> {
    const data = await this.file.load();
    this.byItem.clear();
    this.byId.clear();
    for (const [itemId, list] of Object.entries(data.byItem)) {
      const clean = (Array.isArray(list) ? list : []).map((a) => normalizeAnnotation(a, itemId));
      this.byItem.set(itemId, clean);
      for (const a of clean) this.byId.set(a.id, itemId);
    }
  }

  list(itemId: string): Annotation[] {
    return (this.byItem.get(itemId) ?? []).map((a) => ({ ...a }));
  }

  all(): Annotation[] {
    const out: Annotation[] = [];
    for (const list of this.byItem.values()) for (const a of list) out.push({ ...a });
    return out;
  }

  count(itemId: string): number {
    return this.byItem.get(itemId)?.length ?? 0;
  }

  counts(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [itemId, list] of this.byItem) if (list.length) map.set(itemId, list.length);
    return map;
  }

  get(id: string): Annotation | null {
    const itemId = this.byId.get(id);
    if (!itemId) return null;
    const found = this.byItem.get(itemId)?.find((a) => a.id === id);
    return found ? { ...found } : null;
  }

  add(input: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'reanchored' | 'needsReview'> & { id?: string }): Annotation {
    const now = Date.now();
    const annotation: Annotation = {
      ...input,
      id: input.id ?? shortId('an_'),
      reanchored: false,
      needsReview: false,
      createdAt: now,
      updatedAt: now,
    };
    const list = this.byItem.get(annotation.itemId) ?? [];
    list.push(annotation);
    list.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    this.byItem.set(annotation.itemId, list);
    this.byId.set(annotation.id, annotation.itemId);
    this.dirtyCounts.add(annotation.itemId);
    this.persist();
    return { ...annotation };
  }

  update(id: string, patch: Partial<Annotation>): Annotation | null {
    const itemId = this.byId.get(id);
    if (!itemId) return null;
    const list = this.byItem.get(itemId) ?? [];
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return null;
    const next: Annotation = { ...list[idx], ...patch, id, itemId, updatedAt: Date.now() };
    list[idx] = next;
    list.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    this.dirtyCounts.add(itemId);
    this.persist();
    return { ...next };
  }

  /** 批量替换某条目的批注（重定位后回写） */
  replaceForItem(itemId: string, list: Annotation[]): void {
    const clean = list.map((a) => ({ ...a, itemId }));
    this.byItem.set(itemId, clean);
    for (const a of clean) this.byId.set(a.id, itemId);
    this.dirtyCounts.add(itemId);
    this.persist();
  }

  remove(id: string): string | null {
    const itemId = this.byId.get(id);
    if (!itemId) return null;
    const list = this.byItem.get(itemId) ?? [];
    const next = list.filter((a) => a.id !== id);
    if (next.length) this.byItem.set(itemId, next);
    else this.byItem.delete(itemId);
    this.byId.delete(id);
    this.dirtyCounts.add(itemId);
    this.persist();
    return itemId;
  }

  removeForItem(itemId: string): void {
    const list = this.byItem.get(itemId) ?? [];
    for (const a of list) this.byId.delete(a.id);
    this.byItem.delete(itemId);
    this.dirtyCounts.add(itemId);
    this.persist();
  }

  takeDirtyCounts(): string[] {
    const out = [...this.dirtyCounts];
    this.dirtyCounts.clear();
    return out;
  }

  persist(): void {
    this.file.set({ version: 1, byItem: Object.fromEntries(this.byItem), savedAt: Date.now() });
  }

  async flush(): Promise<void> {
    this.persist();
    await this.file.flushNow();
  }
}

function normalizeAnnotation(raw: Annotation, itemId: string): Annotation {
  return {
    ...raw,
    itemId: raw.itemId ?? itemId,
    rects: Array.isArray(raw.rects) ? raw.rects : [],
    anchor: raw.anchor ?? { prefix: '', suffix: '', occurrence: 1 },
    comment: raw.comment ?? '',
    color: raw.color ?? 'yellow',
    text: raw.text ?? '',
    page: raw.page ?? 1,
    reanchored: raw.reanchored ?? false,
    needsReview: raw.needsReview ?? false,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}
